import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { requireGeminiApiKey, type Config } from '../config.js'
import { GeminiMediaService } from '../services/gemini.js'
import { getMediaMetadata, type MediaMetadata } from '../services/ffmpeg.js'
import { resolveMediaInput, type ResolvedMedia } from '../services/mediaInput.js'
import { VideoAnalyzerError } from '../utils/errors.js'
import { ensureDir } from '../utils/fsUtils.js'
import type { OperationContext } from './types.js'

/**
 * One Gemini service per process/config so upload reuse survives across calls in
 * a long-lived MCP session.
 */
let sharedService: { config: Config; service: GeminiMediaService } | undefined

export function getGeminiService(ctx: OperationContext): GeminiMediaService {
  if (ctx.geminiService) return ctx.geminiService
  if (!sharedService || sharedService.config !== ctx.config) {
    sharedService = {
      config: ctx.config,
      service: new GeminiMediaService({ config: ctx.config, logger: ctx.logger }),
    }
  }
  return sharedService.service
}

/**
 * Assert the AI provider is usable before any media work starts.
 *
 * Resolving a remote input can download gigabytes and run `ffprobe`, so a missing
 * key has to be reported first — otherwise the caller pays for the most expensive
 * part of the call to learn about a one-line configuration fix. An injected
 * service owns its own credentials, so it satisfies the requirement.
 */
export function assertGeminiAvailable(ctx: OperationContext): void {
  if (ctx.geminiService) return
  requireGeminiApiKey(ctx.config)
}

/** Reset the process-wide service (tests only). */
export function resetGeminiService(): void {
  sharedService?.service.clearCache()
  sharedService = undefined
}

export interface PreparedMedia {
  media: ResolvedMedia
  metadata: MediaMetadata
  /** Absolute path to the local file, for convenience. */
  path: string
}

/**
 * Resolve any input to a local file and read its metadata.
 *
 * On failure the temporary working directory is always removed.
 */
export async function prepareMedia(
  videoPath: string,
  ctx: OperationContext,
): Promise<PreparedMedia> {
  ctx.onProgress?.('Resolving media input…')
  const media = await resolveMediaInput(videoPath, ctx.config, {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  })

  try {
    const metadata = await getMediaMetadata(media.path, ctx.config, ctx.signal)
    return { media, metadata, path: media.path }
  } catch (error) {
    await media.cleanup()
    throw error
  }
}

/** Upload identity for one resolved source: what Gemini needs to cache it. */
export interface UploadIdentity {
  sizeBytes: number
  mtimeMs: number
  /**
   * Stable source identity when the local path is not stable (a direct download
   * lands in a new temp directory on every call).
   */
  cacheKey?: string
}

/**
 * Describe a resolved source for the Gemini upload cache.
 *
 * Local files are identified by path plus size and mtime. A downloaded copy is
 * identified by its origin instead, so repeated calls for the same URL reuse one
 * upload rather than uploading the same bytes again under a new temp path.
 */
export async function statForUpload(media: ResolvedMedia): Promise<UploadIdentity> {
  const info = await stat(media.path)
  return {
    sizeBytes: info.size,
    mtimeMs: info.mtimeMs,
    ...(media.cacheKey ? { cacheKey: media.cacheKey } : {}),
  }
}

/**
 * Directory that keeps generated artifacts for the caller.
 *
 * Every call returns a new, empty folder, so artifacts written by an earlier
 * run are never listed or overwritten by a later one. `baseDir` overrides the
 * configured artifact root, which lets an operation treat a caller-supplied
 * directory as a parent and still get a fresh folder per run. Both roots are
 * resolved against the working directory, so the returned path is absolute.
 *
 * A base that cannot be created is a caller problem (a file where a directory is
 * expected, a read-only volume), so it is reported as `OUTPUT_FAILED` with the
 * setting that produced it instead of leaking a raw `ENOTDIR` as `INTERNAL`.
 */
export async function createArtifactDir(
  config: Config,
  prefix: string,
  baseDir?: string,
): Promise<string> {
  const base = path.resolve(
    baseDir ?? path.join(config.outputDir ?? process.cwd(), 'video-analyzer-output'),
  )
  const dir = path.join(base, `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  try {
    await ensureDir(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new VideoAnalyzerError(
      'OUTPUT_FAILED',
      `Could not create the artifact directory: ${base}`,
      {
        hint: baseDir
          ? 'Pass "outputDir" as a writable directory (it may not be an existing file).'
          : 'Set VIDEO_ANALYZER_OUTPUT_DIR to a writable directory and retry.',
        details: {
          ...(baseDir ? { outputDir: base } : { outputRoot: base }),
          ...(code ? { code } : {}),
        },
        cause: error,
      },
    )
  }
  return dir
}

/** Zero-pad a number for timestamp rendering. */
function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

/** `HH:MM:SS.mmm` for readable summaries. */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  // Round once, in integer milliseconds: rounding the fractional part separately
  // would let a value just below a whole second render as `.1000`.
  const totalMs = Math.round(seconds * 1000)
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const secs = Math.floor((totalMs % 60_000) / 1000)
  const ms = totalMs % 1000
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(ms, 3)}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Shared analyst preamble so behaviour is consistent across AI operations. */
export const ANALYST_SYSTEM_INSTRUCTION = [
  'You are a precise media analyst working from a video file that includes its audio track.',
  'Base every statement on what is actually visible or audible in the media.',
  'Never invent scenes, dialogue, on-screen text, speakers, or timestamps.',
  'When the media does not contain the requested information, say so plainly.',
  'If you are uncertain, state the uncertainty rather than guessing.',
].join(' ')
