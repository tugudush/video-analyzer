/**
 * Interface-neutral error model.
 *
 * Errors raised anywhere in the core are converted into a stable envelope so the
 * CLI and the MCP adapter can present them consistently without leaking stack
 * traces or secrets.
 */

export const ERROR_CODES = [
  'INVALID_INPUT',
  'CONFIG_MISSING',
  'DEPENDENCY_MISSING',
  'INPUT_NOT_FOUND',
  'UNSUPPORTED_INPUT',
  'URL_REJECTED',
  'DOWNLOAD_FAILED',
  'MEDIA_PROCESSING_FAILED',
  'GEMINI_UPLOAD_FAILED',
  'GEMINI_PROCESSING_FAILED',
  'GEMINI_REQUEST_FAILED',
  'GEMINI_TIMEOUT',
  'OUTPUT_FAILED',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorEnvelope {
  code: ErrorCode
  message: string
  hint?: string
  details?: Record<string, unknown>
}

export interface VideoAnalyzerErrorOptions {
  hint?: string
  details?: Record<string, unknown>
  cause?: unknown
}

/** Error type used for every expected failure in the toolkit. */
export class VideoAnalyzerError extends Error {
  readonly code: ErrorCode
  readonly hint?: string
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, options: VideoAnalyzerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'VideoAnalyzerError'
    this.code = code
    if (options.hint !== undefined) this.hint = options.hint
    if (options.details !== undefined) this.details = options.details
  }

  toEnvelope(): ErrorEnvelope {
    const envelope: ErrorEnvelope = { code: this.code, message: this.message }
    if (this.hint !== undefined) envelope.hint = this.hint
    if (this.details !== undefined) envelope.details = this.details
    return envelope
  }
}

/** Normalize any thrown value into a `VideoAnalyzerError`. */
export function toVideoAnalyzerError(error: unknown): VideoAnalyzerError {
  if (error instanceof VideoAnalyzerError) return error

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new VideoAnalyzerError('GEMINI_TIMEOUT', 'The operation was cancelled or timed out.', {
        cause: error,
      })
    }
    return new VideoAnalyzerError('INTERNAL', error.message, { cause: error })
  }

  return new VideoAnalyzerError('INTERNAL', String(error))
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  return toVideoAnalyzerError(error).toEnvelope()
}

export function invalidInput(message: string, options: VideoAnalyzerErrorOptions = {}) {
  return new VideoAnalyzerError('INVALID_INPUT', message, options)
}

export function configMissing(message: string, options: VideoAnalyzerErrorOptions = {}) {
  return new VideoAnalyzerError('CONFIG_MISSING', message, options)
}

export function dependencyMissing(message: string, options: VideoAnalyzerErrorOptions = {}) {
  return new VideoAnalyzerError('DEPENDENCY_MISSING', message, options)
}
