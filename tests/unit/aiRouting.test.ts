import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { analyzeVideoOperation } from '../../src/operations/analyzeVideo.js'
import { searchTimestampOperation } from '../../src/operations/searchTimestamp.js'
import { GeminiMediaService, type GeminiApi } from '../../src/services/gemini.js'
import { FileUploadReferenceStore, credentialScope } from '../../src/services/uploadCache.js'
import { VideoAnalyzerError } from '../../src/utils/errors.js'
import { createLogger } from '../../src/utils/logger.js'
import type { OperationContext } from '../../src/operations/types.js'

vi.mock('../../src/services/ffmpeg.js', () => ({
  getMediaMetadata: vi.fn(async () => ({
    durationSeconds: 42,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    sizeBytes: 4096,
    bitRate: 32000,
    hasVideo: true,
    hasAudio: true,
    video: undefined,
    audio: undefined,
  })),
}))

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=abc123'

interface Harness {
  ctx: OperationContext
  uploadFile: ReturnType<typeof vi.fn>
  generateContent: ReturnType<typeof vi.fn>
}

function createHarness(answer = 'An answer.'): Harness {
  const handle = {
    name: 'files/abc',
    uri: 'https://generativelanguage.test/v1beta/files/abc',
    mimeType: 'video/mp4',
    state: 'ACTIVE',
  }
  const uploadFile = vi.fn(async () => handle)
  const getFile = vi.fn(async () => handle)
  const generateContent = vi.fn(async () => answer)

  const service = new GeminiMediaService({
    config: loadConfig({}),
    logger: createLogger('silent'),
    api: { uploadFile, getFile, generateContent } as unknown as GeminiApi,
    sleep: async () => undefined,
  })

  return {
    ctx: { config: loadConfig({}), logger: createLogger('silent'), geminiService: service },
    uploadFile,
    generateContent,
  }
}

describe('AI media routing', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-routing-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('sends a YouTube URL to Gemini without uploading', async () => {
    const { ctx, uploadFile, generateContent } = createHarness()

    const result = await analyzeVideoOperation.run(
      { videoPath: YOUTUBE_URL, question: 'What is shown?' },
      ctx,
    )

    expect(uploadFile).not.toHaveBeenCalled()
    expect(generateContent).toHaveBeenCalledTimes(1)
    const parts = generateContent.mock.calls[0]?.[0]?.parts as unknown[]
    // No MIME type: Google resolves the page itself and rejects the typed form.
    expect(parts[0]).toEqual({ kind: 'file', fileUri: YOUTUBE_URL })
    expect(result.summary).toBe('An answer.')
    // Duration cannot be read without the media, so it is reported as unknown
    // instead of being invented.
    expect(result.data).toMatchObject({ durationSeconds: null, source: 'gemini-url' })
    expect(result.warnings?.join(' ')).toContain('fetched the media directly')
  })

  it('uploads a snapshot of a local file and reports probed duration', async () => {
    const source = path.join(dir, 'clip.mp4')
    await writeFile(source, 'media bytes', 'utf8')
    const { ctx, uploadFile } = createHarness()

    const result = await analyzeVideoOperation.run({ videoPath: source, question: 'q' }, ctx)

    expect(uploadFile).toHaveBeenCalledTimes(1)
    const uploaded = uploadFile.mock.calls[0]?.[0] as { path: string; mimeType: string }
    // The caller's file is never handed to the provider directly.
    expect(uploaded.path).not.toBe(source)
    expect(uploaded.mimeType).toBe('video/mp4')
    expect(result.data).toMatchObject({ durationSeconds: 42, source: 'local' })
  })

  it('reuses the upload for unchanged local content', async () => {
    const source = path.join(dir, 'clip.mp4')
    await writeFile(source, 'media bytes', 'utf8')
    const { ctx, uploadFile } = createHarness()

    await analyzeVideoOperation.run({ videoPath: source, question: 'first' }, ctx)
    await analyzeVideoOperation.run({ videoPath: source, question: 'second' }, ctx)

    expect(uploadFile).toHaveBeenCalledTimes(1)
  })

  it('skips out-of-range timestamp checks when the duration is unknown', async () => {
    const { ctx } = createHarness('MATCH 999 1000 — a moment far past the end')

    const result = await searchTimestampOperation.run(
      { videoPath: YOUTUBE_URL, query: 'anything' },
      ctx,
    )

    expect(result.data).toMatchObject({ found: true })
    const warnings = result.warnings?.join(' ') ?? ''
    expect(warnings).not.toContain('beyond')
    expect(warnings).toContain('fetched the media directly')
  })
})

describe('cross-process upload reuse', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-route-cache-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function contextWithStore(answer = 'An answer.'): {
    ctx: OperationContext
    uploadFile: ReturnType<typeof vi.fn>
  } {
    const handle = {
      name: 'files/abc',
      uri: 'https://generativelanguage.test/v1beta/files/abc',
      mimeType: 'video/mp4',
      state: 'ACTIVE',
    }
    const uploadFile = vi.fn(async () => handle)
    const config = loadConfig({ VIDEO_ANALYZER_CACHE_DIR: dir, GEMINI_API_KEY: 'test-key' })
    const service = new GeminiMediaService({
      config,
      logger: createLogger('silent'),
      api: {
        uploadFile,
        getFile: vi.fn(async () => handle),
        generateContent: vi.fn(async () => answer),
      } as unknown as GeminiApi,
      sleep: async () => undefined,
      // The store the operation would create for this configuration.
      store: new FileUploadReferenceStore({
        dir,
        scope: credentialScope('test-key') as string,
        logger: createLogger('silent'),
      }),
    })
    return { ctx: { config, logger: createLogger('silent'), geminiService: service }, uploadFile }
  }

  it('reuses an upload in a later process without an explicit flush', async () => {
    const sourcePath = path.join(dir, 'clip.mp4')
    await writeFile(sourcePath, 'media bytes', 'utf8')

    const first = contextWithStore()
    await analyzeVideoOperation.run({ videoPath: sourcePath, question: 'first' }, first.ctx)
    expect(first.uploadFile).toHaveBeenCalledTimes(1)

    const second = contextWithStore()
    await analyzeVideoOperation.run({ videoPath: sourcePath, question: 'second' }, second.ctx)
    expect(second.uploadFile).not.toHaveBeenCalled()
  })
})

function fallbackProvider(generateContent: () => Promise<string>): {
  ctx: OperationContext
  uploadFile: ReturnType<typeof vi.fn>
} {
  const handle = {
    name: 'files/abc',
    uri: 'https://generativelanguage.test/v1beta/files/abc',
    mimeType: 'video/mp4',
    state: 'ACTIVE',
  }
  const uploadFile = vi.fn(async () => handle)
  const config = loadConfig({
    GEMINI_API_KEY: 'test-key',
    VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS: 'true',
  })
  const service = new GeminiMediaService({
    config,
    logger: createLogger('silent'),
    api: {
      uploadFile,
      getFile: vi.fn(async () => handle),
      generateContent: vi.fn(generateContent),
    } as unknown as GeminiApi,
    sleep: async () => undefined,
  })
  return {
    ctx: { config, logger: createLogger('silent'), geminiService: service },
    uploadFile,
  }
}

describe('direct URL fallback', () => {
  const servers: Server[] = []
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-url-fallback-'))
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  /** A public-shaped media URL: the probe and the fallback download both hit it. */
  async function mediaUrl(): Promise<string> {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '5' })
      res.end(req.method === 'HEAD' ? undefined : 'media')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || address === null) throw new Error('No port')
    return `http://127.0.0.1:${address.port}/clip.mp4`
  }

  it('reports the download route and probed metadata when the provider rejects the URL', async () => {
    const url = await mediaUrl()
    let calls = 0
    const { ctx, uploadFile } = fallbackProvider(async () => {
      calls += 1
      if (calls === 1) {
        throw new VideoAnalyzerError('GEMINI_REQUEST_FAILED', 'Gemini request failed.', {
          hint: 'Check your API key, quota, and network access.',
          cause: new Error('unable to fetch URL'),
        })
      }
      return 'An answer.'
    })

    const result = await analyzeVideoOperation.run({ videoPath: url, question: 'q' }, ctx)

    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(result.summary).toBe('An answer.')
    // The response must describe what actually happened, not the initial route.
    expect(result.data).toMatchObject({ source: 'download', durationSeconds: 42 })
    expect(result.warnings).toBeUndefined()
  })

  it('does not download when the provider reports a quota problem', async () => {
    const url = await mediaUrl()
    const { ctx, uploadFile } = fallbackProvider(async () => {
      throw new VideoAnalyzerError('GEMINI_REQUEST_FAILED', 'Gemini request failed.', {
        hint: 'Check your API key, quota, and network access.',
        cause: new Error('Quota exceeded for quota metric generate_content_free_tier_requests'),
      })
    })

    await expect(
      analyzeVideoOperation.run({ videoPath: url, question: 'q' }, ctx),
    ).rejects.toMatchObject({ code: 'GEMINI_REQUEST_FAILED' })
    expect(uploadFile).not.toHaveBeenCalled()
  })
})
