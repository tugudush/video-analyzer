import { mkdtemp, readFile, readdir, rm, writeFile as writeFileActual } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { GeminiMediaService, type GeminiApi } from '../../src/services/gemini.js'
import { transcribeVideoOperation } from '../../src/operations/transcribeVideo.js'
import { createLogger } from '../../src/utils/logger.js'
import type { OperationContext } from '../../src/operations/types.js'

/**
 * `writeFile` is intercepted so a transcript write can fail the way a full or
 * read-only volume does, which is not reproducible on every platform.
 */
const writeFailure = vi.hoisted(() => ({ code: undefined as string | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      const code = writeFailure.code
      if (code) throw Object.assign(new Error(`simulated ${code}`), { code })
      return actual.writeFile(...args)
    }) as typeof actual.writeFile,
  }
})

vi.mock('../../src/services/ffmpeg.js', () => ({
  getMediaMetadata: vi.fn(async () => ({
    durationSeconds: 1,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    sizeBytes: 4096,
    bitRate: 32000,
    hasVideo: true,
    hasAudio: true,
    video: undefined,
    audio: undefined,
  })),
}))

function createService(): GeminiMediaService {
  const handle = {
    name: 'files/abc',
    uri: 'https://generativelanguage.test/v1beta/files/abc',
    mimeType: 'video/mp4',
    state: 'ACTIVE',
  }
  const api = {
    uploadFile: vi.fn(async () => handle),
    getFile: vi.fn(async () => handle),
    generateContent: vi.fn(async () => 'Hello from the recording.'),
  }
  return new GeminiMediaService({
    config: loadConfig({}),
    logger: createLogger('silent'),
    api: api as unknown as GeminiApi,
    sleep: async () => undefined,
  })
}

function createContext(service: GeminiMediaService): OperationContext {
  return { config: loadConfig({}), logger: createLogger('silent'), geminiService: service }
}

describe('transcribe_video output failures', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    writeFailure.code = undefined
    dir = await mkdtemp(path.join(tmpdir(), 'va-output-'))
    source = path.join(dir, 'sample.mp4')
    await writeFileActual(source, 'media bytes', 'utf8')
  })

  afterEach(async () => {
    writeFailure.code = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps the transcript and reports the write failure as a warning', async () => {
    const target = path.join(dir, 'transcript.txt')
    writeFailure.code = 'ENOSPC'

    const result = await transcribeVideoOperation.run(
      { videoPath: source, outputPath: target },
      createContext(createService()),
    )

    // The transcription is the result of an expensive call; a failed write must
    // not discard it.
    expect(result.summary).toBe('Hello from the recording.')
    expect(result.warnings?.join(' ')).toContain('was not written')
    expect(result.warnings?.join(' ')).toContain('ENOSPC')
    expect(result.artifacts).toBeUndefined()
    expect(result.data).toMatchObject({
      outputPath: path.resolve(target),
      outputWritten: false,
    })

    await expect(readFile(target, 'utf8')).rejects.toThrow()
    expect(await readFile(source, 'utf8')).toBe('media bytes')
  })

  it('marks a written transcript in the result', async () => {
    const target = path.join(dir, 'transcript.txt')

    const result = await transcribeVideoOperation.run(
      { videoPath: source, outputPath: target },
      createContext(createService()),
    )

    expect(await readFile(target, 'utf8')).toBe('Hello from the recording.\n')
    expect(result.artifacts?.[0]?.path).toBe(path.resolve(target))
    expect(result.data).toMatchObject({ outputWritten: true })
  })

  it('preserves an existing output and removes staging files when an overwrite fails', async () => {
    const target = path.join(dir, 'transcript.txt')
    await writeFileActual(target, 'previous transcript', 'utf8')
    writeFailure.code = 'ENOSPC'

    const result = await transcribeVideoOperation.run(
      { videoPath: source, outputPath: target, overwrite: true },
      createContext(createService()),
    )

    expect(await readFile(target, 'utf8')).toBe('previous transcript')
    expect(result.data).toMatchObject({ outputWritten: false })
    expect(result.warnings?.join(' ')).toContain('ENOSPC')
    expect(await readdir(dir)).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/^\.video-analyzer-/)]),
    )
  })
})
