import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { requireGeminiApiKey, type Config } from '../config.js'
import { GeminiMediaService } from '../services/gemini.js'
import { getMediaMetadata, type MediaMetadata } from '../services/ffmpeg.js'
import { createLocalSnapshot } from '../services/localSnapshot.js'
import { classifyAiInput, isDirectUrlRejection } from '../services/mediaRouting.js'
import { resolveMediaInput, type ResolvedMedia } from '../services/mediaInput.js'
import { FileUploadReferenceStore, credentialScope } from '../services/uploadCache.js'
import { VideoAnalyzerError } from '../utils/errors.js'
import { ensureDir } from '../utils/fsUtils.js'
import type { OperationContext } from './types.js'

/**
 * Reuse uploads within one config and logging context, without routing one
 * embedded server's diagnostics to another server's logger.
 */
let sharedServices = new WeakMap<Config, WeakMap<OperationContext['logger'], GeminiMediaService>>()

export function getGeminiService(ctx: OperationContext): GeminiMediaService {
  if (ctx.geminiService) return ctx.geminiService
  let services = sharedServices.get(ctx.config)
  if (!services) {
    services = new WeakMap()
    sharedServices.set(ctx.config, services)
  }
  let service = services.get(ctx.logger)
  if (!service) {
    const store = createUploadStore(ctx)
    service = new GeminiMediaService({
      config: ctx.config,
      logger: ctx.logger,
      ...(store ? { store } : {}),
    })
    services.set(ctx.logger, service)
  }
  return service
}

/**
 * On-disk reference cache, only when the caller opted in.
 *
 * The store is partitioned by a one-way fingerprint of the API key so a
 * reference created with one credential is never offered to another.
 */
function createUploadStore(ctx: OperationContext): FileUploadReferenceStore | undefined {
  const dir = ctx.config.cacheDir
  if (!dir) return undefined
  const scope = credentialScope(ctx.config.geminiApiKey)
  if (!scope) return undefined
  return new FileUploadReferenceStore({ dir: path.resolve(dir), scope, logger: ctx.logger })
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
  sharedServices = new WeakMap()
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
    logger: ctx.logger,
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
  /**
   * Content identity, present only when the source is immutable for this call:
   * a direct download lands in a new temp directory every time, so its path
   * cannot identify it. A mutable local path has no key and is uploaded each
   * time.
   */
  cacheKey?: string
  retainSource?: () => () => Promise<void>
}

/**
 * Describe a resolved source for the Gemini upload cache.
 *
 * The key, when there is one, is content-derived, so only identical downloads
 * reuse an upload. Size and mtime are deliberately not part of the identity: the
 * cache never re-checks them, and they cannot distinguish two different files.
 */
export function uploadIdentityFor(media: ResolvedMedia): UploadIdentity {
  return {
    ...(media.cacheKey ? { cacheKey: media.cacheKey } : {}),
    ...(media.retainSource ? { retainSource: media.retainSource } : {}),
  }
}

/**
 * Warning attached to a result whose meeting metadata was never read locally,
 * because Gemini fetched the media itself.
 */
export const DIRECT_MEDIA_METADATA_WARNING =
  'Gemini fetched the media directly, so duration and stream details were not read locally. Checks that need local metadata were skipped.'

/**
 * Warning attached when a download was used but `ffprobe` still could not read
 * it: the media was local, so the provider is not the reason the metadata is
 * missing.
 */
export const UNREADABLE_MEDIA_METADATA_WARNING =
  'The downloaded media could not be read locally, so duration and stream details are unavailable. Checks that need local metadata were skipped.'

/** Warning for a result whose duration and stream details are unknown. */
export function missingMetadataWarning(source: AiMediaSource): string {
  return source === 'gemini-url' ? DIRECT_MEDIA_METADATA_WARNING : UNREADABLE_MEDIA_METADATA_WARNING
}

export type AiMediaSource = 'local' | 'download' | 'gemini-url'

export interface AiPromptOptions {
  prompt: string
  systemInstruction?: string
  temperature?: number
}

/** What an AI operation may ask of one resolved input. */
export interface AiMediaSession {
  source: AiMediaSource
  /** ffprobe metadata; null when the provider fetches the media itself. */
  metadata: MediaMetadata | null
  /** Local file actually used (a snapshot for local inputs); null for URL input. */
  path: string | null
  generate(options: AiPromptOptions): Promise<string>
}

interface ResolvedAiMedia {
  source: AiMediaSource
  metadata: MediaMetadata | null
  path: string | null
  mimeType: string | undefined
  cacheKey?: string
  geminiUrl?: string
  retainSource?: () => () => Promise<void>
  cleanup(): Promise<void>
}

async function resolveAiMedia(input: string, ctx: OperationContext): Promise<ResolvedAiMedia> {
  const trimmed = input.trim()

  const remote = /^https?:\/\//i.test(trimmed)
  if (remote) {
    ctx.onProgress?.('Resolving media input…')
    const route = await classifyAiInput(
      trimmed,
      ctx.config,
      ctx.signal ? { signal: ctx.signal } : {},
    )

    if (route.kind === 'gemini-url') {
      return {
        source: 'gemini-url',
        metadata: null,
        path: null,
        mimeType: route.mimeType,
        geminiUrl: route.url,
        cleanup: async () => undefined,
      }
    }
  }

  const media = await resolveMediaInput(trimmed, ctx.config, {
    logger: ctx.logger,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  })

  if (media.source === 'local') {
    // A mutable path cannot identify its contents. The snapshot makes the hash
    // and the upload read the same bytes, and it is what gets probed.
    let snapshot
    try {
      snapshot = await createLocalSnapshot(media.path, {
        logger: ctx.logger,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    } catch (error) {
      await media.cleanup()
      throw error
    }

    try {
      const metadata = await getMediaMetadata(snapshot.path, ctx.config, ctx.signal)
      return {
        source: 'local',
        metadata,
        path: snapshot.path,
        mimeType: media.mimeType,
        cacheKey: `local:${media.mimeType}:${snapshot.sha256}`,
        retainSource: snapshot.retain,
        cleanup: snapshot.cleanup,
      }
    } catch (error) {
      await snapshot.cleanup()
      throw error
    }
  }

  try {
    const metadata = await getMediaMetadata(media.path, ctx.config, ctx.signal)
    return {
      source: 'download',
      metadata,
      path: media.path,
      mimeType: media.mimeType,
      ...(media.cacheKey ? { cacheKey: media.cacheKey } : {}),
      ...(media.retainSource ? { retainSource: media.retainSource } : {}),
      cleanup: media.cleanup,
    }
  } catch (error) {
    await media.cleanup()
    throw error
  }
}

/** Request options shared by both Gemini media routes. */
interface GeminiPromptParams {
  prompt: string
  systemInstruction?: string
  temperature?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

/** What one generation actually used, which can differ from the initial route. */
interface GenerationOutcome {
  text: string
  source: AiMediaSource
  metadata: MediaMetadata | null
}

async function generateFor(
  resolved: ResolvedAiMedia,
  input: string,
  ctx: OperationContext,
  options: AiPromptOptions,
): Promise<GenerationOutcome> {
  const service = getGeminiService(ctx)
  const common: GeminiPromptParams = {
    prompt: options.prompt,
    ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  }

  if (resolved.geminiUrl) {
    try {
      const text = await service.generateWithUrl({
        url: resolved.geminiUrl,
        ...(resolved.mimeType ? { mimeType: resolved.mimeType } : {}),
        ...common,
      })
      return { text, source: resolved.source, metadata: resolved.metadata }
    } catch (error) {
      // Only a provider rejection of the URL itself downgrades to a download;
      // quota, auth, timeout, and cancellation failures stay visible.
      if (!isDirectUrlRejection(error)) throw error
      ctx.logger.info('Gemini could not use the media URL directly; downloading instead.')
      return generateFromDownload(input, ctx, common)
    }
  }

  if (!resolved.path) {
    throw new VideoAnalyzerError('INTERNAL', 'No media file or URL was resolved for the request.')
  }

  const text = await service.generateWithFile({
    path: resolved.path,
    mimeType: resolved.mimeType ?? 'application/octet-stream',
    ...(resolved.cacheKey ? { cacheKey: resolved.cacheKey } : {}),
    ...(resolved.retainSource ? { retainSource: resolved.retainSource } : {}),
    ...common,
  })
  return { text, source: resolved.source, metadata: resolved.metadata }
}

/**
 * Download after a provider rejected the URL, then describe what was used.
 *
 * The download is local now, so its metadata is probed for the caller; a probe
 * failure leaves the metadata unknown instead of failing a generation that
 * already succeeded.
 */
async function generateFromDownload(
  input: string,
  ctx: OperationContext,
  common: GeminiPromptParams,
): Promise<GenerationOutcome> {
  const media = await resolveMediaInput(input, ctx.config, {
    logger: ctx.logger,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  })
  try {
    const metadata = await getMediaMetadata(media.path, ctx.config, ctx.signal).catch(
      (error: unknown) => {
        ctx.logger.debug(`Could not probe the downloaded media: ${String(error)}`)
        return null
      },
    )
    const text = await getGeminiService(ctx).generateWithFile({
      path: media.path,
      mimeType: media.mimeType,
      ...uploadIdentityFor(media),
      ...common,
    })
    return { text, source: 'download', metadata }
  } finally {
    await media.cleanup()
  }
}

export interface AiMediaOutcome<T> {
  result: T
  /** ffprobe metadata, or null when it could not be read locally. */
  metadata: MediaMetadata | null
  /** Route the successful generation used; a URL fallback reports `download`. */
  source: AiMediaSource
}

/**
 * Resolve one AI input, hand it to `use`, then clean up.
 *
 * Result, metadata, and route are returned together so an operation can report
 * what it actually knows and did: a direct URL has no locally probed duration,
 * and a URL the provider rejected was downloaded after all.
 */
export async function withAiMedia<T>(
  input: string,
  ctx: OperationContext,
  use: (session: AiMediaSession) => Promise<T>,
): Promise<AiMediaOutcome<T>> {
  const resolved = await resolveAiMedia(input, ctx)
  let source = resolved.source
  let metadata = resolved.metadata

  try {
    const result = await use({
      get source() {
        return source
      },
      get metadata() {
        return metadata
      },
      path: resolved.path,
      generate: async (options) => {
        const outcome = await generateFor(resolved, input, ctx, options)
        source = outcome.source
        metadata = outcome.metadata
        return outcome.text
      },
    })
    return { result, metadata, source }
  } finally {
    await resolved.cleanup()
    // Persisted references are written asynchronously; make them survive a
    // process that exits as soon as this call returns.
    await getGeminiService(ctx).flushStore()
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

/**
 * Warning attached by every operation that reports model-estimated times, so a
 * caller cannot present an estimate as a frame-accurate position.
 */
export const TIMESTAMP_ESTIMATE_WARNING =
  'Timestamps are Gemini estimates derived from its internal sampling, not frame-accurate seek positions. Verify with extract_frames before cutting.'

/** Shared analyst preamble so behaviour is consistent across AI operations. */
export const ANALYST_SYSTEM_INSTRUCTION = [
  'You are a precise media analyst working from a video file that includes its audio track.',
  'Base every statement on what is actually visible or audible in the media.',
  'Never invent scenes, dialogue, on-screen text, speakers, or timestamps.',
  'When the media does not contain the requested information, say so plainly.',
  'If you are uncertain, state the uncertainty rather than guessing.',
].join(' ')
