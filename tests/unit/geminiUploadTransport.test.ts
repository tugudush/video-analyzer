import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { GeminiMediaService, GoogleGenAiApi } from '../../src/services/gemini.js'
import { createLogger } from '../../src/utils/logger.js'

/**
 * These tests drive the real `@google/genai` client through an injected fetch,
 * because the SDK reconstructs the upload request internally. Doubles that
 * replace `files.upload` cannot see a lost upload URL or missing protocol
 * headers, or whether a caller's abort reaches the transfer.
 */
interface RecordedCall {
  url: string
  headers: Headers
  signal: AbortSignal | undefined
}

const UPLOAD_URL = 'https://upload.example/upload'
const FILE = {
  name: 'files/abc',
  uri: 'https://example.invalid/files/abc',
  state: 'ACTIVE',
  mimeType: 'video/mp4',
}

function initResponse(): Response {
  return new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-goog-upload-url': UPLOAD_URL },
  })
}

function uploadResponse(): Response {
  return new Response(JSON.stringify({ file: FILE }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-goog-upload-status': 'final' },
  })
}

describe('GoogleGenAiApi upload transport', () => {
  let dir: string
  let media: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-sdk-upload-'))
    media = path.join(dir, 'sample.mp4')
    await writeFile(media, 'sample')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps the resumable-upload URL and protocol headers', async () => {
    const calls: RecordedCall[] = []
    const api = new GoogleGenAiApi('test-key', {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        calls.push({
          url: url.href,
          headers: new Headers(init?.headers),
          signal: init?.signal ?? undefined,
        })
        return url.pathname === '/upload/v1beta/files' ? initResponse() : uploadResponse()
      },
    })

    const uploaded = await api.uploadFile({ path: media, mimeType: 'video/mp4', timeoutMs: 5_000 })

    expect(uploaded.state).toBe('ACTIVE')
    const init = calls[0]
    expect(init?.url).toBe('https://generativelanguage.googleapis.com/upload/v1beta/files')
    expect(init?.headers.get('x-goog-upload-protocol')).toBe('resumable')
    expect(init?.headers.get('x-goog-upload-command')).toBe('start')
    expect(init?.headers.get('x-goog-upload-header-content-type')).toBe('video/mp4')
    expect(init?.headers.get('x-goog-upload-header-content-length')).toBe('6')
    expect(calls[1]?.headers.get('x-goog-upload-command')).toBe('upload, finalize')
  })

  it('aborts the chunk transfer when the caller cancels', async () => {
    let chunkSignal: AbortSignal | undefined
    const api = new GoogleGenAiApi('test-key', {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname === '/upload/v1beta/files') return initResponse()
        const signal = init?.signal ?? undefined
        chunkSignal = signal
        return await new Promise<Response>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('The SDK did not forward a cancellation signal.'))
            return
          }
          if (signal.aborted) {
            reject(signal.reason)
            return
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
    const service = new GeminiMediaService({
      config: loadConfig({}),
      logger: createLogger('silent'),
      api,
    })
    const controller = new AbortController()

    const pending = service.ensureUploaded({
      path: media,
      mimeType: 'video/mp4',
      sizeBytes: 6,
      mtimeMs: 0,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(chunkSignal).toBeDefined())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(chunkSignal?.aborted).toBe(true)
  })

  it('aborts the chunk transfer when the upload deadline expires', async () => {
    let chunkSignal: AbortSignal | undefined
    const api = new GoogleGenAiApi('test-key', {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname === '/upload/v1beta/files') return initResponse()
        const signal = init?.signal ?? undefined
        chunkSignal = signal
        return await new Promise<Response>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('The SDK did not forward a cancellation signal.'))
            return
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })

    const pending = api.uploadFile({ path: media, mimeType: 'video/mp4', timeoutMs: 100 })
    await vi.waitFor(() => expect(chunkSignal).toBeDefined())

    await expect(pending).rejects.toThrow()
    expect(chunkSignal?.aborted).toBe(true)
  })
})
