import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * Integration-test helpers.
 *
 * Media fixtures are generated at test time with ffmpeg instead of being
 * committed, so the repository stays free of binary blobs. Tests that need
 * ffmpeg skip themselves when the binary is absent.
 */

export const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg'
export const FFPROBE = process.env['FFPROBE_PATH'] ?? 'ffprobe'

let cachedAvailability: boolean | undefined

export async function ffmpegAvailable(): Promise<boolean> {
  if (cachedAvailability !== undefined) return cachedAvailability
  try {
    await execFileAsync(FFMPEG, ['-version'], { timeout: 15_000, windowsHide: true })
    await execFileAsync(FFPROBE, ['-version'], { timeout: 15_000, windowsHide: true })
    cachedAvailability = true
  } catch {
    cachedAvailability = false
  }
  return cachedAvailability
}

export interface SampleVideo {
  path: string
  durationSeconds: number
  width: number
  height: number
}

/** Create a small H.264/AAC test clip with a tone so it has a real audio track. */
export async function createSampleVideo(
  dir: string,
  options: { durationSeconds?: number; width?: number; height?: number } = {},
): Promise<SampleVideo> {
  const duration = options.durationSeconds ?? 4
  const width = options.width ?? 320
  const height = options.height ?? 240

  await mkdir(dir, { recursive: true })
  const target = path.join(dir, 'sample.mp4')

  await execFileAsync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${duration}:size=${width}x${height}:rate=15`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${duration}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      target,
    ],
    { timeout: 60_000, windowsHide: true },
  )

  return { path: target, durationSeconds: duration, width, height }
}

/** Create an audio-only test file. */
export async function createSampleAudio(dir: string, durationSeconds = 2): Promise<string> {
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, 'sample.m4a')
  await execFileAsync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
      '-c:a',
      'aac',
      target,
    ],
    { timeout: 60_000, windowsHide: true },
  )
  return target
}
