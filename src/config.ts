import path from 'node:path'
import { isLogLevel, type LogLevel } from './utils/logger.js'
import { MAX_TIMER_MS } from './utils/abort.js'
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
  /**
   * Frame budget for `extract_frames`: `interval` mode stops at it, and scene
   * mode uses it as a lower ceiling. AI operations send the whole file to Gemini
   * and never sample frames, so this setting does not affect them. `0` means no
   * configured ceiling; a 500-frame hard ceiling per extraction still applies.
   */
  maxFrames: number
  downloadMaxBytes: number
  requestTimeoutMs: number
  uploadTimeoutMs: number
  pollIntervalMs: number
  ffmpegPath: string
  ffprobePath: string
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
  { min = 0, max }: { min?: number; max?: number } = {},
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  const inRange =
    Number.isFinite(parsed) &&
    Number.isInteger(parsed) &&
    parsed >= min &&
    (max === undefined || parsed <= max)
  if (!inRange) {
    throw invalidInput(
      max === undefined
        ? `${name} must be an integer >= ${min}.`
        : `${name} must be an integer between ${min} and ${max}.`,
      { hint: `Received ${JSON.stringify(raw)}.` },
    )
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

/**
 * Settings a `.env` file may supply.
 *
 * `.env` is read from the working directory, which in the Skill workflow is
 * whatever repository the agent is working in. Treating it as untrusted means a
 * repository-supplied file cannot point `execFile` at a bundled binary
 * (`FFMPEG_PATH` / `FFPROBE_PATH`), rewrite `PATH`, or disable the private-host
 * guard. Anything not listed here must come from the real environment.
 */
export const DOTENV_KEYS = [
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'VIDEO_ANALYZER_MAX_FRAMES',
  'VIDEO_ANALYZER_DOWNLOAD_MAX_MB',
  'VIDEO_ANALYZER_REQUEST_TIMEOUT_MS',
  'VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS',
  'VIDEO_ANALYZER_POLL_INTERVAL_MS',
  'VIDEO_ANALYZER_OUTPUT_DIR',
  'VIDEO_ANALYZER_LOG_LEVEL',
] as const

/**
 * Apply a `.env` file to `target`, limited to the keys a repository may choose.
 *
 * @returns The names of the variables that were actually applied.
 */
export function applyDotEnv(target: NodeJS.ProcessEnv, filePath?: string): string[] {
  return loadDotEnvInto(target, filePath, { allowKeys: DOTENV_KEYS })
}

export interface LoadConfigOptions {
  /**
   * Path to a `.env` file. Defaults to `.env` in the working directory.
   * Pass `null` to disable loading entirely.
   *
   * Only applied when reading the real process environment, so callers that pass
   * an explicit env object (tests, embedders) are never affected. Only
   * {@link DOTENV_KEYS} may be set this way; the file cannot choose the media
   * binaries, rewrite `PATH`, or disable the private-host guard.
   */
  dotenvFile?: string | null
}

/** Parse configuration from an environment object (defaults to `process.env`). */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): Config {
  if (env === process.env && options.dotenvFile !== null) {
    applyDotEnv(env, options.dotenvFile ?? path.join(process.cwd(), '.env'))
  }

  // `YT_DLP_*` settings are deliberately unread: platform page downloads are
  // disabled, so the documented legacy variables stay harmless no-ops instead of
  // being parsed into a configuration surface nothing consumes.

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
    { min: 1_000, max: MAX_TIMER_MS },
  )

  return {
    geminiApiKey: readString(env, 'GEMINI_API_KEY'),
    geminiModel: readString(env, 'GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL,
    maxFrames,
    downloadMaxBytes: downloadMaxMb * 1024 * 1024,
    requestTimeoutMs,
    uploadTimeoutMs: readInt(env, 'VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS', DEFAULTS.uploadTimeoutMs, {
      min: 1_000,
      max: MAX_TIMER_MS,
    }),
    pollIntervalMs: readInt(env, 'VIDEO_ANALYZER_POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs, {
      min: 100,
      max: MAX_TIMER_MS,
    }),
    ffmpegPath: readString(env, 'FFMPEG_PATH') ?? 'ffmpeg',
    ffprobePath: readString(env, 'FFPROBE_PATH') ?? 'ffprobe',
    allowPrivateHosts: readBool(env, 'VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS', false),
    logLevel,
    outputDir: readString(env, 'VIDEO_ANALYZER_OUTPUT_DIR'),
  }
}

/** Throw when a Gemini-backed operation is attempted without an API key. */
export function requireGeminiApiKey(config: Config): string {
  if (!config.geminiApiKey) {
    throw configMissing('GEMINI_API_KEY is not set.', {
      hint: 'Create a key at https://aistudio.google.com/app/apikey and export GEMINI_API_KEY. Local tools (get_video_info, extract_frames) work without it.',
    })
  }
  return config.geminiApiKey
}
