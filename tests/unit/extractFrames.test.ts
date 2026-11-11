import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { executeOperation } from '../../src/operations/execute.js'
import { extractFramesInput, extractFramesOperation } from '../../src/operations/extractFrames.js'
import {
  MAX_FRAMES_PER_EXTRACTION,
  MIN_INTERVAL_SEC,
  extractFramesAtInterval,
  extractFramesEvenly,
  resolveFrameBudget,
} from '../../src/services/ffmpeg.js'
import { artifactDirOf } from '../helpers/results.js'

/**
 * ffmpeg/ffprobe are replaced by a fake execFile so the production budget can be
 * asserted without the binaries: the fake honours `-frames:v` exactly as ffmpeg
 * does and writes only the frames it was allowed to write.
 */
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
}))

interface FakeMedia {
  /** Duration the fake ffprobe reports. */
  durationSeconds: number
  /** Timestamps the fake scene-detection pass reports. */
  sceneTimes?: number[]
  /** Whether ffprobe reports a video stream. Defaults to true. */
  hasVideo?: boolean
  /** Report success without writing output files, to model a phantom path. */
  writeOutputs?: boolean
  /** Shift every reported `pts_time`, to prove labels come from ffmpeg. */
  ptsOffset?: number
}

type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void

function intervalOf(args: string[]): number {
  const filter = args[args.indexOf('-vf') + 1] ?? ''
  const match = /fps=1\/([0-9.]+)/.exec(filter)
  return match ? Number(match[1]) : 0
}

function framesForInterval(args: string[], durationSeconds: number): number {
  const interval = intervalOf(args)
  return interval > 0 ? Math.max(1, Math.ceil(durationSeconds / interval)) : 0
}

function installFakes({
  durationSeconds,
  sceneTimes = [],
  hasVideo = true,
  writeOutputs = true,
  ptsOffset = 0,
}: FakeMedia): {
  frameLimit: () => string | undefined
} {
  let lastFrameLimit: string | undefined

  mocks.execFile.mockImplementation(
    (file: string, args: string[], _opts: unknown, cb: Callback) => {
      if (file === 'ffprobe') {
        cb(null, {
          stdout: JSON.stringify({
            streams: hasVideo
              ? [
                  {
                    codec_type: 'video',
                    codec_name: 'h264',
                    width: 320,
                    height: 240,
                    avg_frame_rate: '15/1',
                    r_frame_rate: '15/1',
                    pix_fmt: 'yuv420p',
                  },
                ]
              : [],
            format: {
              duration: String(durationSeconds),
              format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
              size: '4096',
              bit_rate: '32000',
            },
          }),
          stderr: '',
        })
        return
      }

      const limitIndex = args.indexOf('-frames:v')
      lastFrameLimit = limitIndex >= 0 ? args[limitIndex + 1] : undefined

      // Scene mode: a null-output pass reports timestamps on stderr, then each
      // requested timestamp is extracted into its own file.
      if (args.includes('null')) {
        cb(null, {
          stdout: '',
          stderr: sceneTimes.map((time) => `pts_time:${time.toFixed(3)}`).join('\n'),
        })
        return
      }

      const target = args[args.length - 1] as string
      const targets: string[] = []
      let stderr = ''
      if (target.includes('%04d')) {
        const expected = framesForInterval(args, durationSeconds)
        const interval = intervalOf(args)
        const allowed =
          lastFrameLimit === undefined ? expected : Math.min(Number(lastFrameLimit), expected)
        for (let index = 1; index <= allowed; index++) {
          targets.push(target.replace('%04d', String(index).padStart(4, '0')))
        }
        // Real ffmpeg with `showinfo` reports every frame's presentation time.
        stderr = targets
          .map(
            (_, index) =>
              `[Parsed_showinfo_3 @ 0x0] n:${index} pts:0 pts_time:${(index * interval + ptsOffset).toFixed(3)}`,
          )
          .join('\n')
      } else if (lastFrameLimit === undefined || Number(lastFrameLimit) > 0) {
        targets.push(target)
      }

      void (async () => {
        try {
          if (writeOutputs) {
            for (const framePath of targets) await writeFile(framePath, `frame ${framePath}`)
          }
          cb(null, { stdout: '', stderr })
        } catch (error) {
          cb(error as Error)
        }
      })()
    },
  )

  return { frameLimit: () => lastFrameLimit }
}

describe('extract_frames frame budgets', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-frames-'))
    source = path.join(dir, 'sample.mp4')
    await writeFile(source, 'placeholder media bytes')
    mocks.execFile.mockReset()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stops production at the configured frame budget', async () => {
    const { frameLimit } = installFakes({ durationSeconds: 60 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '3' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, outputDir },
      config,
    )

    expect(frameLimit()).toBe('3')
    // 60 frames would fit the interval; only the budgeted three may exist.
    expect(await readdir(artifactDirOf(result.data))).toHaveLength(3)
    expect(result.images).toHaveLength(3)
    expect(result.data).toMatchObject({ totalFrames: 3, truncated: true })
    const warnings = result.warnings?.join(' ') ?? ''
    expect(warnings).toContain('3-frame budget')
    expect(warnings).toContain('Raise VIDEO_ANALYZER_MAX_FRAMES')
  })

  it('reports the expected count when the hard ceiling applies', async () => {
    installFakes({ durationSeconds: 600 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '0' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, maxImages: 1, outputDir },
      config,
    )

    // 600 frames would fit the interval, but the hard ceiling applies.
    expect(await readdir(artifactDirOf(result.data))).toHaveLength(MAX_FRAMES_PER_EXTRACTION)
    expect(result.data).toMatchObject({ totalFrames: MAX_FRAMES_PER_EXTRACTION, truncated: true })
    expect(result.warnings?.join(' ')).toContain('hard ceiling')
  })

  it('passes the hard cap to ffmpeg when the configured budget is uncapped', async () => {
    const { frameLimit } = installFakes({ durationSeconds: 60 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '0' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, outputDir },
      config,
    )

    // 60 frames are comfortably under the ceiling, so nothing is lost, but the
    // extraction is still bounded while it runs.
    expect(frameLimit()).toBe(String(MAX_FRAMES_PER_EXTRACTION))
    expect(result.data).toMatchObject({ totalFrames: 60, truncated: false })
    expect(result.warnings?.some((warning) => warning.includes('budget'))).toBe(false)
  })

  it('does not warn when the interval fits the budget', async () => {
    installFakes({ durationSeconds: 4 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '100' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 2, outputDir },
      config,
    )

    expect(result.data).toMatchObject({ totalFrames: 2, truncated: false })
    expect(result.warnings ?? []).toHaveLength(0)
  })

  it('pages the budgeted frames without changing how many are produced', async () => {
    installFakes({ durationSeconds: 50 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '5' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, maxImages: 2, outputDir },
      config,
    )

    expect(await readdir(artifactDirOf(result.data))).toHaveLength(5)
    expect(result.images).toHaveLength(2)
    expect(result.data).toMatchObject({ totalFrames: 5, offset: 0, hasMore: true })
  })

  it('exposes the expected count and applied budget in data', async () => {
    installFakes({ durationSeconds: 60 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '3' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, outputDir },
      config,
    )

    expect(result.data).toMatchObject({ expectedFrames: 60, frameBudget: 3, truncated: true })
  })

  it('treats a configured 500 as the hard ceiling when advising the user', async () => {
    installFakes({ durationSeconds: 600 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '500' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, maxImages: 1, outputDir },
      config,
    )

    const warnings = result.warnings?.join(' ') ?? ''
    expect(warnings).toContain('hard ceiling')
    expect(warnings).not.toContain('Raise VIDEO_ANALYZER_MAX_FRAMES')
  })

  it('marks a scene result truncated when the ceiling clips the list', async () => {
    installFakes({ durationSeconds: 60, sceneTimes: [1, 2, 3, 4] })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '2' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'scene', outputDir },
      config,
    )

    expect(result.data).toMatchObject({ mode: 'scene', totalFrames: 2, truncated: true })
    expect(result.warnings?.join(' ')).toContain('2-frame safety ceiling')
  })

  it('does not mark a complete scene result truncated', async () => {
    installFakes({ durationSeconds: 60, sceneTimes: [1, 2] })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '10' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'scene', outputDir },
      config,
    )

    expect(result.data).toMatchObject({ mode: 'scene', totalFrames: 2, truncated: false })
    expect(result.warnings ?? []).toHaveLength(0)
  })

  it('rejects a sub-minimum intervalSec before producing any frame', async () => {
    installFakes({ durationSeconds: 60 })
    const config = loadConfig({})

    await expect(
      executeOperation(
        extractFramesOperation,
        { videoPath: source, mode: 'interval', intervalSec: MIN_INTERVAL_SEC / 10 },
        config,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const ffmpegCalls = mocks.execFile.mock.calls.filter(([file]) => file === 'ffmpeg')
    expect(ffmpegCalls).toHaveLength(0)
  })

  it('advertises the interval floor through the input schema', () => {
    expect(
      extractFramesInput.safeParse({ videoPath: 'a.mp4', mode: 'interval', intervalSec: 0.05 })
        .success,
    ).toBe(false)
    expect(
      extractFramesInput.safeParse({
        videoPath: 'a.mp4',
        mode: 'interval',
        intervalSec: MIN_INTERVAL_SEC,
      }).success,
    ).toBe(true)
  })
})

describe('extract_frames output directory isolation', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-frames-'))
    source = path.join(dir, 'sample.mp4')
    await writeFile(source, 'placeholder media bytes')
    mocks.execFile.mockReset()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports only the frames written by the current run in a reused directory', async () => {
    installFakes({ durationSeconds: 10 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '50' })
    const outputDir = path.join(dir, 'frames')

    const first = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, outputDir },
      config,
    )
    expect(first.data).toMatchObject({ totalFrames: 10, truncated: false })

    // A shorter clip into the same directory: the ten stale frames used to be
    // counted as this run's output.
    installFakes({ durationSeconds: 3 })
    const second = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, outputDir },
      config,
    )

    expect(second.data).toMatchObject({ totalFrames: 3, truncated: false })
    expect(second.warnings ?? []).toHaveLength(0)

    const firstDir = artifactDirOf(first.data)
    const secondDir = artifactDirOf(second.data)
    expect(secondDir).not.toBe(firstDir)
    // The earlier run's frames are untouched and never reported by the new one.
    expect(await readdir(firstDir)).toHaveLength(10)
    expect(await readdir(secondDir)).toHaveLength(3)
    for (const image of second.images ?? []) {
      expect(image.path.startsWith(secondDir)).toBe(true)
    }
  })

  it('does not count unrelated JPEGs in a reused directory', async () => {
    installFakes({ durationSeconds: 4 })
    const config = loadConfig({})
    const outputDir = path.join(dir, 'frames')
    await mkdir(outputDir, { recursive: true })
    await writeFile(path.join(outputDir, 'screenshot.jpg'), 'not a frame')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 2, outputDir },
      config,
    )

    expect(result.data).toMatchObject({ totalFrames: 2, truncated: false })
    // The unrelated image stays where it was and is not part of the result.
    expect((await readdir(outputDir)).filter((entry) => entry.endsWith('.jpg'))).toEqual([
      'screenshot.jpg',
    ])
  })

  it('rejects a frame directory that already holds frames', async () => {
    installFakes({ durationSeconds: 5 })
    const config = loadConfig({})
    const outDir = path.join(dir, 'dirty')
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, 'frame-0001.jpg'), 'stale frame')

    await expect(
      extractFramesAtInterval(source, 1, config, { outDir, durationSeconds: 5, maxFrames: 10 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    // The stale frame is left alone and ffmpeg never ran.
    expect(await readdir(outDir)).toEqual(['frame-0001.jpg'])
    expect(mocks.execFile.mock.calls.filter(([file]) => file === 'ffmpeg')).toHaveLength(0)
  })

  it('applies the same guard to even extraction', async () => {
    installFakes({ durationSeconds: 5 })
    const config = loadConfig({})
    const outDir = path.join(dir, 'dirty-even')
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, 'frame-0001.jpg'), 'stale frame')

    await expect(
      extractFramesEvenly(source, 3, config, { outDir, durationSeconds: 5 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    // The guard runs before any subprocess, so nothing was probed or encoded.
    expect(mocks.execFile.mock.calls.filter(([file]) => file === 'ffmpeg')).toHaveLength(0)
  })
})

describe('resolveFrameBudget', () => {
  it('falls back to the hard ceiling for an uncapped or unusable value', () => {
    expect(resolveFrameBudget(0)).toBe(MAX_FRAMES_PER_EXTRACTION)
    expect(resolveFrameBudget(-5)).toBe(MAX_FRAMES_PER_EXTRACTION)
    expect(resolveFrameBudget(Number.NaN)).toBe(MAX_FRAMES_PER_EXTRACTION)
  })

  it('clamps a configured budget to the hard ceiling', () => {
    expect(resolveFrameBudget(25)).toBe(25)
    expect(resolveFrameBudget(MAX_FRAMES_PER_EXTRACTION * 4)).toBe(MAX_FRAMES_PER_EXTRACTION)
  })

  it('never returns zero, which ffmpeg would read as unlimited', () => {
    expect(resolveFrameBudget(0.5)).toBe(1)
  })
})

async function listIfPresent(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[])
}

describe('extract_frames timestamps mode', () => {
  let dir: string
  let source: string
  let outputDir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-timestamps-'))
    source = path.join(dir, 'sample.mp4')
    outputDir = path.join(dir, 'frames')
    await writeFile(source, 'placeholder media bytes')
    mocks.execFile.mockReset()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects a timestamp beyond the media duration before any subprocess runs', async () => {
    installFakes({ durationSeconds: 2 })
    const config = loadConfig({})

    await expect(
      executeOperation(
        extractFramesOperation,
        { videoPath: source, mode: 'timestamps', timestamps: [0.5, 999], outputDir },
        config,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { timestamp: 999, durationSeconds: 2 },
    })

    expect(mocks.execFile.mock.calls.filter(([file]) => file === 'ffmpeg')).toHaveLength(0)
    // Nothing was written, so nothing has to be cleaned up either.
    expect(await listIfPresent(outputDir)).toEqual([])
  })

  it('rejects a timestamp at the exact duration', async () => {
    installFakes({ durationSeconds: 2 })
    const config = loadConfig({})

    await expect(
      executeOperation(
        extractFramesOperation,
        { videoPath: source, mode: 'timestamps', timestamps: [2], outputDir },
        config,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { timestamp: 2 } })
  })

  it('labels each requested timestamp', async () => {
    installFakes({ durationSeconds: 5 })
    const config = loadConfig({})

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'timestamps', timestamps: [0.5, 1.5], outputDir },
      config,
    )

    expect(result.data).toMatchObject({
      mode: 'timestamps',
      totalFrames: 2,
      timestamps: [0.5, 1.5],
    })
    expect(result.images?.map((image) => image.label)).toEqual(['t=0.50s', 't=1.50s'])
  })

  it('reports a missing output file and removes the partial artifact folder', async () => {
    installFakes({ durationSeconds: 5, writeOutputs: false })
    const config = loadConfig({})

    await expect(
      executeOperation(
        extractFramesOperation,
        { videoPath: source, mode: 'timestamps', timestamps: [1], outputDir },
        config,
      ),
    ).rejects.toMatchObject({
      code: 'MEDIA_PROCESSING_FAILED',
      details: { timestamp: 1 },
    })

    expect(await listIfPresent(outputDir)).toEqual([])
  })
})

describe('extract_frames interval timestamps', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-interval-'))
    source = path.join(dir, 'sample.mp4')
    await writeFile(source, 'placeholder media bytes')
    mocks.execFile.mockReset()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('uses the presentation times ffmpeg reports, not the frame index', async () => {
    installFakes({ durationSeconds: 4, ptsOffset: 0.5 })
    const config = loadConfig({})

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, outputDir: path.join(dir, 'frames') },
      config,
    )

    expect(result.data).toMatchObject({ timestamps: [0.5, 1.5, 2.5, 3.5] })
    expect(result.images?.map((image) => image.label)).toEqual([
      't=0.50s',
      't=1.50s',
      't=2.50s',
      't=3.50s',
    ])
    expect(result.warnings ?? []).toHaveLength(0)
  })
})

describe('extract_frames audio-only input', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-audio-'))
    source = path.join(dir, 'sample.m4a')
    await writeFile(source, 'placeholder media bytes')
    mocks.execFile.mockReset()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.each(['even', 'interval', 'timestamps', 'scene'] as const)(
    'rejects %s mode with an actionable error',
    async (mode) => {
      installFakes({ durationSeconds: 10, hasVideo: false, sceneTimes: [1] })
      const config = loadConfig({})
      const input =
        mode === 'interval'
          ? { videoPath: source, mode, intervalSec: 1 }
          : mode === 'timestamps'
            ? { videoPath: source, mode, timestamps: [1] }
            : { videoPath: source, mode }

      await expect(executeOperation(extractFramesOperation, input, config)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INPUT',
      })

      expect(mocks.execFile.mock.calls.filter(([file]) => file === 'ffmpeg')).toHaveLength(0)
    },
  )
})

describe('extract_frames cancellation', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-cancel-'))
    source = path.join(dir, 'sample.mp4')
    await writeFile(source, 'placeholder media bytes')
    mocks.execFile.mockReset()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports a cancelled run as OPERATION_CANCELLED, not a media failure', async () => {
    installFakes({ durationSeconds: 10 })
    // Model the kill: execFile rejects with an AbortError and no stderr to quote.
    mocks.execFile.mockImplementation(
      (file: string, _args: string[], _opts: unknown, cb: Callback) => {
        if (file === 'ffprobe') {
          cb(null, {
            stdout: JSON.stringify({
              streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }],
              format: { duration: '10', format_name: 'mov,mp4', size: '4096' },
            }),
            stderr: '',
          })
          return
        }
        const error = Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        })
        setImmediate(() => cb(error))
      },
    )

    const controller = new AbortController()
    controller.abort()

    await expect(
      executeOperation(
        extractFramesOperation,
        {
          videoPath: source,
          mode: 'interval',
          intervalSec: 1,
          outputDir: path.join(dir, 'frames'),
        },
        loadConfig({}),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
      message: 'The operation was cancelled.',
    })
  })

  it('names the time budget when ffmpeg is killed by its own timeout', async () => {
    installFakes({ durationSeconds: 10 })
    mocks.execFile.mockImplementation(
      (file: string, _args: string[], _opts: unknown, cb: Callback) => {
        if (file === 'ffprobe') {
          cb(null, {
            stdout: JSON.stringify({
              streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }],
              format: { duration: '10', format_name: 'mov,mp4', size: '4096' },
            }),
            stderr: '',
          })
          return
        }
        // What execFile produces when its own `timeout` kills the child.
        const error = Object.assign(new Error('Command failed'), {
          killed: true,
          signal: 'SIGTERM',
          stderr: '',
        })
        setImmediate(() => cb(error))
      },
    )

    await expect(
      executeOperation(
        extractFramesOperation,
        {
          videoPath: source,
          mode: 'interval',
          intervalSec: 1,
          outputDir: path.join(dir, 'frames'),
        },
        loadConfig({}),
      ),
    ).rejects.toMatchObject({
      code: 'MEDIA_PROCESSING_FAILED',
      message: expect.stringContaining('did not finish within'),
    })
  })
})
