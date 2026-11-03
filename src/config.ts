import path from 'node:path'
import { isLogLevel, type LogLevel } from './utils/logger.js'
import { configMissing, invalidInput } from './utils/errors.js'
import { loadDotEnvInto } from './utils/dotenv.js'

/**
 * Default Gemini model. Override with `GEMINI_MODEL`.
 *
 * This is a multimodal Flash model that understands video and audio natively,
 * which is the only AI capability this toolkit needs.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'

export interface Config {
  geminiApiKey: string | undefined
  geminiModel: string
  /** Frame ceiling for AI-assisted sampling. `0` means no fixed ceiling. */
  maxFrames: number
  downloadMaxBytes: number
  requestTimeoutMs: number
  uploadTimeoutMs: number
  pollIntervalMs: number
  ffmpegPath: string
  ffprobePath: string
  ytDlpPath: string | undefined
  ytDlpMaxResolution: number | undefined
  ytDlpCookiesFile: string | undefined
  ytDlpImpersonate: string | undefined
  allowPrivateHosts: boolean
  logLevel: LogLevel
  /** Directory for files the caller asked us to keep. Defaults to the cwd. */
  outputDir: string | undefined
}

const DEFAULTS = {
  maxFrames: 100,
  downloadMaxBytes: 2 * 1024 * 1024 * 1024,
  requestTimeoutMs: 5 * 60 * 1000,
  uploadTimeoutMs: 10 * 60 * 1000,
  pollIntervalMs: 2_000,
} as const

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { min = 0 }: { min?: number } = {},
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    throw invalidInput(`${name} must be an integer >= ${min}.`, {
      hint: `Received ${JSON.stringify(raw)}.`,
    })
  }
  return parsed
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw invalidInput(`${name} must be a boolean.`, {
    hint: 'Use true/false, 1/0, yes/no, or on/off.',
  })
}

function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

export interface LoadConfigOptions {
  /**
   * Path to a `.env` file. Defaults to `.env` in the working directory.
   * Pass `null` to disable loading entirely.
   *
   * Only applied when reading the real process environment, so callers that pass
   * an explicit env object (tests, embedders) are never affected.
   */
  dotenvFile?: string | null
}

/** Parse configuration from an environment object (defaults to `process.env`). */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config {
  if (env === process.env && options.dotenvFile !== null) {
    loadDotEnvInto(env, options.dotenvFile ?? path.join(process.cwd(), '.env'))
  }

  const logLevelRaw = env['VIDEO_ANALYZER_LOG_LEVEL']?.trim()
  const logLevel: LogLevel =
    logLevelRaw && isLogLevel(logLevelRaw) ? logLevelRaw : ('warn' satisfies LogLevel)

  const maxFrames = readInt(env, 'VIDEO_ANALYZER_MAX_FRAMES', DEFAULTS.maxFrames)
  const downloadMaxMb = readInt(
    env,
    'VIDEO_ANALYZER_DOWNLOAD_MAX_MB',
    Math.floor(DEFAULTS.downloadMaxBytes / (1024 * 1024)),
    { min: 1 },
  )
  const requestTimeoutMs = readInt(
    env,
    'VIDEO_ANALYZER_REQUEST_TIMEOUT_MS',
    DEFAULTS.requestTimeoutMs,
    { min: 1_000 },
  )
  const ytDlpMaxResolutionRaw = readString(env, 'YT_DLP_MAX_RESOLUTION')

  return {
    geminiApiKey: readString(env, 'GEMINI_API_KEY'),
    geminiModel: readString(env, 'GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL,
    maxFrames,
    downloadMaxBytes: downloadMaxMb * 1024 * 1024,
    requestTimeoutMs,
    uploadTimeoutMs: readInt(env, 'VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS', DEFAULTS.uploadTimeoutMs, {
      min: 1_000,
    }),
    pollIntervalMs: readInt(env, 'VIDEO_ANALYZER_POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs, {
      min: 100,
    }),
    ffmpegPath: readString(env, 'FFMPEG_PATH') ?? 'ffmpeg',
    ffprobePath: readString(env, 'FFPROBE_PATH') ?? 'ffprobe',
    ytDlpPath: readString(env, 'YT_DLP_PATH'),
    ytDlpMaxResolution: ytDlpMaxResolutionRaw ? Number(ytDlpMaxResolutionRaw) : undefined,
    ytDlpCookiesFile: readString(env, 'YT_DLP_COOKIES_FILE'),
    ytDlpImpersonate: readString(env, 'YT_DLP_IMPERSONATE'),
    allowPrivateHosts: readBool(env, 'VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS', false),
    logLevel,
    outputDir: readString(env, 'VIDEO_ANALYZER_OUTPUT_DIR'),
  }
}

/** Throw when a Gemini-backed operation is attempted without an API key. */
export function requireGeminiApiKey(config: Config): string {
  if (!config.geminiApiKey) {
    throw configMissing('GEMINI_API_KEY is not set.', {
      hint: 'Create a key at https://aistudio.google.com/app/apikey and export GEMINI_API_KEY. Local tools (get_video_info, extract_frames, manual redaction) work without it.',
    })
  }
  return config.geminiApiKey
}
