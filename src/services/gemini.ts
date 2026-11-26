import { AsyncLocalStorage } from 'node:async_hooks'
import { GoogleGenAI } from '@google/genai'
import type { Config } from '../config.js'
import { requireGeminiApiKey } from '../config.js'
import { clampTimerMs, isAbortError, runWithBounds } from '../utils/abort.js'
import { VideoAnalyzerError, operationCancelled } from '../utils/errors.js'
import type { Logger } from '../utils/logger.js'
import type { UploadReferenceStore } from './uploadCache.js'

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
  /**
   * A file reference. `mimeType` is omitted for a YouTube page URL, which the
   * provider resolves itself and rejects when given a MIME type.
   */
  | { kind: 'file'; fileUri: string; mimeType?: string }
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

function supportsSamplingTemperature(model: string): boolean {
  // Gemini 4 models fix temperature at 1.0 and Google's migration guide
  // recommends omitting sampling parameters from requests.
  return !/^(?:models\/)?gemini-4(?:$|-)/i.test(model.trim())
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

type SdkFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>

/**
 * The SDK's upload path drops `config.abortSignal`, so neither the initialization
 * request nor the chunk transfer would stop when the caller cancels. Each upload
 * runs inside this store and the fetch wrapper applies the bound signal to every
 * request the SDK makes on its behalf.
 */
const uploadSignals = new AsyncLocalStorage<AbortSignal>()

function withUploadSignal(base: SdkFetch): SdkFetch {
  return (input, init) => {
    const bound = uploadSignals.getStore()
    if (!bound) return base(input, init)
    const signal = init?.signal ? AbortSignal.any([bound, init.signal]) : bound
    return base(input, { ...init, signal })
  }
}

/**
 * One signal covering caller cancellation and the call deadline, with an unref'd
 * timer so a pending deadline cannot keep the process alive.
 */
function bindUpload(params: GeminiRequestOptions): { signal: AbortSignal; dispose(): void } {
  if (params.signal?.aborted) throw operationCancelled()

  const timeoutMs = params.timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline: AbortSignal | undefined
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const controller = new AbortController()
    timer = setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      clampTimerMs(timeoutMs),
    )
    timer.unref()
    deadline = controller.signal
  }

  const signal = params.signal
    ? deadline
      ? AbortSignal.any([params.signal, deadline])
      : params.signal
    : (deadline ?? new AbortController().signal)

  return {
    signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** Real SDK-backed implementation. */
export class GoogleGenAiApi implements GeminiApi {
  private readonly client: GoogleGenAI

  /**
   * `fetch` is a test seam. It is still wrapped, so an injected transport sees
   * the same cancellation behavior as the real one.
   */
  constructor(apiKey: string, options: { fetch?: SdkFetch } = {}) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { fetch: withUploadSignal(options.fetch ?? fetch) },
    })
  }

  async uploadFile(
    params: { path: string; mimeType?: string } & GeminiRequestOptions,
  ): Promise<GeminiFileHandle> {
    const bound = bindUpload(params)
    try {
      return await uploadSignals.run(bound.signal, async () => {
        // No request-level `httpOptions` here: the SDK replaces its required
        // resumable-upload defaults (empty API version and the `x-goog-upload-*`
        // headers) whenever one is supplied, which breaks the upload endpoint.
        // The bound signal enforces the deadline and cancellation instead.
        const uploaded = await this.client.files.upload({
          file: params.path,
          ...(params.mimeType ? { config: { mimeType: params.mimeType } } : {}),
        })
        return normalizeHandle(uploaded as Parameters<typeof normalizeHandle>[0])
      })
    } finally {
      bound.dispose()
    }
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
        return {
          fileData: {
            fileUri: part.fileUri,
            ...(part.mimeType ? { mimeType: part.mimeType } : {}),
          },
        }
      }
      return { inlineData: { data: part.data, mimeType: part.mimeType } }
    })

    const config = {
      ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
      ...(params.temperature !== undefined && supportsSamplingTemperature(params.model)
        ? { temperature: params.temperature }
        : {}),
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
    const finishReason = response.candidates?.[0]?.finishReason
    if (finishReason !== 'STOP') {
      throw new VideoAnalyzerError(
        'GEMINI_REQUEST_FAILED',
        'Gemini did not complete its response.',
        {
          hint: 'Retry with a shorter input or request. The partial response was not returned or saved.',
          details: { finishReason: finishReason ?? 'UNSPECIFIED' },
        },
      )
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
  expiresAtMs: number
}

interface InFlightUpload {
  promise: Promise<GeminiFileHandle>
  controller: AbortController
  waiters: number
  settled: boolean
}

export interface GeminiServiceOptions {
  config: Config
  logger: Logger
  api?: GeminiApi
  /** Max cached uploads kept in memory. */
  cacheSize?: number
  /** Injectable clock for tests. */
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Optional on-disk reference cache shared with other processes. */
  store?: UploadReferenceStore
}

export interface EnsureUploadedParams {
  path: string
  mimeType: string
  /**
   * Content identity for an immutable source. It must be derived from the
   * bytes — a path plus its size and mtime cannot identify contents, and the
   * cache never re-checks the file. Without a key the upload is neither cached
   * nor coalesced with another request.
   */
  cacheKey?: string
  retainSource?: () => () => Promise<void>
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

/**
 * Whether a `getFile` failure says the referenced file is gone.
 *
 * Only a definitive "no such file" may be read as a cache miss. Quota,
 * authentication, and transport failures say nothing about the reference, and
 * treating them as a miss would discard it and start another upload that is
 * likely to fail the same way — spending bandwidth and hiding the real cause.
 */
function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = (error as { status?: unknown }).status
  if (status === 404) return true
  const code = (error as { code?: unknown }).code
  if (code === 404 || code === 'NOT_FOUND') return true
  return /not[ _-]?found|no such file/i.test(error.message)
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
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly cache = new Map<string, CachedUpload>()
  private readonly inFlight = new Map<string, InFlightUpload>()
  private readonly store: UploadReferenceStore | undefined

  constructor(options: GeminiServiceOptions) {
    this.config = options.config
    this.logger = options.logger
    this.api = options.api ?? createGeminiApi(options.config)
    this.cacheSize = options.cacheSize ?? 32
    this.store = options.store
    this.now = options.now ?? (() => Date.now())
    this.sleep =
      options.sleep ??
      ((ms, signal) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(operationCancelled())
            return
          }
          const onAbort = () => {
            clearTimeout(timer)
            reject(operationCancelled())
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, clampTimerMs(ms))
          signal?.addEventListener('abort', onAbort, { once: true })
        }))
  }

  get model(): string {
    return this.config.geminiModel
  }

  /** Upload once per source file, coalescing concurrent callers. */
  async ensureUploaded(params: EnsureUploadedParams): Promise<GeminiFileHandle> {
    const signal = params.signal
    if (signal?.aborted) throw operationCancelled()

    // A mutable local path and its metadata cannot identify its contents.
    // Only callers with a stable content identity may reuse or share an upload.
    const key = params.cacheKey
    if (!key) return this.uploadAndWait(params)

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

    const persisted = await this.readPersisted(key, signal)
    if (persisted) {
      params.onProgress?.('Reusing a previously uploaded Gemini file.')
      this.touch(key, { handle: persisted.handle, expiresAtMs: persisted.expiresAtMs })
      return persisted.handle
    }

    let entry = this.inFlight.get(key)
    if (entry) {
      params.onProgress?.('Waiting for an in-flight upload of the same file.')
    } else {
      const release = params.retainSource?.()
      const controller = new AbortController()
      const shared = { ...params, signal: controller.signal }
      const promise = this.uploadAndWait(shared, key).finally(async () => {
        await release?.()
      })
      entry = { promise, controller, waiters: 0, settled: false }
      this.inFlight.set(key, entry)
      const current = entry
      const settle = () => {
        current.settled = true
        if (this.inFlight.get(key) === current) this.inFlight.delete(key)
      }
      void promise.then(settle, settle)
    }

    entry.waiters += 1
    try {
      return await this.waitUnlessCancelled(() => entry.promise, signal)
    } finally {
      entry.waiters -= 1
      if (entry.waiters === 0 && !entry.settled) {
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key)
        entry.controller.abort()
      }
    }
  }

  /**
   * Reuse a reference that survived this process.
   *
   * The stored file name is only a hint: the provider is asked for the file and
   * anything other than an `ACTIVE` file of the expected type is a miss. A
   * timeout, cancellation, or provider failure is rethrown rather than turned
   * into a miss, because re-uploading would spend the budget again and hide the
   * actual problem.
   */
  private async readPersisted(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ handle: GeminiFileHandle; expiresAtMs: number } | null> {
    if (!this.store) return null
    await this.store.ready
    const entry = this.store.get(key)
    if (!entry) return null

    const active = await this.checkActive(entry.fileName, signal)
    if (active && active.mimeType === entry.mimeType) {
      return { handle: active, expiresAtMs: entry.expiresAtMs }
    }

    if (active) {
      this.logger.debug(
        `Discarding cached upload ${entry.fileName}: MIME type ${active.mimeType} does not match ${entry.mimeType}.`,
      )
    }
    this.store.delete(key)
    return null
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
      // A provider error that does not say the file is gone leaves the
      // reference valid, so it is reported instead of being mistaken for a miss.
      if (isMissingFileError(error)) {
        this.logger.debug(`The cached Gemini file no longer exists: ${name}`)
        return null
      }
      throw new VideoAnalyzerError(
        'GEMINI_REQUEST_FAILED',
        'Could not confirm the cached Gemini file.',
        {
          hint: 'Check your API key, quota, and network access. The cached upload was kept, so a retry can still reuse it.',
          cause: error,
        },
      )
    }
  }

  private async uploadAndWait(
    params: EnsureUploadedParams,
    key?: string,
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

    if (key) {
      const finalExpiry = Number.isFinite(expiresAtMs)
        ? expiresAtMs
        : this.now() + DEFAULT_CACHE_EXPIRY_MS
      this.touch(key, { handle: active, expiresAtMs: finalExpiry })
      this.store?.set(key, {
        fileName: active.name,
        mimeType: active.mimeType,
        expiresAtMs: finalExpiry,
      })
    }

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
        (signal) => this.sleep(Math.min(this.config.pollIntervalMs, remaining), signal),
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

  /**
   * Run a prompt against media the provider fetches itself.
   *
   * Nothing is uploaded, so there is no file handle and no cache entry. The MIME
   * type is omitted for a YouTube page URL; Google resolves the page and rejects
   * a MIME type on that form.
   */
  async generateWithUrl(
    params: {
      url: string
      mimeType?: string
      prompt: string
      systemInstruction?: string
      temperature?: number
      signal?: AbortSignal
    } & Pick<EnsureUploadedParams, 'onProgress'>,
  ): Promise<string> {
    params.onProgress?.('Asking Gemini to fetch the media directly…')
    return this.generate({
      parts: [
        {
          kind: 'file',
          fileUri: params.url,
          ...(params.mimeType ? { mimeType: params.mimeType } : {}),
        },
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
        onCancel: operationCancelled,
      })
    } catch (error) {
      // A client library may surface the abort itself; keep the public error stable.
      if (isAbortError(error)) {
        throw signal?.aborted ? operationCancelled() : requestTimeout(stage, effective, variable)
      }
      throw error
    }
  }

  /**
   * Await work that has no deadline of its own (a poll interval or a shared
   * upload) while still honouring the caller's cancellation.
   */
  private async waitUnlessCancelled<T>(
    work: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    try {
      return await runWithBounds(work, {
        timeoutMs: 0,
        ...(signal ? { signal } : {}),
        onTimeout: () => requestTimeout('poll', 0),
        onCancel: operationCancelled,
      })
    } catch (error) {
      if (signal?.aborted && isAbortError(error)) throw operationCancelled({ cause: error })
      throw error
    }
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

  /**
   * Wait for pending reference writes.
   *
   * A CLI process exits as soon as its event loop drains, so an operation that
   * published a reference flushes it before returning instead of relying on
   * the timer-ordered write to finish.
   */
  async flushStore(): Promise<void> {
    await this.store?.flush()
  }
}
