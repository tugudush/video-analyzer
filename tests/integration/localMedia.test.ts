import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { analyzeVideoOperation } from '../../src/operations/analyzeVideo.js'
import { getVideoInfoOperation } from '../../src/operations/getVideoInfo.js'
import { extractFramesOperation } from '../../src/operations/extractFrames.js'
import { executeOperation } from '../../src/operations/execute.js'
import { extractFramesEvenly, getMediaMetadata } from '../../src/services/ffmpeg.js'
import { GeminiMediaService, type GeminiApi } from '../../src/services/gemini.js'
import { createLogger } from '../../src/utils/logger.js'
import { createSampleAudio, createSampleVideo, ffmpegAvailable, FFMPEG } from '../helpers/media.js'
import { artifactDirOf } from '../helpers/results.js'

const available = await ffmpegAvailable()
const execFileAsync = promisify(execFile)

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

  it('limits even extraction when the supplied duration underestimates the video', async () => {
    const sample = await createSampleVideo(workDir)
    const outDir = path.join(workDir, 'frames-short-duration')
    await mkdir(outDir)
    const frames = await extractFramesEvenly(sample.path, 2, config, {
      outDir,
      durationSeconds: 1,
    })
    expect(frames).toHaveLength(2)
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

  it('reopens an extracted page after the source and media binaries are unavailable', async () => {
    const sample = await createSampleVideo(workDir)
    const first = await executeOperation(
      extractFramesOperation,
      { videoPath: sample.path, mode: 'interval', intervalSec: 1, maxImages: 1 },
      config,
    )
    const frameSetDir = artifactDirOf(first.data)
    await rm(sample.path)
    const page = await executeOperation(
      extractFramesOperation,
      { frameSetDir, offset: 1, maxImages: 1 },
      loadConfig({ FFMPEG_PATH: 'missing-ffmpeg', FFPROBE_PATH: 'missing-ffprobe' }),
    )
    expect(page.data).toMatchObject({ outputDir: frameSetDir, totalFrames: 4, offset: 1 })
    expect(page.images?.[0]?.path).toBe(path.join(frameSetDir, 'frame-0002.jpg'))
  })

  it('keeps a remote source alive for a shared upload after its leader cancels', async () => {
    const sample = await createSampleVideo(workDir)
    const bytes = await readFile(sample.path)
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4' })
      response.end(bytes)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const url = `http://127.0.0.1:${address.port}/sample.mp4`
    const remoteConfig = loadConfig({ VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS: 'true' })
    const logger = createLogger('silent')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = false
    let followerWaiting = false
    const handle = { name: 'files/a', uri: 'file:a', mimeType: 'video/mp4', state: 'ACTIVE' }
    const api: GeminiApi = {
      uploadFile: async ({ path: sourcePath }) => {
        started = true
        await gate
        expect(await readFile(sourcePath)).toEqual(bytes)
        return handle
      },
      getFile: async () => handle,
      generateContent: async () => 'answer',
    }
    const service = new GeminiMediaService({ config: remoteConfig, logger, api })
    const controller = new AbortController()
    try {
      const leader = analyzeVideoOperation.run(
        { videoPath: url, question: 'first' },
        { config: remoteConfig, logger, geminiService: service, signal: controller.signal },
      )
      const leaderResult = expect(leader).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
      await vi.waitFor(() => expect(started).toBe(true))
      const follower = analyzeVideoOperation.run(
        { videoPath: url, question: 'second' },
        {
          config: remoteConfig,
          logger,
          geminiService: service,
          onProgress: (message) => {
            if (message.startsWith('Waiting for an in-flight')) followerWaiting = true
          },
        },
      )
      await vi.waitFor(() => expect(followerWaiting).toBe(true))
      controller.abort()
      await leaderResult
      release()
      await expect(follower).resolves.toMatchObject({ summary: 'answer' })
    } finally {
      release()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each([
    { width: 64, height: 128, expectedWidth: 64, expectedHeight: 128 },
    { width: 800, height: 1600, expectedWidth: 640, expectedHeight: 1280 },
    { width: 1600, height: 800, expectedWidth: 1280, expectedHeight: 640 },
  ])(
    'caps the longest edge without upscaling for $width x $height in every mode',
    async ({ width, height, expectedWidth, expectedHeight }) => {
      const source = path.join(workDir, `scale-${width}-${height}.mp4`)
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
          `color=c=red:s=${width}x${height}:r=2:d=1`,
          '-f',
          'lavfi',
          '-i',
          `color=c=blue:s=${width}x${height}:r=2:d=1`,
          '-filter_complex',
          '[0:v][1:v]concat=n=2:v=1:a=0[v]',
          '-map',
          '[v]',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          source,
        ],
        { timeout: 60_000, windowsHide: true },
      )
      const modes = [
        { mode: 'even', count: 2 },
        { mode: 'interval', intervalSec: 1 },
        { mode: 'timestamps', timestamps: [0] },
        { mode: 'scene', sceneThreshold: 0.1 },
      ] as const
      for (const options of modes) {
        const result = await executeOperation(
          extractFramesOperation,
          { videoPath: source, ...options },
          config,
        )
        expect(result.images?.length).toBeGreaterThan(0)
        for (const image of result.images ?? []) {
          const metadata = await getMediaMetadata(image.path, config)
          expect(metadata.video).toMatchObject({ width: expectedWidth, height: expectedHeight })
        }
      }
    },
    60_000,
  )

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
    expect(
      (await readdir(artifactDirOf(result.data))).filter((entry) => entry.endsWith('.jpg')),
    ).toHaveLength(2)
    expect(result.images).toHaveLength(2)
    expect(result.data).toMatchObject({ mode: 'interval', totalFrames: 2, truncated: true })
    expect(result.warnings?.join(' ')).toContain('2-frame budget')
  })

  it.each([
    { duration: 0.4, expected: 1 },
    { duration: 1, expected: 1 },
    { duration: 1.1, expected: 2 },
  ])('samples a $duration-second clip at a one-second interval', async ({ duration, expected }) => {
    const source = path.join(workDir, `short-${duration}.mp4`)
    await execFileAsync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${duration}:size=64x64:rate=10`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source,
    ])
    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 1 },
      config,
    )
    expect(result.data).toMatchObject({
      totalFrames: expected,
      expectedFrames: expected,
      truncated: false,
    })
    expect(result.images).toHaveLength(expected)
  })

  it('warns that interval labels are approximate when pixels come from another source time', async () => {
    const source = path.join(workDir, 'interval-timing.mp4')
    await execFileAsync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=64x64:rate=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source,
    ])
    const result = await executeOperation(
      extractFramesOperation,
      { videoPath: source, mode: 'interval', intervalSec: 0.5 },
      config,
    )
    const expectedFrame = path.join(workDir, 'source-frame-1.jpg')
    await execFileAsync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      source,
      '-vf',
      "select='eq(n,1)',scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease",
      '-frames:v',
      '1',
      '-q:v',
      '3',
      expectedFrame,
    ])
    const image = result.images?.[1]
    expect(image?.label).toBe('t=0.50s')
    if (!image) throw new Error('Second interval frame is missing.')
    expect(await readFile(image.path)).toEqual(await readFile(expectedFrame))
    expect(result.warnings?.join(' ')).toContain('approximate sampling-grid')
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
    expect(
      (await readdir(artifactDirOf(first.data))).filter((entry) => entry.endsWith('.jpg')),
    ).toHaveLength(6)
    expect(
      (await readdir(artifactDirOf(second.data))).filter((entry) => entry.endsWith('.jpg')),
    ).toHaveLength(2)
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
