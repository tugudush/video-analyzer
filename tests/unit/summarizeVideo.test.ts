import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { executeOperation } from '../../src/operations/execute.js'
import { TIMESTAMP_ESTIMATE_WARNING } from '../../src/operations/shared.js'
import { summarizeVideoOperation } from '../../src/operations/summarizeVideo.js'
import { GeminiMediaService, type GeminiApi } from '../../src/services/gemini.js'
import { createLogger } from '../../src/utils/logger.js'

vi.mock('../../src/services/ffmpeg.js', () => ({
  getMediaMetadata: vi.fn(async () => ({
    durationSeconds: 1.25,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    sizeBytes: 4096,
    bitRate: 32000,
    hasVideo: true,
    hasAudio: true,
    video: undefined,
    audio: undefined,
  })),
}))

function createFakeService(): GeminiMediaService {
  const handle = {
    name: 'files/abc',
    uri: 'https://generativelanguage.test/v1beta/files/abc',
    mimeType: 'video/mp4',
    state: 'ACTIVE',
  }
  const api = {
    uploadFile: vi.fn(async () => handle),
    getFile: vi.fn(async () => handle),
    generateContent: vi.fn(async () => 'Overview: a short test clip.'),
  }
  return new GeminiMediaService({
    config: loadConfig({}),
    logger: createLogger('silent'),
    api: api as unknown as GeminiApi,
    sleep: async () => undefined,
  })
}

describe('summarize_video envelope', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-summarize-'))
    source = path.join(dir, 'sample.mp4')
    await writeFile(source, 'media bytes', 'utf8')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /**
   * The prompt asks the model for approximate timestamps, so the envelope has to
   * say the same thing every other timestamp-bearing operation does.
   */
  it('warns that reported timestamps are estimates', async () => {
    const config = loadConfig({})

    const result = await executeOperation(summarizeVideoOperation, { videoPath: source }, config, {
      geminiService: createFakeService(),
    })

    expect(result.summary).toBe('Overview: a short test clip.')
    expect(result.warnings).toContain(TIMESTAMP_ESTIMATE_WARNING)
  })
})
