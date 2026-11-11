import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { transcribeVideoOperation } from '../../src/operations/transcribeVideo.js'
import { GeminiMediaService, type GeminiApi } from '../../src/services/gemini.js'
import { createLogger } from '../../src/utils/logger.js'
import type { OperationContext } from '../../src/operations/types.js'

// ffprobe is not required for these tests: the operation only needs metadata,
// and the alias/overwrite rules are unrelated to the probe result.
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

const SOURCE_BYTES = 'original media bytes that must never be truncated'
const TRANSCRIPT = 'Hello from the recording.'

interface FakeGemini {
  api: { uploadFile: ReturnType<typeof vi.fn>; generateContent: ReturnType<typeof vi.fn> }
  service: GeminiMediaService
}

function createFakeGemini(transcript = TRANSCRIPT): FakeGemini {
  const handle = {
    name: 'files/abc',
    uri: 'https://generativelanguage.test/v1beta/files/abc',
    mimeType: 'video/mp4',
    state: 'ACTIVE',
  }
  const api = {
    uploadFile: vi.fn(async () => handle),
    getFile: vi.fn(async () => handle),
    generateContent: vi.fn(async () => transcript),
  }
  const service = new GeminiMediaService({
    config: loadConfig({}),
    logger: createLogger('silent'),
    api: api as unknown as GeminiApi,
    sleep: async () => undefined,
  })
  return { api, service }
}

function createContext(service: GeminiMediaService): OperationContext {
  return { config: loadConfig({}), logger: createLogger('silent'), geminiService: service }
}

describe('transcribe_video output target', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-transcribe-'))
    source = path.join(dir, 'sample.mp4')
    await writeFile(source, SOURCE_BYTES, 'utf8')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses to write the transcript over the source media', async () => {
    const { api, service } = createFakeGemini()

    await expect(
      transcribeVideoOperation.run(
        { videoPath: source, outputPath: source },
        createContext(service),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(await readFile(source, 'utf8')).toBe(SOURCE_BYTES)
    expect(api.uploadFile).not.toHaveBeenCalled()
  })

  it('refuses an alias reached through a file:// source URI', async () => {
    const { api, service } = createFakeGemini()

    await expect(
      transcribeVideoOperation.run(
        { videoPath: pathToFileURL(source).href, outputPath: path.resolve(source) },
        createContext(service),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(await readFile(source, 'utf8')).toBe(SOURCE_BYTES)
    expect(api.uploadFile).not.toHaveBeenCalled()
  })

  it('refuses an alias that spells the path differently', async () => {
    const { service } = createFakeGemini()
    const alias = path.join(dir, 'nested', '..', 'sample.mp4')

    await expect(
      transcribeVideoOperation.run(
        { videoPath: source, outputPath: alias },
        createContext(service),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(await readFile(source, 'utf8')).toBe(SOURCE_BYTES)
  })

  it('refuses a symlink that points at the source media', async (context) => {
    const alias = path.join(dir, 'alias.mp4')
    try {
      await symlink(source, alias, 'file')
    } catch {
      context.skip() // Symlinks need privileges on Windows.
      return
    }

    const { service } = createFakeGemini()
    await expect(
      transcribeVideoOperation.run(
        { videoPath: source, outputPath: alias },
        createContext(service),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(await readFile(source, 'utf8')).toBe(SOURCE_BYTES)
  })

  it('refuses a hard link to the source media', async (context) => {
    const alias = path.join(dir, 'hardlink.mp4')
    try {
      await link(source, alias)
    } catch {
      context.skip() // Hard links are unavailable on some filesystems.
      return
    }

    const { service } = createFakeGemini()
    await expect(
      transcribeVideoOperation.run(
        { videoPath: source, outputPath: alias },
        createContext(service),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(await readFile(source, 'utf8')).toBe(SOURCE_BYTES)
  })

  it('refuses to overwrite an existing file unless overwrite is set', async () => {
    const existing = path.join(dir, 'transcript.txt')
    await writeFile(existing, 'previous run\n', 'utf8')
    const { api, service } = createFakeGemini()

    await expect(
      transcribeVideoOperation.run(
        { videoPath: source, outputPath: existing },
        createContext(service),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(await readFile(existing, 'utf8')).toBe('previous run\n')
    expect(api.uploadFile).not.toHaveBeenCalled()
  })

  it('replaces an existing file when overwrite is true', async () => {
    const existing = path.join(dir, 'transcript.txt')
    await writeFile(existing, 'previous run\n', 'utf8')
    const { service } = createFakeGemini()

    const result = await transcribeVideoOperation.run(
      { videoPath: source, outputPath: existing, overwrite: true },
      createContext(service),
    )

    expect(await readFile(existing, 'utf8')).toBe(`${TRANSCRIPT}\n`)
    expect(result.artifacts).toEqual([
      { path: path.resolve(existing), kind: 'transcript', mimeType: 'text/plain' },
    ])
    expect(await readFile(source, 'utf8')).toBe(SOURCE_BYTES)
  })

  it('writes a new transcript next to the media', async () => {
    const target = path.join(dir, 'transcript.txt')
    const { service } = createFakeGemini()

    const result = await transcribeVideoOperation.run(
      { videoPath: source, outputPath: target },
      createContext(service),
    )

    expect(await readFile(target, 'utf8')).toBe(`${TRANSCRIPT}\n`)
    expect(result.summary).toBe(TRANSCRIPT)
    expect(await stat(source).then((info) => info.isFile())).toBe(true)
  })

  it('creates missing parent directories for the transcript', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'transcript.txt')
    const { service } = createFakeGemini()

    const result = await transcribeVideoOperation.run(
      { videoPath: source, outputPath: target },
      createContext(service),
    )

    expect(await readFile(target, 'utf8')).toBe(`${TRANSCRIPT}\n`)
    expect(result.artifacts?.[0]?.path).toBe(path.resolve(target))
  })

  it('accepts a file:// URI as the output target', async () => {
    const target = path.join(dir, 'from-uri.txt')
    const { service } = createFakeGemini()

    await transcribeVideoOperation.run(
      { videoPath: source, outputPath: pathToFileURL(target).href },
      createContext(service),
    )

    expect(await readFile(target, 'utf8')).toBe(`${TRANSCRIPT}\n`)
  })

  it('refuses an alias reached through a symlinked directory', async (context) => {
    const linkDir = path.join(dir, 'dir-link')
    try {
      // A junction is a directory link that needs no elevation on Windows and is
      // ignored on POSIX, so the alias check is covered where it matters most.
      await symlink(dir, linkDir, 'junction')
    } catch {
      context.skip() // Directory links are unavailable on this platform.
      return
    }

    const { service } = createFakeGemini()
    await expect(
      transcribeVideoOperation.run(
        { videoPath: source, outputPath: path.join(linkDir, 'sample.mp4') },
        createContext(service),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(await readFile(source, 'utf8')).toBe(SOURCE_BYTES)
  })

  it('rejects an output target that is a directory', async () => {
    const { service } = createFakeGemini()

    await expect(
      transcribeVideoOperation.run({ videoPath: source, outputPath: dir }, createContext(service)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
