import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
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
  outDir: string
  /** Longest-edge cap in pixels; keeps MCP image payloads reasonable. */
  maxWidth?: number
  signal?: AbortSignal
}

function frameArgs(options: FrameExtractionOptions): string[] {
  const width = options.maxWidth ?? 1280
  return ['-vf', `scale=${width}:-2`, '-q:v', '3']
}

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
  const metadata = await getMediaMetadata(filePath, config, options.signal)
  const duration = metadata.durationSeconds
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

/** Extract one frame every `intervalSec` seconds. */
export async function extractFramesAtInterval(
  filePath: string,
  intervalSec: number,
  config: Config,
  options: FrameExtractionOptions,
): Promise<string[]> {
  if (intervalSec <= 0) throw invalidInput('intervalSec must be greater than 0.')

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
      `fps=1/${intervalSec},scale=${options.maxWidth ?? 1280}:-2`,
      '-q:v',
      '3',
      pattern,
    ],
    FFMPEG_TIMEOUT_MS,
    options.signal,
  )

  return listFrames(options.outDir)
}

/** Extract the single frame closest to each requested timestamp. */
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

export type RedactionEffect = 'blur' | 'pixelate' | 'blackout'

export interface RedactionRegion {
  x: number
  y: number
  width: number
  height: number
  startTime?: number
  endTime?: number
  label?: string
}

function evenDown(value: number): number {
  const rounded = Math.max(2, Math.floor(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

function enableClause(region: RedactionRegion): string {
  const hasStart = typeof region.startTime === 'number'
  const hasEnd = typeof region.endTime === 'number'
  if (!hasStart && !hasEnd) return ''
  const start = hasStart ? region.startTime : 0
  const end = hasEnd ? region.endTime : start
  return `:enable='between(t,${start},${end})'`
}

/**
 * Render a video with regions blurred, pixelated, or blacked out.
 *
 * Blackout uses `drawbox`; blur and pixelate crop the region, apply the effect,
 * and overlay the result back at the original coordinates.
 */
export async function renderRedactedVideo(
  inputPath: string,
  outputPath: string,
  regions: RedactionRegion[],
  effect: RedactionEffect,
  config: Config,
  signal?: AbortSignal,
): Promise<void> {
  if (regions.length === 0) throw invalidInput('At least one region is required.')

  const filters: string[] = []
  let current = '0:v'

  regions.forEach((region, index) => {
    const x = Math.max(0, Math.round(region.x))
    const y = Math.max(0, Math.round(region.y))
    const width = evenDown(region.width)
    const height = evenDown(region.height)
    const enable = enableClause(region)

    if (effect === 'blackout') {
      const label = `v${index}`
      filters.push(
        `[${current}]drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=black@1:t=fill${enable}[${label}]`,
      )
      current = label
      return
    }

    const scaledWidth = Math.max(2, evenDown(width / (effect === 'blur' ? 1 : 12)))
    const scaledHeight = Math.max(2, evenDown(height / (effect === 'blur' ? 1 : 12)))
    const inner =
      effect === 'blur'
        ? `crop=${width}:${height}:${x}:${y},boxblur=12:2`
        : `crop=${width}:${height}:${x}:${y},scale=${scaledWidth}:${scaledHeight}:flags=neighbor,scale=${width}:${height}:flags=neighbor`

    filters.push(`[${current}]split=2[base${index}][tmp${index}]`)
    filters.push(`[tmp${index}]${inner}[fx${index}]`)
    filters.push(`[base${index}][fx${index}]overlay=${x}:${y}${enable}[v${index}]`)
    current = `v${index}`
  })

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${current}]`,
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
  ]

  if (path.extname(outputPath).toLowerCase() === '.mp4') {
    args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart')
  } else {
    args.push('-c:a', 'copy')
  }

  args.push(outputPath)

  await run(config.ffmpegPath, args, FFMPEG_TIMEOUT_MS, signal)
}

/** Read a JPEG frame as base64 for Gemini image prompts. */
export async function readFrameBase64(framePath: string): Promise<string> {
  const buffer = await readFile(framePath)
  return buffer.toString('base64')
}

/**
 * Render preview frames with the planned regions outlined, so a caller can
 * confirm the geometry before committing to a full render.
 */
export async function renderRedactionPreview(
  inputPath: string,
  timestamps: number[],
  regions: RedactionRegion[],
  config: Config,
  outDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const boxes = regions
    .map((region) => {
      const x = Math.max(0, Math.round(region.x))
      const y = Math.max(0, Math.round(region.y))
      const width = Math.max(2, Math.round(region.width))
      const height = Math.max(2, Math.round(region.height))
      return `drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=yellow@0.9:t=4${enableClause(region)}`
    })
    .join(',')

  const results: string[] = []
  for (const [index, timestamp] of timestamps.entries()) {
    const target = path.join(outDir, `preview-${String(index + 1).padStart(3, '0')}.jpg`)
    await run(
      config.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        Math.max(0, timestamp).toFixed(3),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        boxes,
        '-q:v',
        '3',
        target,
      ],
      FFMPEG_TIMEOUT_MS,
      signal,
    )
    results.push(target)
  }
  return results
}

export { run as runCommand }
