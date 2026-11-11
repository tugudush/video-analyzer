import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { executeOperation } from '../../src/operations/execute.js'
import { extractFramesOperation } from '../../src/operations/extractFrames.js'
import { getVideoInfoOperation } from '../../src/operations/getVideoInfo.js'
import { getMediaMetadata } from '../../src/services/ffmpeg.js'

type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), streams: [] as unknown[] }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
}))

const attachedCover = {
  index: 0,
  codec_type: 'video',
  codec_name: 'mjpeg',
  width: 64,
  height: 64,
  avg_frame_rate: '0/0',
  r_frame_rate: '0/0',
  disposition: { attached_pic: 1 },
}

const motionVideo = {
  index: 1,
  codec_type: 'video',
  codec_name: 'h264',
  width: 320,
  height: 240,
  avg_frame_rate: '15/1',
  r_frame_rate: '15/1',
}

const audio = {
  index: 0,
  codec_type: 'audio',
  codec_name: 'mp3',
  sample_rate: '44100',
  channels: 1,
}

describe('attached cover art', () => {
  let outRoot: string
  let song: string
  let movie: string
  const ffmpegCalls: string[][] = []

  beforeEach(async () => {
    outRoot = await mkdtemp(path.join(tmpdir(), 'va-cover-art-'))
    song = path.join(outRoot, 'song.mp3')
    movie = path.join(outRoot, 'movie.mp4')
    await writeFile(song, 'audio')
    await writeFile(movie, 'video')
    ffmpegCalls.length = 0
    mocks.execFile.mockImplementation(
      (file: string, args: string[], _options: unknown, callback: Callback) => {
        if (file === 'ffprobe') {
          callback(null, {
            stdout: JSON.stringify({
              streams: mocks.streams,
              format: { duration: '2', format_name: 'mp3', size: '1024' },
            }),
            stderr: '',
          })
          return
        }
        ffmpegCalls.push(args)
        const target = args[args.length - 1] as string
        // Scene detection writes to `-f null -`; nothing is saved there.
        if (target === '-') {
          callback(null, { stdout: '', stderr: '' })
          return
        }
        const output = target.includes('%04d') ? target.replace('%04d', '0001') : target
        void (async () => {
          try {
            await writeFile(output, 'frame')
            callback(null, { stdout: '', stderr: '' })
          } catch (error) {
            callback(error as Error)
          }
        })()
      },
    )
  })

  afterEach(async () => {
    await rm(outRoot, { recursive: true, force: true })
  })

  it('reports audio with only cover art as audio-only', async () => {
    mocks.streams = [audio, attachedCover]
    const config = loadConfig({})

    const metadata = await getMediaMetadata(song, config)

    expect(metadata.hasVideo).toBe(false)
    expect(metadata.video).toBeUndefined()
    expect(metadata.audio).toMatchObject({ index: 0, codec: 'mp3' })

    const info = await executeOperation(getVideoInfoOperation, { videoPath: song }, config)
    expect(info.warnings).toContain('No video stream found; this looks like an audio-only file.')
    await expect(
      executeOperation(extractFramesOperation, { videoPath: song }, config),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  })

  it('ignores cover art when a real video stream is present', async () => {
    mocks.streams = [attachedCover, motionVideo, audio]
    const config = loadConfig({ VIDEO_ANALYZER_OUTPUT_DIR: outRoot })

    const metadata = await getMediaMetadata(movie, config)
    expect(metadata.video).toMatchObject({ index: 1, codec: 'h264', width: 320 })

    await executeOperation(
      extractFramesOperation,
      { videoPath: movie, mode: 'even', count: 1 },
      config,
    )

    expect(ffmpegCalls.at(-1)).toContain('0:1')
    expect(ffmpegCalls.at(-1)).not.toContain('0:v:0')
  })

  it('maps the probed stream in every extraction mode', async () => {
    mocks.streams = [attachedCover, motionVideo]
    const config = loadConfig({ VIDEO_ANALYZER_OUTPUT_DIR: outRoot })

    for (const options of [
      { mode: 'interval', intervalSec: 1 },
      { mode: 'timestamps', timestamps: [0] },
      { mode: 'scene', sceneThreshold: 0.1 },
    ] as const) {
      ffmpegCalls.length = 0
      await executeOperation(extractFramesOperation, { videoPath: movie, ...options }, config)
      const maps = ffmpegCalls
        .filter((args) => args.includes('-map'))
        .map((args) => args[args.indexOf('-map') + 1])
      expect(maps.length).toBeGreaterThan(0)
      expect(new Set(maps)).toEqual(new Set(['0:1']))
    }
  })
})
