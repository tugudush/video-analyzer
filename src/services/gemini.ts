import { GoogleGenAI } from '@google/genai'
import type { Config } from '../config.js'
import { requireGeminiApiKey } from '../config.js'
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

export interface GeminiApi {
  uploadFile(params: { path: string; mimeType?: string }): Promise<GeminiFileHandle>
  getFile(name: string): Promise<GeminiFileHandle>
  generateContent(params: {
    model: string
    parts: GeminiPart[]
    systemInstruction?: string
    temperature?: number
    signal?: AbortSignal
  }): Promise<string>
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

  async uploadFile(params: { path: string; mimeType?: string }): Promise<GeminiFileHandle> {
    const uploaded = await this.client.files.upload({
      file: params.path,
      ...(params.mimeType ? { config: { mimeType: params.mimeType } } : {}),
    })
    return normalizeHandle(uploaded as Parameters<typeof normalizeHandle>[0])
  }

  async getFile(name: string): Promise<GeminiFileHandle> {
    const file = await this.client.files.get({ name })
    return normalizeHandle(file as Parameters<typeof normalizeHandle>[0])
  }

  async generateContent(params: {
    model: string
    parts: GeminiPart[]
    systemInstruction?: string
    temperature?: number
    signal?: AbortSignal
  }): Promise<string> {
    const parts = params.parts.map((part) => {
      if (part.kind === 'text') return { text: part.text }
      if (part.kind === 'file') {
        return { fileData: { fileUri: part.fileUri, mimeType: part.mimeType } }
      }
      return { inlineData: { data: part.data, mimeType: part.mimeType } }
    })

    const response = await this.client.models.generateContent({
      model: params.model,
      contents: [{ role: 'user', parts }],
      ...(params.systemInstruction || params.temperature !== undefined
        ? {
            config: {
              ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
              ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
            },
          }
        : {}),
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

    const cached = this.cache.get(key)
    if (cached && cached.expiresAtMs > this.now()) {
      const active = await this.checkActive(cached.handle.name)
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
      return existing
    }

    const promise = this.uploadAndWait(params, key)
    this.inFlight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(key)
    }
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

  private async checkActive(name: string): Promise<GeminiFileHandle | null> {
    try {
      const file = await this.api.getFile(name)
      return file.state === 'ACTIVE' ? file : null
    } catch {
      return null
    }
  }

  private async uploadAndWait(
    params: EnsureUploadedParams,
    key: string,
  ): Promise<GeminiFileHandle> {
    params.onProgress?.('Uploading media to Gemini…')

    let uploaded: GeminiFileHandle
    try {
      uploaded = await this.api.uploadFile({ path: params.path, mimeType: params.mimeType })
    } catch (error) {
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

    const active = await this.waitForActive(uploaded, params.onProgress)

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
    onProgress?: (message: string) => void,
  ): Promise<GeminiFileHandle> {
    const deadline = this.now() + this.config.uploadTimeoutMs
    let handle = uploaded
    let announced = false

    while (handle.state === 'PROCESSING' || handle.state === 'STATE_UNSPECIFIED') {
      if (this.now() >= deadline) {
        throw new VideoAnalyzerError(
          'GEMINI_TIMEOUT',
          'Gemini did not finish processing the media in time.',
          {
            hint: 'Long videos can take several minutes. Raise VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS.',
            details: { fileName: handle.name, timeoutMs: this.config.uploadTimeoutMs },
          },
        )
      }

      if (!announced) {
        onProgress?.('Waiting for Gemini to process the media…')
        announced = true
      }

      await this.sleep(this.config.pollIntervalMs)

      try {
        handle = await this.api.getFile(handle.name)
      } catch (error) {
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
      return await this.api.generateContent({
        model: this.config.geminiModel,
        parts: params.parts,
        ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      })
    } catch (error) {
      if (error instanceof VideoAnalyzerError) throw error
      this.logger.debug(`Gemini request failed: ${String(error)}`)
      throw new VideoAnalyzerError('GEMINI_REQUEST_FAILED', 'Gemini request failed.', {
        hint: 'Check your API key, quota, and network access.',
        cause: error,
      })
    }
  }

  /** Test seam: drop all cached upload references. */
  clearCache(): void {
    this.cache.clear()
    this.inFlight.clear()
  }
}
