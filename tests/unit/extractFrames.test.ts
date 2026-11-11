import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { executeOperation } from '../../src/operations/execute.js'
import { extractFramesInput, extractFramesOperation } from '../../src/operations/extractFrames.js'
import {
  MAX_FRAMES_PER_EXTRACTION,
  MIN_INTERVAL_SEC,
  resolveFrameBudget,
} from '../../src/services/ffmpeg.js'

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
}

type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void

function framesForInterval(args: string[], durationSeconds: number): number {
  const filter = args[args.indexOf('-vf') + 1] ?? ''
  const match = /fps=1\/([0-9.]+)/.exec(filter)
  if (!match) return 0
  const interval = Number(match[1])
  return interval > 0 ? Math.max(1, Math.ceil(durationSeconds / interval)) : 0
}

function installFakes({ durationSeconds }: FakeMedia): { frameLimit: () => string | undefined } {
  let lastFrameLimit: string | undefined

  mocks.execFile.mockImplementation(
    (file: string, args: string[], _opts: unknown, cb: Callback) => {
      if (file === 'ffprobe') {
        cb(null, {
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: 'video',
                codec_name: 'h264',
                width: 320,
                height: 240,
                avg_frame_rate: '15/1',
                r_frame_rate: '15/1',
                pix_fmt: 'yuv420p',
              },
            ],
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
      const allowed =
        lastFrameLimit === undefined
          ? framesForInterval(args, durationSeconds)
          : Math.min(Number(lastFrameLimit), framesForInterval(args, durationSeconds))

      const pattern = args[args.length - 1] as string
      void (async () => {
        try {
          for (let index = 1; index <= allowed; index++) {
            const target = pattern.replace('%04d', String(index).padStart(4, '0'))
            await writeFile(target, `frame ${index}`)
          }
          cb(null, { stdout: '', stderr: '' })
        } catch (error) {
          cb(error as Error)
        }
      })()
    },
  )

  return { frameLimit: () => lastFrameLimit }
}

describe('extract_frames interval budgets', () => {
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
    expect(await readdir(outputDir)).toHaveLength(3)
    expect(result.images).toHaveLength(3)
    expect(result.data).toMatchObject({ totalFrames: 3, truncated: true })
    const warnings = result.warnings?.join(' ') ?? ''
    expect(warnings).toContain('3-frame budget')
    expect(warnings).toContain('Raise VIDEO_ANALYZER_MAX_FRAMES')
  })

  it('explains the hard ceiling when the configured budget is uncapped', async () => {
    installFakes({ durationSeconds: 600 })
    const config = loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: '0' })
    const outputDir = path.join(dir, 'frames')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1, maxImages: 1, outputDir },
      config,
    )

    // 600 frames would fit the interval, but the hard ceiling applies.
    expect(await readdir(outputDir)).toHaveLength(MAX_FRAMES_PER_EXTRACTION)
    expect(result.data).toMatchObject({ totalFrames: MAX_FRAMES_PER_EXTRACTION, truncated: true })
    expect(result.warnings?.join(' ')).toContain('hard ceiling')
  })

  it('applies the hard ceiling when the configured budget is uncapped', async () => {
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

    expect(await readdir(outputDir)).toHaveLength(5)
    expect(result.images).toHaveLength(2)
    expect(result.data).toMatchObject({ totalFrames: 5, offset: 0, hasMore: true })
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
})
