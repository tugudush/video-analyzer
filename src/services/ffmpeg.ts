import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Config } from '../config.js'
import { VideoAnalyzerError, dependencyMissing, invalidInput } from '../utils/errors.js'

const execFileAsync = promisify(execFile)

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000
const FFPROBE_TIMEOUT_MS = 60 * 1000

export interface VideoStreamInfo {
  codec: string
  width: number
  height: number
  fps: number | undefined
  pixelFormat: string | undefined
}

export interface AudioStreamInfo {
  codec: string
  sampleRate: number | undefined
  channels: number | undefined
}

export interface MediaMetadata {
  durationSeconds: number
  container: string
  sizeBytes: number
  bitRate: number | undefined
  hasVideo: boolean
  hasAudio: boolean
  video: VideoStreamInfo | undefined
  audio: AudioStreamInfo | undefined
}

interface ProbeJson {
  streams?: Array<Record<string, unknown>>
  format?: Record<string, unknown>
}

function toNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseFrameRate(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const [numerator, denominator] = raw.split('/')
  const top = toNumber(numerator)
  const bottom = toNumber(denominator)
  if (top === undefined || bottom === undefined || bottom === 0) return top
  return top / bottom
}

async function run(
  binary: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw dependencyMissing(`${binary} is required but was not found on PATH.`, {
        hint: 'Install FFmpeg (https://ffmpeg.org/download.html) or set FFMPEG_PATH / FFPROBE_PATH.',
      })
    }
    const stderr = (error as { stderr?: string }).stderr?.trim() ?? ''
    const tail = stderr.split('\n').slice(-4).join('\n')
    throw new VideoAnalyzerError('MEDIA_PROCESSING_FAILED', `${path.basename(binary)} failed.`, {
      hint: tail || undefined,
      cause: error,
    })
  }
}

/** Read container/stream metadata with ffprobe. */
export async function getMediaMetadata(
  filePath: string,
  config: Config,
  signal?: AbortSignal,
): Promise<MediaMetadata> {
  const { stdout } = await run(
    config.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    FFPROBE_TIMEOUT_MS,
    signal,
  )

  let parsed: ProbeJson
  try {
    parsed = JSON.parse(stdout) as ProbeJson
  } catch (error) {
    throw new VideoAnalyzerError(
      'MEDIA_PROCESSING_FAILED',
      'ffprobe returned unparseable output.',
      {
        cause: error,
      },
    )
  }

  const streams = parsed.streams ?? []
  const videoStream = streams.find((stream) => stream['codec_type'] === 'video')
  const audioStream = streams.find((stream) => stream['codec_type'] === 'audio')
  const format = parsed.format ?? {}

  const duration = toNumber(format['duration']) ?? toNumber(videoStream?.['duration']) ?? 0
  const sizeFromDisk = await stat(filePath)
    .then((info) => info.size)
    .catch(() => 0)

  return {
    durationSeconds: duration,
    container: typeof format['format_name'] === 'string' ? format['format_name'] : 'unknown',
    sizeBytes: toNumber(format['size']) ?? sizeFromDisk,
    bitRate: toNumber(format['bit_rate']),
    hasVideo: videoStream !== undefined,
    hasAudio: audioStream !== undefined,
    video: videoStream
      ? {
          codec: String(videoStream['codec_name'] ?? 'unknown'),
          width: toNumber(videoStream['width']) ?? 0,
          height: toNumber(videoStream['height']) ?? 0,
          fps:
            parseFrameRate(videoStream['avg_frame_rate']) ??
            parseFrameRate(videoStream['r_frame_rate']),
          pixelFormat:
            typeof videoStream['pix_fmt'] === 'string' ? videoStream['pix_fmt'] : undefined,
        }
      : undefined,
    audio: audioStream
      ? {
          codec: String(audioStream['codec_name'] ?? 'unknown'),
          sampleRate: toNumber(audioStream['sample_rate']),
          channels: toNumber(audioStream['channels']),
        }
      : undefined,
  }
}

export interface FrameExtractionOptions {
  /**
   * Directory this extraction writes into.
   *
   * `extract_frames` always passes a newly created, empty folder, and that is
   * the contract the helpers rely on: `even` and `interval` build their result
   * by listing the directory afterwards, so a reused folder would report an
   * earlier run's frames, while `timestamps` and `scene` reuse the same
   * `frame-NNNN.jpg` names and would overwrite. `even` and `interval` refuse a
   * directory that already holds JPEGs (see `assertEmptyFrameDir`); the other
   * two leave that guarantee to the caller.
   */
  outDir: string
  /** Longest-edge cap in pixels; keeps MCP image payloads reasonable. */
  maxWidth?: number
  /**
   * Duration the caller already probed. Supplying it skips a second `ffprobe`
   * run on the same file.
   */
  durationSeconds?: number
  signal?: AbortSignal
}

/**
 * Smallest accepted spacing for interval extraction.
 *
 * Below one frame per 100 ms the interval is almost always a typo, and the
 * resulting frame count grows without bound on a long input.
 */
export const MIN_INTERVAL_SEC = 0.1

/**
 * Hard ceiling on the frames one extraction may write, whatever
 * `VIDEO_ANALYZER_MAX_FRAMES` says.
 *
 * `0` in that setting means "no configured ceiling", not "no ceiling": an
 * uncapped interval on a long video would otherwise fill the output directory
 * before anyone could page through the results.
 */
export const MAX_FRAMES_PER_EXTRACTION = 500

/**
 * Ceiling on the frames one scene-change extraction may produce.
 *
 * Scene detection runs in two passes (detect, then extract each timestamp), so
 * its ceiling is deliberately tighter than the `even` and `interval` budgets.
 */
export const MAX_SCENE_FRAMES = 200

/**
 * Resolve the effective frame budget for one extraction.
 *
 * A configured ceiling of `0` (or an unusable value) falls back to the hard
 * ceiling, and a larger configured ceiling is clamped to it. The result is
 * never below 1: ffmpeg reads `-frames:v 0` as "no limit", which would disable
 * the cap this function exists to apply.
 */
export function resolveFrameBudget(configured: number): number {
  if (!Number.isFinite(configured) || configured <= 0) return MAX_FRAMES_PER_EXTRACTION
  return Math.max(1, Math.min(Math.floor(configured), MAX_FRAMES_PER_EXTRACTION))
}

function frameArgs(options: FrameExtractionOptions): string[] {
  const width = options.maxWidth ?? 1280
  return ['-vf', `scale=${width}:-2`, '-q:v', '3']
}

/**
 * Refuse to extract into a directory that already holds frames.
 *
 * This is the invariant that makes `listFrames` trustworthy, not a check a
 * tool caller can trigger: `extract_frames` always passes a folder it has
 * just created, so the guard exists for direct callers of these helpers. A
 * reused directory would mix an earlier run's frames into this one and
 * overwrite its numbered files, so the caller's mistake is reported as
 * `INVALID_INPUT` before any subprocess runs. Only JPEGs are considered, so
 * an unrelated file in the directory does not block extraction.
 */
async function assertEmptyFrameDir(dir: string): Promise<void> {
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  const existing = entries.filter((entry) => entry.endsWith('.jpg'))
  if (existing.length === 0) return
  throw invalidInput(
    `The frame output directory already contains ${existing.length} JPEG file(s).`,
    {
      hint: 'Pass a directory this extraction owns; extract_frames always creates one per request.',
      details: { outDir: dir, existingFrames: existing.length },
    },
  )
}

/**
 * Frames written by the current extraction, in filename order.
 *
 * The directory is reserved for one run (see `assertEmptyFrameDir`), so every
 * entry listed here was produced by this invocation.
 */
async function listFrames(dir: string): Promise<string[]> {
  const entries = await readdir(dir)
  return entries
    .filter((entry) => entry.endsWith('.jpg'))
    .toSorted()
    .map((entry) => path.join(dir, entry))
}

/** Extract `count` evenly spaced frames. */
export async function extractFramesEvenly(
  filePath: string,
  count: number,
  config: Config,
  options: FrameExtractionOptions,
): Promise<string[]> {
  if (count <= 0) return []
  await assertEmptyFrameDir(options.outDir)

  const duration =
    options.durationSeconds ??
    (await getMediaMetadata(filePath, config, options.signal)).durationSeconds
  if (duration <= 0) {
    throw new VideoAnalyzerError(
      'MEDIA_PROCESSING_FAILED',
      'Cannot extract frames: the media has no measurable duration.',
    )
  }

  const fps = count / duration
  const pattern = path.join(options.outDir, 'frame-%04d.jpg')
  await run(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      filePath,
      '-vf',
      `fps=${fps.toFixed(6)},scale=${options.maxWidth ?? 1280}:-2`,
      '-q:v',
      '3',
      pattern,
    ],
    FFMPEG_TIMEOUT_MS,
    options.signal,
  )

  return listFrames(options.outDir)
}

export interface IntervalExtractionResult {
  /** Frames written to disk, in filename order. */
  paths: string[]
  /**
   * Presentation time of each written frame, in the same order as `paths`.
   *
   * Parsed from ffmpeg's `showinfo` output so the label describes the pixels
   * returned rather than the nominal sampling grid.
   */
  timestamps: number[]
  /** False when ffmpeg reported no `pts_time` and the grid was used instead. */
  timestampsExact: boolean
  /** Frames the interval would produce across the whole media, before the budget. */
  expectedFrames: number
  /** Frame budget that was enforced while ffmpeg was writing. */
  frameBudget: number
  /** True when the written frames do not cover the media at this interval. */
  truncated: boolean
}

/**
 * Extract one frame every `intervalSec` seconds.
 *
 * The frame budget is enforced *during* production (`-frames:v`), not just when
 * the response is assembled: a small interval on a long video used to write one
 * JPEG per interval regardless of `maxImages` or the configured frame limit.
 */
export async function extractFramesAtInterval(
  filePath: string,
  intervalSec: number,
  config: Config,
  options: FrameExtractionOptions & { maxFrames: number },
): Promise<IntervalExtractionResult> {
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL_SEC) {
    throw invalidInput(`intervalSec must be at least ${MIN_INTERVAL_SEC} seconds.`, {
      hint: `Received ${JSON.stringify(intervalSec)}. Use a larger interval or mode "even".`,
    })
  }
  await assertEmptyFrameDir(options.outDir)

  const duration =
    options.durationSeconds ??
    (await getMediaMetadata(filePath, config, options.signal)).durationSeconds
  const expectedFrames = duration > 0 ? Math.max(1, Math.ceil(duration / intervalSec)) : 0
  const frameBudget = resolveFrameBudget(options.maxFrames)

  const pattern = path.join(options.outDir, 'frame-%04d.jpg')
  // `showinfo` reports the presentation time of every frame the filter chain
  // emits, so the timestamps returned to the caller come from the frames that
  // were actually written instead of being assumed from the frame index.
  const { stderr } = await run(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'info',
      '-nostats',
      '-y',
      '-i',
      filePath,
      '-vf',
      `fps=1/${intervalSec},scale=${options.maxWidth ?? 1280}:-2,showinfo`,
      // Stop the encoder at the budget so a long input cannot fill the disk.
      '-frames:v',
      String(frameBudget),
      '-q:v',
      '3',
      pattern,
    ],
    FFMPEG_TIMEOUT_MS,
    options.signal,
  )

  const paths = await listFrames(options.outDir)
  const reported = [...stderr.matchAll(/pts_time:([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0)
  const timestamps = paths.map((_, index) => reported[index] ?? index * intervalSec)

  return {
    paths,
    timestamps,
    timestampsExact: paths.every((_, index) => reported[index] !== undefined),
    expectedFrames,
    frameBudget,
    // Compare against what was actually written: a shortfall means the list
    // does not cover the interval, whichever cause capped it.
    truncated: expectedFrames > paths.length,
  }
}

/**
 * Extract the single frame closest to each requested timestamp.
 *
 * Files are named `frame-NNNN.jpg` by position, so the caller must own an empty
 * directory: a reused one is overwritten in place, and no guard is applied here
 * (see `FrameExtractionOptions.outDir`).
 */
export async function extractFramesAtTimestamps(
  filePath: string,
  timestamps: number[],
  config: Config,
  options: FrameExtractionOptions,
): Promise<string[]> {
  const results: string[] = []

  for (const [index, timestamp] of timestamps.entries()) {
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw invalidInput(`Timestamps must be non-negative numbers; received ${timestamp}.`)
    }
    const target = path.join(options.outDir, `frame-${String(index + 1).padStart(4, '0')}.jpg`)
    await run(
      config.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        timestamp.toFixed(3),
        '-i',
        filePath,
        '-frames:v',
        '1',
        ...frameArgs(options),
        target,
      ],
      FFMPEG_TIMEOUT_MS,
      options.signal,
    )
    const info = await stat(target).catch(() => null)
    if (!info || info.size === 0) {
      throw new VideoAnalyzerError(
        'MEDIA_PROCESSING_FAILED',
        `ffmpeg reported success but wrote no frame at ${timestamp}s.`,
        {
          hint: 'This build may not be able to seek to that position or write the requested output.',
          details: { timestamp, path: target },
        },
      )
    }
    results.push(target)
  }

  return results
}

/**
 * Detect scene changes and extract a frame at each one.
 *
 * Two passes: a null-output pass collects `pts_time` values reported by
 * `showinfo`, then each timestamp is extracted individually. This avoids relying
 * on the image2 muxer's frame-rate guessing, which varies across ffmpeg builds.
 */
export async function extractSceneFrames(
  filePath: string,
  threshold: number,
  config: Config,
  options: FrameExtractionOptions & { maxFrames: number },
): Promise<{ paths: string[]; timestamps: number[]; truncated: boolean }> {
  const { stderr } = await run(
    config.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'info',
      '-nostats',
      '-i',
      filePath,
      '-an',
      '-vf',
      `select='gt(scene,${threshold})',showinfo`,
      '-f',
      'null',
      '-',
    ],
    FFMPEG_TIMEOUT_MS,
    options.signal,
  )

  const detected = [...stderr.matchAll(/pts_time:([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0)

  const unique = [...new Set(detected.map((value) => Number(value.toFixed(3))))].toSorted(
    (a, b) => a - b,
  )

  const limit = options.maxFrames > 0 ? Math.min(unique.length, options.maxFrames) : unique.length
  const timestamps = unique.slice(0, limit)

  if (timestamps.length === 0) {
    return { paths: [], timestamps: [], truncated: unique.length > 0 }
  }

  const paths = await extractFramesAtTimestamps(filePath, timestamps, config, options)
  return { paths, timestamps, truncated: unique.length > limit }
}
