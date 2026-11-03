import { describe, expect, it, vi, type Mock } from 'vitest'
import { loadConfig } from '../../src/config.js'
import {
  GeminiMediaService,
  type GeminiApi,
  type GeminiFileHandle,
} from '../../src/services/gemini.js'
import { createLogger } from '../../src/utils/logger.js'

function handle(overrides: Partial<GeminiFileHandle> = {}): GeminiFileHandle {
  return {
    name: 'files/abc',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
    mimeType: 'video/mp4',
    state: 'ACTIVE',
    ...overrides,
  }
}

interface FakeApi {
  uploadFile: Mock
  getFile: Mock
  generateContent: Mock
}

function createFakeApi(
  options: {
    states?: string[]
    uploadError?: Error
    generated?: string
  } = {},
): FakeApi {
  const states = [...(options.states ?? ['ACTIVE'])]
  const uploadFile = vi.fn(async () => {
    if (options.uploadError) throw options.uploadError
    return handle({ state: states.shift() ?? 'ACTIVE' })
  })
  const getFile = vi.fn(async () => handle({ state: states.shift() ?? 'ACTIVE' }))
  const generateContent = vi.fn(async () => options.generated ?? 'model answer')

  return { uploadFile, getFile, generateContent } as unknown as FakeApi
}

function createService(api: FakeApi, overrides: { now?: () => number } = {}) {
  const config = loadConfig({})
  return new GeminiMediaService({
    config,
    logger: createLogger('silent'),
    api: api as unknown as GeminiApi,
    sleep: async () => undefined,
    ...overrides,
  })
}

const uploadParams = {
  path: '/media/demo.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 1024,
  mtimeMs: 1_700_000_000_000,
}

describe('GeminiMediaService', () => {
  it('uploads and returns an ACTIVE handle', async () => {
    const api = createFakeApi()
    const service = createService(api)

    const result = await service.ensureUploaded(uploadParams)

    expect(api.uploadFile).toHaveBeenCalledWith({ path: '/media/demo.mp4', mimeType: 'video/mp4' })
    expect(result.state).toBe('ACTIVE')
    expect(result.uri).toContain('files/abc')
  })

  it('polls while the file is PROCESSING and then succeeds', async () => {
    const api = createFakeApi({ states: ['PROCESSING', 'PROCESSING', 'ACTIVE'] })
    const service = createService(api)

    const result = await service.ensureUploaded(uploadParams)

    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(result.state).toBe('ACTIVE')
  })

  it('throws GEMINI_PROCESSING_FAILED when Gemini reports FAILED', async () => {
    const api = createFakeApi({ states: ['PROCESSING', 'FAILED'] })
    const service = createService(api)

    await expect(service.ensureUploaded(uploadParams)).rejects.toMatchObject({
      code: 'GEMINI_PROCESSING_FAILED',
    })
  })

  it('throws GEMINI_TIMEOUT when processing never completes', async () => {
    let clock = 0
    const api = createFakeApi({ states: ['PROCESSING'] })
    // Always PROCESSING.
    api.getFile.mockImplementation(async () => handle({ state: 'PROCESSING' }))
    const config = loadConfig({ VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS: '1000' })
    const service = new GeminiMediaService({
      config,
      logger: createLogger('silent'),
      api,
      sleep: async () => {
        clock += 400
      },
      now: () => clock,
    })

    await expect(service.ensureUploaded(uploadParams)).rejects.toMatchObject({
      code: 'GEMINI_TIMEOUT',
    })
  })

  it('maps an upload rejection to GEMINI_UPLOAD_FAILED', async () => {
    const api = createFakeApi({ uploadError: new Error('quota') })
    const service = createService(api)

    await expect(service.ensureUploaded(uploadParams)).rejects.toMatchObject({
      code: 'GEMINI_UPLOAD_FAILED',
    })
  })

  it('reuses a still-ACTIVE cached upload', async () => {
    const api = createFakeApi()
    const service = createService(api)

    await service.ensureUploaded(uploadParams)
    api.getFile.mockResolvedValueOnce(handle({ state: 'ACTIVE' }))
    await service.ensureUploaded(uploadParams)

    expect(api.uploadFile).toHaveBeenCalledTimes(1)
  })

  it('re-uploads when the cached file is no longer ACTIVE', async () => {
    const api = createFakeApi()
    const service = createService(api)

    await service.ensureUploaded(uploadParams)
    api.getFile.mockResolvedValueOnce(handle({ state: 'FAILED' }))
    await service.ensureUploaded(uploadParams)

    expect(api.uploadFile).toHaveBeenCalledTimes(2)
  })

  it('treats a different size as a different source', async () => {
    const api = createFakeApi()
    const service = createService(api)

    await service.ensureUploaded(uploadParams)
    await service.ensureUploaded({ ...uploadParams, sizeBytes: 2048 })

    expect(api.uploadFile).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent uploads of the same file', async () => {
    const api = createFakeApi()
    const service = createService(api)

    const [a, b, c] = await Promise.all([
      service.ensureUploaded(uploadParams),
      service.ensureUploaded(uploadParams),
      service.ensureUploaded(uploadParams),
    ])

    expect(api.uploadFile).toHaveBeenCalledTimes(1)
    expect(a.name).toBe(b.name)
    expect(b.name).toBe(c.name)
  })

  it('sends the file part plus the prompt', async () => {
    const api = createFakeApi({ generated: 'the answer' })
    const service = createService(api)

    const text = await service.generateWithFile({
      ...uploadParams,
      prompt: 'What happens?',
      systemInstruction: 'be precise',
    })

    expect(text).toBe('the answer')
    const call = api.generateContent.mock.calls[0]?.[0] as {
      model: string
      parts: Array<{ kind: string }>
      systemInstruction?: string
    }
    expect(call.model).toBe(loadConfig({}).geminiModel)
    expect(call.parts.map((part) => part.kind)).toEqual(['file', 'text'])
    expect(call.systemInstruction).toBe('be precise')
  })

  it('wraps request failures as GEMINI_REQUEST_FAILED', async () => {
    const api = createFakeApi()
    api.generateContent.mockRejectedValue(new Error('boom'))
    const service = createService(api)

    await expect(service.generate({ parts: [{ kind: 'text', text: 'hi' }] })).rejects.toMatchObject(
      { code: 'GEMINI_REQUEST_FAILED' },
    )
  })

  it('honours the configured model', async () => {
    const api = createFakeApi()
    const service = new GeminiMediaService({
      config: loadConfig({ GEMINI_MODEL: 'gemini-test-model' }),
      logger: createLogger('silent'),
      api,
      sleep: async () => undefined,
    })

    await service.generate({ parts: [{ kind: 'text', text: 'hi' }] })

    const call = api.generateContent.mock.calls[0]?.[0] as { model: string }
    expect(call.model).toBe('gemini-test-model')
  })
})
