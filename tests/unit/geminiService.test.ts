import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig } from '../../src/config.js'
import {
  GeminiMediaService,
  GoogleGenAiApi,
  type GeminiApi,
  type GeminiFileHandle,
} from '../../src/services/gemini.js'
import { createLogger } from '../../src/utils/logger.js'
import { FileUploadReferenceStore } from '../../src/services/uploadCache.js'

const sdk = vi.hoisted(() => ({ generateContent: vi.fn() }))

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: sdk.generateContent }
  },
}))

describe('GoogleGenAiApi response completion', () => {
  const params = { model: 'test', parts: [{ kind: 'text' as const, text: 'transcribe' }] }

  it('returns a normally completed response', async () => {
    sdk.generateContent.mockResolvedValueOnce({
      text: 'complete transcript',
      candidates: [{ finishReason: 'STOP' }],
    })
    await expect(new GoogleGenAiApi('test').generateContent(params)).resolves.toBe(
      'complete transcript',
    )
  })

  it.each(['MAX_TOKENS', 'SAFETY', undefined])(
    'rejects partial text with finish reason %s',
    async (finishReason) => {
      sdk.generateContent.mockResolvedValueOnce({
        text: 'partial transcript',
        candidates: [{ finishReason }],
      })
      await expect(new GoogleGenAiApi('test').generateContent(params)).rejects.toMatchObject({
        code: 'GEMINI_REQUEST_FAILED',
        details: { finishReason: finishReason ?? 'UNSPECIFIED' },
      })
    },
  )
})

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

/** A service backed by an on-disk reference store, for persistence tests. */
function serviceWithStore(api: FakeApi, store: FileUploadReferenceStore) {
  return new GeminiMediaService({
    config: loadConfig({}),
    logger: createLogger('silent'),
    api: api as unknown as GeminiApi,
    sleep: async () => undefined,
    store,
  })
}

const uploadParams = {
  path: '/media/demo.mp4',
  mimeType: 'video/mp4',
  cacheKey: 'content:demo',
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

  it('does not reuse a mutable local file after a same-size rewrite with preserved mtime', async () => {
    const api = createFakeApi()
    const service = createService(api)
    const dir = await mkdtemp(path.join(tmpdir(), 'va-upload-'))
    const file = path.join(dir, 'sample.mp4')
    const uploaded: string[] = []
    api.uploadFile.mockImplementation(async ({ path: source }: { path: string }) => {
      uploaded.push(await readFile(source, 'utf8'))
      return handle()
    })
    try {
      const mtime = new Date('2023-11-14T22:13:20Z')
      const params = { path: file, mimeType: 'video/mp4' }
      await writeFile(file, 'AAAA')
      await utimes(file, mtime, mtime)
      await service.ensureUploaded(params)
      await writeFile(file, 'BBBB')
      await utimes(file, mtime, mtime)
      await service.ensureUploaded(params)
      expect(uploaded).toEqual(['AAAA', 'BBBB'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not coalesce concurrent uploads without a content identity', async () => {
    const api = createFakeApi()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    api.uploadFile.mockImplementation(async () => {
      await gate
      return handle()
    })
    const service = createService(api)
    const { cacheKey: _cacheKey, ...local } = uploadParams
    const uploads = Promise.all([service.ensureUploaded(local), service.ensureUploaded(local)])
    expect(api.uploadFile).toHaveBeenCalledTimes(2)
    release()
    await uploads
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

  it('clears the poll timer when the last shared-upload waiter cancels', async () => {
    vi.useFakeTimers()
    const api = createFakeApi({ states: ['PROCESSING'] })
    const service = new GeminiMediaService({
      config: loadConfig({ VIDEO_ANALYZER_POLL_INTERVAL_MS: '10000' }),
      logger: createLogger('silent'),
      api,
    })
    const first = new AbortController()
    const second = new AbortController()
    const leader = service.ensureUploaded({ ...uploadParams, signal: first.signal })
    const follower = service.ensureUploaded({ ...uploadParams, signal: second.signal })
    const leaderResult = expect(leader).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    const followerResult = expect(follower).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })

    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    first.abort()
    await leaderResult
    expect(vi.getTimerCount()).toBe(1)
    second.abort()
    await followerResult
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(api.getFile).not.toHaveBeenCalled()
  })

  it('clears the poll timer for a cancelled non-shared local upload', async () => {
    vi.useFakeTimers()
    const api = createFakeApi({ states: ['PROCESSING'] })
    const service = new GeminiMediaService({
      config: loadConfig({}),
      logger: createLogger('silent'),
      api,
    })
    const controller = new AbortController()
    const { cacheKey: _cacheKey, ...localUpload } = uploadParams
    const pending = service.ensureUploaded({ ...localUpload, signal: controller.signal })
    const result = expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    controller.abort()
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls normally after the default delay completes', async () => {
    vi.useFakeTimers()
    const api = createFakeApi({ states: ['PROCESSING', 'ACTIVE'] })
    const service = new GeminiMediaService({
      config: loadConfig({ VIDEO_ANALYZER_POLL_INTERVAL_MS: '1000' }),
      logger: createLogger('silent'),
      api,
    })
    const pending = service.ensureUploaded(uploadParams)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toMatchObject({ state: 'ACTIVE' })
    expect(api.getFile).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
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

  it('aborts an upload when its last waiter cancels and allows a retry', async () => {
    const api = createFakeApi()
    api.uploadFile.mockImplementationOnce(() => new Promise<GeminiFileHandle>(() => undefined))
    const service = createServiceWith(api)
    const controller = new AbortController()
    const pending = service.ensureUploaded({ ...uploadParams, signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    controller.abort()
    await assertion
    const firstCall = api.uploadFile.mock.calls[0]?.[0] as { signal: AbortSignal }
    expect(firstCall.signal.aborted).toBe(true)
    await expect(service.ensureUploaded(uploadParams)).resolves.toMatchObject({ state: 'ACTIVE' })
    expect(api.uploadFile).toHaveBeenCalledTimes(2)
  })
})
describe('persistent upload references', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-persist-'))
  })

  afterEach(async () => {
    // Writes are debounced; give an in-flight flush a moment to finish before
    // the directory is removed.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  async function openStore() {
    const store = new FileUploadReferenceStore({
      dir,
      scope: 'scope-a',
      logger: createLogger('silent'),
    })
    await store.ready
    return store
  }

  it('reuses a reference persisted by an earlier process', async () => {
    const firstApi = createFakeApi()
    const firstStore = await openStore()
    await serviceWithStore(firstApi, firstStore).ensureUploaded(uploadParams)
    await firstStore.flush()
    expect(firstApi.uploadFile).toHaveBeenCalledTimes(1)

    const secondApi = createFakeApi()
    const secondStore = await openStore()
    await serviceWithStore(secondApi, secondStore).ensureUploaded(uploadParams)

    expect(secondApi.uploadFile).not.toHaveBeenCalled()
    expect(secondApi.getFile).toHaveBeenCalled()
  })

  it('re-uploads and drops the reference when the stored file is gone', async () => {
    const firstStore = await openStore()
    await serviceWithStore(createFakeApi(), firstStore).ensureUploaded(uploadParams)
    await firstStore.flush()

    const secondApi = createFakeApi()
    secondApi.getFile.mockResolvedValue(handle({ state: 'FAILED' }))
    const secondStore = await openStore()
    await serviceWithStore(secondApi, secondStore).ensureUploaded(uploadParams)

    expect(secondApi.uploadFile).toHaveBeenCalledTimes(1)
    expect(secondApi.getFile).toHaveBeenCalled()
  })

  it('drops a reference whose MIME type no longer matches', async () => {
    const firstStore = await openStore()
    await serviceWithStore(createFakeApi(), firstStore).ensureUploaded(uploadParams)
    await firstStore.flush()

    const secondApi = createFakeApi()
    secondApi.getFile.mockResolvedValue(handle({ mimeType: 'audio/mpeg' }))
    const secondStore = await openStore()
    await serviceWithStore(secondApi, secondStore).ensureUploaded(uploadParams)

    expect(secondApi.uploadFile).toHaveBeenCalledTimes(1)
  })

  it('keeps using the in-memory path when the store is absent', async () => {
    const api = createFakeApi()
    const service = createService(api)
    await service.ensureUploaded(uploadParams)
    await service.ensureUploaded(uploadParams)
    expect(api.uploadFile).toHaveBeenCalledTimes(1)
  })
})
describe('GoogleGenAiApi file parts', () => {
  const base = { model: 'test', parts: [{ kind: 'text' as const, text: 'hi' }] }

  it('omits mimeType for a typed-less file reference', async () => {
    sdk.generateContent.mockResolvedValueOnce({
      text: 'ok',
      candidates: [{ finishReason: 'STOP' }],
    })
    await new GoogleGenAiApi('test').generateContent({
      ...base,
      parts: [{ kind: 'file', fileUri: 'https://www.youtube.com/watch?v=a' }],
    })
    const request = sdk.generateContent.mock.calls.at(-1)?.[0] as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>
    }
    expect(request.contents[0]?.parts[0]).toEqual({
      fileData: { fileUri: 'https://www.youtube.com/watch?v=a' },
    })
  })

  it('sends mimeType alongside a hint that has one', async () => {
    sdk.generateContent.mockResolvedValueOnce({
      text: 'ok',
      candidates: [{ finishReason: 'STOP' }],
    })
    await new GoogleGenAiApi('test').generateContent({
      ...base,
      parts: [{ kind: 'file', fileUri: 'https://cdn.test/clip.mp4', mimeType: 'video/mp4' }],
    })
    const request = sdk.generateContent.mock.calls.at(-1)?.[0] as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>
    }
    expect(request.contents[0]?.parts[0]).toEqual({
      fileData: { fileUri: 'https://cdn.test/clip.mp4', mimeType: 'video/mp4' },
    })
  })
})
