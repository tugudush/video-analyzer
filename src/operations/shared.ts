import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Config } from '../config.js'
import { GeminiMediaService } from '../services/gemini.js'
import { getMediaMetadata, type MediaMetadata } from '../services/ffmpeg.js'
import { resolveMediaInput, type ResolvedMedia } from '../services/mediaInput.js'
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

export async function statForUpload(
  media: ResolvedMedia,
): Promise<{ sizeBytes: number; mtimeMs: number }> {
  const info = await stat(media.path)
  return { sizeBytes: info.size, mtimeMs: info.mtimeMs }
}

/** Directory that keeps generated artifacts for the caller. */
export async function createArtifactDir(config: Config, prefix: string): Promise<string> {
  const base = path.resolve(config.outputDir ?? process.cwd(), 'video-analyzer-output')
  const dir = path.join(base, `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  await ensureDir(dir)
  return dir
}

/** Zero-pad a number for timestamp rendering. */
function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

/** `HH:MM:SS.mmm` for readable summaries. */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const ms = Math.round((seconds - total) * 1000)
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

/**
 * Extract the first JSON array/object from a model response, tolerating code
 * fences and surrounding prose.
 */
export function extractJsonPayload(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? text).trim()

  try {
    return JSON.parse(candidate)
  } catch {
    // Fall through to a scan for the first balanced JSON structure.
  }

  const startArray = candidate.indexOf('[')
  const startObject = candidate.indexOf('{')
  const starts = [startArray, startObject].filter((index) => index >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const opener = candidate[start]
  const closer = opener === '[' ? ']' : '}'
  const end = candidate.lastIndexOf(closer)
  if (end <= start) return undefined

  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}
