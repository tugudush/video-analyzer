import { GoogleGenAI } from '@google/genai'
import type { Config } from '../config.js'
import { requireGeminiApiKey } from '../config.js'
import { isAbortError, runWithBounds } from '../utils/abort.js'
import { VideoAnalyzerError } from '../utils/errors.js'
import type { Logger } from '../utils/logger.js'

/**
 * Thin wrapper over the Google GenAI SDK.
 *
 * Keeping the SDK behind this interface means the upload/poll/reuse pipeline can
 * be unit tested without network access or credentials.
 */

export interface GeminiFileHandle {
  name: string
  uri: string
  mimeType: string
  state: string
  expirationTime?: string
}

export type GeminiPart =
  | { kind: 'text'; text: string }
  | { kind: 'file'; fileUri: string; mimeType: string }
  | { kind: 'inlineImage'; data: string; mimeType: string }

/** Cancellation and deadline applied to a single Gemini network call. */
export interface GeminiRequestOptions {
  /** Aborts the call when the caller gives up. */
  signal?: AbortSignal
  /** Upper bound for this call, in milliseconds. */
  timeoutMs?: number
}

export interface GeminiApi {
  uploadFile(
    params: { path: string; mimeType?: string } & GeminiRequestOptions,
  ): Promise<GeminiFileHandle>
  getFile(name: string, options?: GeminiRequestOptions): Promise<GeminiFileHandle>
  generateContent(
    params: {
      model: string
      parts: GeminiPart[]
      systemInstruction?: string
      temperature?: number
    } & GeminiRequestOptions,
  ): Promise<string>
}

/**
 * Translate request bounds into SDK config so the underlying HTTP call is
 * cancelled and timed out instead of merely being abandoned by the caller.
 */
function sdkRequestConfig(options: GeminiRequestOptions): {
  abortSignal?: AbortSignal
  httpOptions?: { timeout: number }
} {
  return {
    ...(options.signal ? { abortSignal: options.signal } : {}),
    ...(options.timeoutMs !== undefined && options.timeoutMs > 0
      ? { httpOptions: { timeout: options.timeoutMs } }
      : {}),
  }
}

function normalizeHandle(file: {
  name?: string
  uri?: string
  mimeType?: string
  state?: string
  expirationTime?: string
}): GeminiFileHandle {
  return {
    name: file.name ?? '',
    uri: file.uri ?? '',
    mimeType: file.mimeType ?? 'application/octet-stream',
    state: file.state ?? 'STATE_UNSPECIFIED',
    ...(file.expirationTime ? { expirationTime: file.expirationTime } : {}),
  }
}

/** Real SDK-backed implementation. */
export class GoogleGenAiApi implements GeminiApi {
  private readonly client: GoogleGenAI

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey })
  }

  async uploadFile(
    params: { path: string; mimeType?: string } & GeminiRequestOptions,
  ): Promise<GeminiFileHandle> {
    const config = {
      ...(params.mimeType ? { mimeType: params.mimeType } : {}),
      ...sdkRequestConfig(params),
    }
    const uploaded = await this.client.files.upload({
      file: params.path,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    })
    return normalizeHandle(uploaded as Parameters<typeof normalizeHandle>[0])
  }

  async getFile(name: string, options: GeminiRequestOptions = {}): Promise<GeminiFileHandle> {
    const config = sdkRequestConfig(options)
    const file = await this.client.files.get({
      name,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    })
    return normalizeHandle(file as Parameters<typeof normalizeHandle>[0])
  }

  async generateContent(
    params: {
      model: string
      parts: GeminiPart[]
      systemInstruction?: string
      temperature?: number
    } & GeminiRequestOptions,
  ): Promise<string> {
    const parts = params.parts.map((part) => {
      if (part.kind === 'text') return { text: part.text }
      if (part.kind === 'file') {
        return { fileData: { fileUri: part.fileUri, mimeType: part.mimeType } }
      }
      return { inlineData: { data: part.data, mimeType: part.mimeType } }
    })

    const config = {
      ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...sdkRequestConfig(params),
    }

    const response = await this.client.models.generateContent({
      model: params.model,
      contents: [{ role: 'user', parts }],
      ...(Object.keys(config).length > 0 ? { config } : {}),
    })

    const text = response.text
    if (!text) {
      throw new VideoAnalyzerError('GEMINI_REQUEST_FAILED', 'Gemini returned an empty response.', {
        hint: 'The prompt may have been blocked by safety filters, or the response was truncated.',
      })
    }
    return text
  }
}

/**
 * Build the SDK-backed API from configuration.
 *
 * Construction is lazy so local-only operations never touch the Gemini client.
 */
export function createGeminiApi(config: Config): GoogleGenAiApi {
  return new GoogleGenAiApi(requireGeminiApiKey(config))
}

interface CachedUpload {
  handle: GeminiFileHandle
  sizeBytes: number
  mtimeMs: number
  expiresAtMs: number
}

export interface GeminiServiceOptions {
  config: Config
  logger: Logger
  api?: GeminiApi
  /** Max cached uploads kept in memory. */
  cacheSize?: number
  /** Injectable clock for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface EnsureUploadedParams {
  path: string
  mimeType: string
  sizeBytes: number
  mtimeMs: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

const DEFAULT_CACHE_EXPIRY_MS = 47 * 60 * 60 * 1000 // Gemini files live ~48h

/** Setting that caps every individual Gemini call. */
const REQUEST_TIMEOUT_ENV = 'VIDEO_ANALYZER_REQUEST_TIMEOUT_MS'

/** Setting that bounds the upload plus the wait for `ACTIVE`. */
const UPLOAD_TIMEOUT_ENV = 'VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS'

/**
 * Raised when a single Gemini network call exceeds its own deadline.
 *
 * `variable` is the setting that actually bounded the call: the request timeout
 * always applies, but an upload or a status poll can be cut short by what is
 * left of the upload budget, and naming the wrong setting sends the user in
 * circles.
 */
function requestTimeout(
  stage: string,
  timeoutMs: number,
  variable: string = REQUEST_TIMEOUT_ENV,
): VideoAnalyzerError {
  return new VideoAnalyzerError(
    'GEMINI_TIMEOUT',
    `Gemini did not respond within ${timeoutMs} ms (${stage}).`,
    {
      hint: `Raise ${variable} for slow networks, large media, or long processing.`,
      details: { stage, timeoutMs, variable },
    },
  )
}

/** Raised when the caller cancels the operation. */
function requestCancelled(): VideoAnalyzerError {
  return new VideoAnalyzerError('GEMINI_TIMEOUT', 'The Gemini request was cancelled.', {
    hint: 'The caller cancelled the operation before Gemini answered.',
  })
}

/**
 * Shared Gemini media pipeline: one upload → poll → reuse implementation used by
 * every Gemini-backed operation.
 */
export class GeminiMediaService {
  private readonly api: GeminiApi
  private readonly config: Config
  private readonly logger: Logger
  private readonly cacheSize: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly cache = new Map<string, CachedUpload>()
  private readonly inFlight = new Map<string, Promise<GeminiFileHandle>>()

  constructor(options: GeminiServiceOptions) {
    this.config = options.config
    this.logger = options.logger
    this.api = options.api ?? createGeminiApi(options.config)
    this.cacheSize = options.cacheSize ?? 32
    this.now = options.now ?? (() => Date.now())
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  get model(): string {
    return this.config.geminiModel
  }

  private cacheKey(params: EnsureUploadedParams): string {
    return `${params.path}\u0000${params.sizeBytes}\u0000${Math.round(params.mtimeMs)}`
  }

  /** Upload once per source file, coalescing concurrent callers. */
  async ensureUploaded(params: EnsureUploadedParams): Promise<GeminiFileHandle> {
    const key = this.cacheKey(params)
    const signal = params.signal
    if (signal?.aborted) throw requestCancelled()

    const cached = this.cache.get(key)
    if (cached && cached.expiresAtMs > this.now()) {
      const active = await this.checkActive(cached.handle.name, signal)
      if (active) {
        params.onProgress?.('Reusing previously uploaded Gemini file.')
        this.touch(key, cached)
        return active
      }
      this.cache.delete(key)
    }

    const existing = this.inFlight.get(key)
    if (existing) {
      params.onProgress?.('Waiting for an in-flight upload of the same file.')
      return this.waitUnlessCancelled(() => existing, signal)
    }

    // The upload is shared, so no single caller's signal may abort it: cancelling
    // ends that caller's wait, not work the other waiters depend on.
    const shared: EnsureUploadedParams = { ...params }
    delete shared.signal
    const promise = this.uploadAndWait(shared, key)
    this.inFlight.set(key, promise)
    const settle = () => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
    }
    void promise.then(settle, settle)
    return this.waitUnlessCancelled(() => promise, signal)
  }

  private touch(key: string, entry: CachedUpload): void {
    this.cache.delete(key)
    this.cache.set(key, entry)
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
  }

  private async checkActive(name: string, signal?: AbortSignal): Promise<GeminiFileHandle | null> {
    try {
      const file = await this.request(
        'file status',
        signal,
        this.config.requestTimeoutMs,
        REQUEST_TIMEOUT_ENV,
        (requestSignal, timeoutMs) => this.api.getFile(name, { signal: requestSignal, timeoutMs }),
      )
      return file.state === 'ACTIVE' ? file : null
    } catch (error) {
      // A timeout or cancellation is about this call, not about the cached file:
      // re-uploading would spend the budget again and hide the stall.
      if (error instanceof VideoAnalyzerError) throw error
      this.logger.debug(`Could not confirm the cached Gemini file: ${String(error)}`)
      return null
    }
  }

  private async uploadAndWait(
    params: EnsureUploadedParams,
    key: string,
  ): Promise<GeminiFileHandle> {
    // The deadline covers the upload itself as well as the wait for ACTIVE, so a
    // stalled upload cannot outlive the configured processing budget.
    const deadline = this.now() + this.config.uploadTimeoutMs

    params.onProgress?.('Uploading media to Gemini…')

    let uploaded: GeminiFileHandle
    try {
      uploaded = await this.request(
        'upload',
        params.signal,
        deadline - this.now(),
        UPLOAD_TIMEOUT_ENV,
        (signal, timeoutMs) =>
          this.api.uploadFile({ path: params.path, mimeType: params.mimeType, signal, timeoutMs }),
      )
    } catch (error) {
      if (error instanceof VideoAnalyzerError) throw error
      throw new VideoAnalyzerError('GEMINI_UPLOAD_FAILED', 'Gemini rejected the file upload.', {
        hint: 'Check the file size and format limits for your Gemini model and API tier.',
        cause: error,
      })
    }

    if (!uploaded.name) {
      throw new VideoAnalyzerError(
        'GEMINI_UPLOAD_FAILED',
        'Gemini did not return a file identifier for the upload.',
      )
    }

    const active = await this.waitForActive(uploaded, deadline, params)

    const expiresAtMs = active.expirationTime
      ? Date.parse(active.expirationTime)
      : this.now() + DEFAULT_CACHE_EXPIRY_MS

    this.touch(key, {
      handle: active,
      sizeBytes: params.sizeBytes,
      mtimeMs: params.mtimeMs,
      expiresAtMs: Number.isFinite(expiresAtMs)
        ? expiresAtMs
        : this.now() + DEFAULT_CACHE_EXPIRY_MS,
    })

    return active
  }

  private async waitForActive(
    uploaded: GeminiFileHandle,
    deadline: number,
    params: Pick<EnsureUploadedParams, 'signal' | 'onProgress'>,
  ): Promise<GeminiFileHandle> {
    let handle = uploaded
    let announced = false

    while (handle.state === 'PROCESSING' || handle.state === 'STATE_UNSPECIFIED') {
      if (!announced) {
        params.onProgress?.('Waiting for Gemini to process the media…')
        announced = true
      }

      const remaining = deadline - this.now()
      if (remaining <= 0) throw this.processingTimeout(handle.name)

      // Wake up at the poll interval or at the deadline, whichever comes first,
      // and stop waiting the moment the caller cancels.
      await this.waitUnlessCancelled(
        () => this.sleep(Math.min(this.config.pollIntervalMs, remaining)),
        params.signal,
      )

      if (this.now() >= deadline) throw this.processingTimeout(handle.name)

      const fileName = handle.name
      try {
        handle = await this.request(
          'file status',
          params.signal,
          deadline - this.now(),
          UPLOAD_TIMEOUT_ENV,
          (signal, timeoutMs) => this.api.getFile(fileName, { signal, timeoutMs }),
        )
      } catch (error) {
        if (error instanceof VideoAnalyzerError) throw error
        throw new VideoAnalyzerError(
          'GEMINI_PROCESSING_FAILED',
          'Could not read the Gemini file status.',
          { cause: error },
        )
      }
    }

    if (handle.state === 'FAILED') {
      throw new VideoAnalyzerError(
        'GEMINI_PROCESSING_FAILED',
        'Gemini failed to process the media.',
        {
          hint: 'The container or codec may be unsupported. Convert to MP4 (H.264/AAC) and retry.',
        },
      )
    }

    return handle
  }

  /** Run a prompt against an uploaded media file. */
  async generateWithFile(
    params: EnsureUploadedParams & {
      prompt: string
      systemInstruction?: string
      temperature?: number
    },
  ): Promise<string> {
    const handle = await this.ensureUploaded(params)
    return this.generate({
      parts: [
        { kind: 'file', fileUri: handle.uri, mimeType: handle.mimeType },
        { kind: 'text', text: params.prompt },
      ],
      ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    })
  }

  /** Run a prompt against inline images and/or text. */
  async generate(params: {
    parts: GeminiPart[]
    systemInstruction?: string
    temperature?: number
    signal?: AbortSignal
  }): Promise<string> {
    try {
      return await this.request(
        'generation',
        params.signal,
        this.config.requestTimeoutMs,
        REQUEST_TIMEOUT_ENV,
        (signal, timeoutMs) =>
          this.api.generateContent({
            model: this.config.geminiModel,
            parts: params.parts,
            ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
            ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
            signal,
            timeoutMs,
          }),
      )
    } catch (error) {
      if (error instanceof VideoAnalyzerError) throw error
      this.logger.debug(`Gemini request failed: ${String(error)}`)
      throw new VideoAnalyzerError('GEMINI_REQUEST_FAILED', 'Gemini request failed.', {
        hint: 'Check your API key, quota, and network access.',
        cause: error,
      })
    }
  }

  /**
   * Run one Gemini call with its own deadline and the caller's cancellation.
   *
   * The bound is both handed to the SDK and enforced here, because a request
   * that ignores the signal must still fail instead of hanging forever.
   * `budgetName` identifies the stage's own budget, so an expired deadline can
   * name the setting that actually applied.
   */
  private async request<T>(
    stage: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    budgetName: string,
    run: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
  ): Promise<T> {
    const budget = Math.max(1, Math.floor(timeoutMs))
    // The request timeout caps every call; a stage budget can only shorten it.
    const requestBound = budget >= this.config.requestTimeoutMs
    const effective = requestBound ? this.config.requestTimeoutMs : budget
    const variable = requestBound ? REQUEST_TIMEOUT_ENV : budgetName

    try {
      return await runWithBounds((requestSignal) => run(requestSignal, effective), {
        timeoutMs: effective,
        ...(signal ? { signal } : {}),
        onTimeout: () => requestTimeout(stage, effective, variable),
        onCancel: requestCancelled,
      })
    } catch (error) {
      // A client library may surface the abort itself; keep the public error stable.
      if (isAbortError(error)) {
        throw signal?.aborted ? requestCancelled() : requestTimeout(stage, effective, variable)
      }
      throw error
    }
  }

  /**
   * Await work that has no deadline of its own (a poll interval or a shared
   * upload) while still honouring the caller's cancellation.
   */
  private async waitUnlessCancelled<T>(
    work: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return runWithBounds(work, {
      timeoutMs: 0,
      ...(signal ? { signal } : {}),
      onTimeout: () => requestTimeout('poll', 0),
      onCancel: requestCancelled,
    })
  }

  private processingTimeout(fileName: string): VideoAnalyzerError {
    return new VideoAnalyzerError(
      'GEMINI_TIMEOUT',
      'Gemini did not finish processing the media in time.',
      {
        hint: 'Long videos can take several minutes. Raise VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS.',
        details: { fileName, timeoutMs: this.config.uploadTimeoutMs },
      },
    )
  }

  /** Test seam: drop all cached upload references. */
  clearCache(): void {
    this.cache.clear()
    this.inFlight.clear()
  }
}
