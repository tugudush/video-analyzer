import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { getVideoInfoOperation } from '../../src/operations/getVideoInfo.js'
import { extractFramesOperation } from '../../src/operations/extractFrames.js'
import { executeOperation } from '../../src/operations/execute.js'
import { createLogger } from '../../src/utils/logger.js'
import { createSampleAudio, createSampleVideo, ffmpegAvailable } from '../helpers/media.js'
import { artifactDirOf } from '../helpers/results.js'

const available = await ffmpegAvailable()

describe.skipIf(!available)('local media operations (requires ffmpeg)', () => {
  let workDir: string
  let config: ReturnType<typeof loadConfig>

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'video-analyzer-it-'))
    config = loadConfig({ VIDEO_ANALYZER_OUTPUT_DIR: workDir })
  })

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('reports metadata for a generated clip', async () => {
    const sample = await createSampleVideo(workDir)
    const result = await executeOperation(getVideoInfoOperation, { videoPath: sample.path }, config)

    expect(result.summary).toContain('h264')
    const data = result.data as {
      durationSeconds: number
      hasVideo: boolean
      hasAudio: boolean
      video: { width: number; height: number; fps: number }
      audio: { codec: string }
    }
    expect(data.hasVideo).toBe(true)
    expect(data.hasAudio).toBe(true)
    expect(data.video.width).toBe(320)
    expect(data.video.height).toBe(240)
    expect(data.video.fps).toBeCloseTo(15, 1)
    expect(data.audio.codec).toBe('aac')
  })

  it('accepts file:// URIs', async () => {
    const sample = await createSampleVideo(workDir)
    const url = new URL(`file://${sample.path.replace(/\\/g, '/')}`).href
    const result = await executeOperation(getVideoInfoOperation, { videoPath: url }, config)
    expect(result.data).toMatchObject({ hasVideo: true })
  })

  it('warns when the input has no video stream', async () => {
    const audioPath = await createSampleAudio(workDir)
    const result = await executeOperation(getVideoInfoOperation, { videoPath: audioPath }, config)
    expect(result.data).toMatchObject({ hasVideo: false, hasAudio: true })
    expect(result.warnings?.join(' ')).toContain('audio-only')
  })

  it('extracts evenly spaced frames into an explicit directory', async () => {
    const sample = await createSampleVideo(workDir)
    const outputDir = path.join(workDir, 'frames-even')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: sample.path, mode: 'even', count: 3, outputDir },
      config,
    )

    expect(result.images).toHaveLength(3)
    for (const image of result.images ?? []) {
      const info = await stat(image.path)
      expect(info.size).toBeGreaterThan(0)
    }
    expect(result.data).toMatchObject({ mode: 'even', totalFrames: 3, hasMore: false })
  })

  it('extracts frames at explicit timestamps', async () => {
    const sample = await createSampleVideo(workDir)
    const outputDir = path.join(workDir, 'frames-timestamps')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: sample.path, mode: 'timestamps', timestamps: [0.5, 2], outputDir },
      config,
    )

    expect(result.images).toHaveLength(2)
    const data = result.data as { timestamps: number[] }
    expect(data.timestamps).toEqual([0.5, 2])
  })

  it('paginates frames with offset and maxImages', async () => {
    const sample = await createSampleVideo(workDir)
    const outputDir = path.join(workDir, 'frames-page')

    const first = await executeOperation(
      extractFramesOperation,
      { videoPath: sample.path, mode: 'even', count: 6, maxImages: 2, outputDir },
      config,
    )

    expect(first.images).toHaveLength(2)
    expect(first.data).toMatchObject({ offset: 0, hasMore: true })
    expect(first.warnings?.join(' ')).toContain('offset=2')
  })

  it('stops interval extraction at a small configured frame budget', async () => {
    const sample = await createSampleVideo(workDir)
    const outputDir = path.join(workDir, 'frames-interval-budget')
    const budgetedConfig = loadConfig({
      VIDEO_ANALYZER_OUTPUT_DIR: workDir,
      VIDEO_ANALYZER_MAX_FRAMES: '2',
    })

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: sample.path, mode: 'interval', intervalSec: 0.5, outputDir },
      budgetedConfig,
    )

    // A 4s clip at one frame per half second would produce eight frames.
    expect(await readdir(artifactDirOf(result.data))).toHaveLength(2)
    expect(result.images).toHaveLength(2)
    expect(result.data).toMatchObject({ mode: 'interval', totalFrames: 2, truncated: true })
    expect(result.warnings?.join(' ')).toContain('2-frame budget')
  })

  it('keeps a reused output directory free of earlier frames', async () => {
    const sample = await createSampleVideo(workDir)
    const outputDir = path.join(workDir, 'frames-reused')

    const first = await executeOperation(
      extractFramesOperation,
      { videoPath: sample.path, mode: 'even', count: 6, outputDir },
      config,
    )
    const second = await executeOperation(
      extractFramesOperation,
      { videoPath: sample.path, mode: 'even', count: 2, outputDir },
      config,
    )

    expect(first.data).toMatchObject({ totalFrames: 6 })
    // The shorter run reports only its own two frames, not the earlier six.
    expect(second.data).toMatchObject({ totalFrames: 2, hasMore: false })
    expect(second.images).toHaveLength(2)
    expect(artifactDirOf(second.data)).not.toBe(artifactDirOf(first.data))
    expect(await readdir(artifactDirOf(first.data))).toHaveLength(6)
    expect(await readdir(artifactDirOf(second.data))).toHaveLength(2)
  })

  it('detects scene changes', async () => {
    const sample = await createSampleVideo(workDir)
    const outputDir = path.join(workDir, 'frames-scene')

    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: sample.path, mode: 'scene', sceneThreshold: 0.1, outputDir },
      config,
    )

    expect(result.data).toMatchObject({ mode: 'scene' })
    // Scene detection is content-dependent: a synthetic test pattern may or may
    // not cross the threshold. When frames are found they must be real files.
    expect(Array.isArray(result.images)).toBe(true)
    for (const image of result.images ?? []) {
      expect((await stat(image.path)).size).toBeGreaterThan(0)
    }
  })

  it('uses the configured logger and progress hook', async () => {
    const sample = await createSampleVideo(workDir)
    const messages: string[] = []

    const result = await executeOperation(
      getVideoInfoOperation,
      { videoPath: sample.path },
      config,
      { logger: createLogger('silent'), onProgress: (message) => messages.push(message) },
    )

    expect(result.summary).toContain('Duration')
    expect(messages).toContain('Resolving media input…')
  })
})
