import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
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

function createServiceWith(api: FakeApi, env: Record<string, string> = {}) {
  return new GeminiMediaService({
    config: loadConfig(env),
    logger: createLogger('silent'),
    api: api as unknown as GeminiApi,
    sleep: async () => undefined,
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

    expect(api.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/media/demo.mp4', mimeType: 'video/mp4' }),
    )
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

  it('reuses one upload when a stable cache key identifies the source', async () => {
    const api = createFakeApi()
    const service = createService(api)
    const cacheKey = 'direct:https://example.com/talk.mp4:1024'

    // A direct download lands in a new temp directory on every call, so only the
    // supplied identity can recognise that both paths hold the same bytes.
    await service.ensureUploaded({ ...uploadParams, path: '/tmp/run-a/source.media', cacheKey })
    api.getFile.mockResolvedValueOnce(handle({ state: 'ACTIVE' }))
    await service.ensureUploaded({ ...uploadParams, path: '/tmp/run-b/source.media', cacheKey })

    expect(api.uploadFile).toHaveBeenCalledTimes(1)
  })

  it('keeps differently identified sources apart even at the same size', async () => {
    const api = createFakeApi()
    const service = createService(api)

    await service.ensureUploaded({ ...uploadParams, cacheKey: 'direct:https://example.com/a.mp4' })
    await service.ensureUploaded({ ...uploadParams, cacheKey: 'direct:https://example.com/b.mp4' })

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

describe('GeminiMediaService timeouts and cancellation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives every Gemini call a signal and a deadline', async () => {
    const api = createFakeApi({ states: ['PROCESSING', 'ACTIVE'] })
    const service = createServiceWith(api)

    await service.generateWithFile({ ...uploadParams, prompt: 'hi' })

    const upload = api.uploadFile.mock.calls[0]?.[0] as {
      signal?: AbortSignal
      timeoutMs?: number
    }
    expect(upload.signal).toBeInstanceOf(AbortSignal)
    expect(upload.timeoutMs).toBeGreaterThan(0)

    const status = api.getFile.mock.calls[0]?.[1] as { signal?: AbortSignal; timeoutMs?: number }
    expect(status.signal).toBeInstanceOf(AbortSignal)
    expect(status.timeoutMs).toBeGreaterThan(0)

    const generation = api.generateContent.mock.calls[0]?.[0] as {
      signal?: AbortSignal
      timeoutMs?: number
    }
    expect(generation.signal).toBeInstanceOf(AbortSignal)
    expect(generation.timeoutMs).toBe(loadConfig({}).requestTimeoutMs)
  })

  it('fails a stalled generation once the request timeout elapses', async () => {
    vi.useFakeTimers()
    const api = createFakeApi()
    api.generateContent.mockImplementation(() => new Promise<string>(() => undefined))
    const service = createServiceWith(api, { VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: '30000' })

    const pending = service.generate({ parts: [{ kind: 'text', text: 'hi' }] })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'GEMINI_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(30_000)
    await assertion

    // The deadline, not only the caller, has to tear down the request itself.
    const call = api.generateContent.mock.calls[0]?.[0] as { signal: AbortSignal }
    expect(call.signal.aborted).toBe(true)
  })

  it('rejects an in-flight generation as soon as the caller cancels', async () => {
    const api = createFakeApi()
    api.generateContent.mockImplementation(() => new Promise<string>(() => undefined))
    const service = createServiceWith(api)
    const controller = new AbortController()

    const pending = service.generate({
      parts: [{ kind: 'text', text: 'hi' }],
      signal: controller.signal,
    })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    controller.abort()
    await assertion

    // The cancellation also reaches the SDK so the HTTP request is torn down.
    const call = api.generateContent.mock.calls[0]?.[0] as { signal: AbortSignal }
    expect(call.signal.aborted).toBe(true)
  })

  it('never calls Gemini when the signal is already aborted', async () => {
    const api = createFakeApi()
    const service = createServiceWith(api)
    const controller = new AbortController()
    controller.abort()

    await expect(
      service.ensureUploaded({ ...uploadParams, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await expect(
      service.generate({ parts: [{ kind: 'text', text: 'hi' }], signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    expect(api.uploadFile).not.toHaveBeenCalled()
    expect(api.generateContent).not.toHaveBeenCalled()
  })

  it('abandons a stalled upload instead of waiting for it', async () => {
    const api = createFakeApi()
    api.uploadFile.mockImplementation(() => new Promise<GeminiFileHandle>(() => undefined))
    const service = createServiceWith(api)
    const controller = new AbortController()

    const pending = service.ensureUploaded({ ...uploadParams, signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    controller.abort()
    await assertion

    expect(api.getFile).not.toHaveBeenCalled()
  })

  it('bounds a stalled status request with the request timeout', async () => {
    vi.useFakeTimers()
    const api = createFakeApi({ states: ['PROCESSING'] })
    api.getFile.mockImplementation(() => new Promise<GeminiFileHandle>(() => undefined))
    const service = createServiceWith(api, { VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: '5000' })

    const pending = service.ensureUploaded(uploadParams)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'GEMINI_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })

  it('counts upload time against the processing deadline', async () => {
    let clock = 0
    const api = createFakeApi({ states: ['PROCESSING'] })
    api.uploadFile.mockImplementation(async () => {
      clock += 900 // almost the whole budget is already gone before polling starts
      return handle({ state: 'PROCESSING' })
    })
    const service = new GeminiMediaService({
      config: loadConfig({ VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS: '1000' }),
      logger: createLogger('silent'),
      api: api as unknown as GeminiApi,
      sleep: async () => {
        clock += 200
      },
      now: () => clock,
    })

    await expect(service.ensureUploaded(uploadParams)).rejects.toMatchObject({
      code: 'GEMINI_TIMEOUT',
      details: { timeoutMs: 1000 },
    })
    expect(api.getFile).not.toHaveBeenCalled()
  })

  it('surfaces a status timeout instead of re-uploading the cached file', async () => {
    vi.useFakeTimers()
    const api = createFakeApi({ states: ['ACTIVE'] })
    const service = createServiceWith(api, { VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: '5000' })
    await service.ensureUploaded(uploadParams)
    expect(api.uploadFile).toHaveBeenCalledTimes(1)

    api.getFile.mockImplementation(() => new Promise<GeminiFileHandle>(() => undefined))
    const pending = service.ensureUploaded(uploadParams)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'GEMINI_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(5_000)
    await assertion

    expect(api.uploadFile).toHaveBeenCalledTimes(1)
  })

  it('keeps a shared upload alive when the caller that started it cancels', async () => {
    const api = createFakeApi()
    let release: ((uploaded: GeminiFileHandle) => void) | undefined
    const upload = new Promise<GeminiFileHandle>((resolve) => {
      release = resolve
    })
    api.uploadFile.mockReturnValue(upload)
    const service = createServiceWith(api)
    const controller = new AbortController()

    const leader = service.ensureUploaded({ ...uploadParams, signal: controller.signal })
    const leaderAssertion = expect(leader).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
      message: 'The operation was cancelled.',
    })
    const follower = service.ensureUploaded(uploadParams)

    controller.abort()
    await leaderAssertion

    // The shared request is not the leader's to cancel.
    const call = api.uploadFile.mock.calls[0]?.[0] as { signal: AbortSignal }
    expect(call.signal.aborted).toBe(false)

    release?.(handle())
    await expect(follower).resolves.toMatchObject({ state: 'ACTIVE' })
    expect(api.uploadFile).toHaveBeenCalledTimes(1)
  })
})
