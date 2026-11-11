import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { uploadIdentityFor } from '../../src/operations/shared.js'
import { GeminiMediaService, type GeminiApi } from '../../src/services/gemini.js'
import { resolveMediaInput } from '../../src/services/mediaInput.js'
import { createLogger } from '../../src/utils/logger.js'
import { downloadToFile } from '../../src/utils/net.js'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), execFile: vi.fn(), fetch: vi.fn() }))

vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: mocks.fetch,
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
}))

function withCredentials(rawUrl: string): string {
  const url = new URL(rawUrl)
  url.username = 'user'
  url.password = 'pass'
  return url.href
}

describe('remote media input policy', () => {
  // The legacy `YT_DLP_PATH` setting is ignored — it is no longer parsed at all —
  // so setting it here proves a configured downloader never changes the decision.
  const config = loadConfig({ YT_DLP_PATH: '/configured/downloader' })
  const privateConfig = loadConfig({
    YT_DLP_PATH: '/configured/downloader',
    VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS: 'true',
  })
  const smallLimitConfig = loadConfig({ VIDEO_ANALYZER_DOWNLOAD_MAX_MB: '1' })
  const fetchMock = mocks.fetch

  beforeEach(() => {
    mocks.lookup.mockReset()
    mocks.execFile.mockReset()
    fetchMock.mockReset()
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  })

  it('does not send a known platform page to the external downloader', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    )

    await expect(
      resolveMediaInput('https://www.youtube.com/watch?v=example', config),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it.each([config, privateConfig])(
    'rejects credentials on platform URLs even with opt-in',
    async (settings) => {
      await expect(
        resolveMediaInput(withCredentials('https://youtube.com/watch?v=example'), settings),
      ).rejects.toMatchObject({
        code: 'URL_REJECTED',
        message: expect.stringMatching(/credentials/),
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(mocks.execFile).not.toHaveBeenCalled()
    },
  )

  it('rejects platform hostnames resolving to private addresses', async () => {
    mocks.lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }])
    await expect(
      resolveMediaInput('https://youtube.com/watch?v=example', config),
    ).rejects.toMatchObject({
      code: 'URL_REJECTED',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it.each(['http://127.0.0.1/media', 'http://169.254.169.254/metadata', 'http://192.0.2.1/media'])(
    'rejects platform redirects to private or reserved destinations: %s',
    async (location) => {
      mocks.lookup.mockImplementation(async (hostname: string) => [
        {
          address: hostname === 'youtube.com' ? '8.8.8.8' : hostname,
          family: 4,
        },
      ])
      fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location } }))

      await expect(
        resolveMediaInput('https://youtube.com/watch?v=example', config),
      ).rejects.toMatchObject({
        code: 'URL_REJECTED',
      })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(mocks.execFile).not.toHaveBeenCalled()
    },
  )

  it.each([config, privateConfig])(
    'rejects credentials in redirect targets even with opt-in',
    async (settings) => {
      fetchMock.mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: withCredentials('https://example.com/media') },
        }),
      )
      await expect(
        resolveMediaInput('https://youtube.com/watch?v=example', settings),
      ).rejects.toMatchObject({
        code: 'URL_REJECTED',
        message: expect.stringMatching(/credentials/),
      })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(mocks.execFile).not.toHaveBeenCalled()
    },
  )

  it.each([config, privateConfig])(
    'does not fall back to the downloader after an HTML redirect',
    async (settings) => {
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/page' } }))
        .mockResolvedValueOnce(
          new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
        )
      await expect(resolveMediaInput('https://example.com/start', settings)).rejects.toMatchObject({
        code: 'UNSUPPORTED_INPUT',
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(mocks.execFile).not.toHaveBeenCalled()
    },
  )

  it('blocks private direct media by default and permits it with explicit opt-in', async () => {
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    await expect(resolveMediaInput('http://127.0.0.1/media.mp4', config)).rejects.toMatchObject({
      code: 'URL_REJECTED',
    })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValue(new Response('media', { headers: { 'content-type': 'video/mp4' } }))
    const media = await resolveMediaInput('http://127.0.0.1/media.mp4', privateConfig)
    try {
      expect(media.source).toBe('direct')
      expect(await readFile(media.path, 'utf8')).toBe('media')
    } finally {
      await media.cleanup()
    }
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('pins each redirect connection to its validated DNS result', async () => {
    const undici = await vi.importActual<typeof import('undici')>('undici')
    fetchMock.mockImplementation(undici.fetch)
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(`${request.headers.host}${request.url}`)
      if (request.url === '/start') {
        response.writeHead(302, { location: `http://second.example:${port}/media.mp4` })
        response.end()
      } else {
        response.writeHead(200, { 'content-type': 'video/mp4' })
        response.end('media')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const port = address.port
    mocks.lookup.mockReset()
    mocks.lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    mocks.lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.2', family: 4 }])
    try {
      const media = await resolveMediaInput(`http://first.example:${port}/start`, privateConfig)
      try {
        expect(await readFile(media.path, 'utf8')).toBe('media')
        expect(requests).toEqual([
          `first.example:${port}/start`,
          `second.example:${port}/media.mp4`,
        ])
        expect(mocks.lookup).toHaveBeenCalledTimes(2)
      } finally {
        await media.cleanup()
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('cancels a stalled DNS lookup without waiting for it', async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => undefined))
    const controller = new AbortController()
    const pending = downloadToFile('http://stalled.example/media.mp4', 'unused', {
      maxBytes: 100,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces the download timeout during redirect DNS validation', async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockImplementationOnce(() => new Promise(() => undefined))
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://stalled.example/media' } }),
    )
    await expect(
      downloadToFile('http://first.example/media', 'unused', { maxBytes: 100, timeoutMs: 30 }),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringContaining('did not finish within 30 ms'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies a pre-cancelled download before resolving its host', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      downloadToFile('http://127.0.0.1/media', 'unused', {
        maxBytes: 100,
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(mocks.lookup).not.toHaveBeenCalled()
  })

  it('permits a private redirect only with opt-in, without enabling HTML fallback', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/page' } }),
      )
      .mockResolvedValueOnce(
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      )
    await expect(
      resolveMediaInput('https://youtube.com/watch?v=example', privateConfig),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('rejects a remote image that omits its Content-Type', async () => {
    // A media extension is only a fallback; it must not turn an image into media.
    fetchMock.mockResolvedValue(new Response('image bytes'))

    await expect(resolveMediaInput('https://example.com/cover.jpg', config)).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
    })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('rejects a download whose declared length exceeds the configured limit', async () => {
    fetchMock.mockResolvedValue(
      new Response('media', {
        headers: { 'content-type': 'video/mp4', 'content-length': String(2 * 1024 * 1024) },
      }),
    )

    await expect(
      resolveMediaInput('https://example.com/media.mp4', smallLimitConfig),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringMatching(/exceeds the download size limit/),
    })
  })

  it('redacts the final URL when a downloaded media type is unknown', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
    await expect(
      resolveMediaInput('https://example.com/media?token=example-secret#private', config),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
      details: { url: 'https://example.com/media' },
    })
  })

  it('stops a download that outgrows the limit while streaming', async () => {
    // No Content-Length header, so only the streaming guard can catch this.
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array(2 * 1024 * 1024), {
        headers: { 'content-type': 'video/mp4' },
      }),
    )

    await expect(
      resolveMediaInput('https://example.com/media.mp4', smallLimitConfig),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringMatching(/exceeded the download size limit while streaming/),
    })
  })

  it('identifies a remote source stably across separate downloads', async () => {
    fetchMock.mockImplementation(
      async () => new Response('media', { headers: { 'content-type': 'video/mp4' } }),
    )

    const url = 'https://example.com/media.mp4'
    const first = await resolveMediaInput(url, config)
    const second = await resolveMediaInput(url, config)
    try {
      // Separate temp directories, same identity: this is what lets the upload
      // cache reuse a second call for the same URL.
      expect(first.path).not.toBe(second.path)
      expect(first.cacheKey).toBeDefined()
      expect(second.cacheKey).toBe(first.cacheKey)
    } finally {
      await first.cleanup()
      await second.cleanup()
    }
  })

  it('distinguishes changed same-length downloads, including concurrent uploads', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('AAAA', { headers: { 'content-type': 'video/mp4' } }))
      .mockResolvedValueOnce(new Response('BBBB', { headers: { 'content-type': 'video/mp4' } }))
    const first = await resolveMediaInput('https://example.com/media.mp4', config)
    const second = await resolveMediaInput('https://example.com/media.mp4', config)
    const uploaded: string[] = []
    const handle = { name: 'files/a', uri: 'file:a', mimeType: 'video/mp4', state: 'ACTIVE' }
    const api: GeminiApi = {
      uploadFile: async ({ path }) => {
        uploaded.push(await readFile(path, 'utf8'))
        return handle
      },
      getFile: async () => handle,
      generateContent: async () => '',
    }
    const service = new GeminiMediaService({ config, logger: createLogger('silent'), api })
    try {
      expect(first.cacheKey).not.toBe(second.cacheKey)
      for (const media of [first, second]) {
        await service.ensureUploaded({
          path: media.path,
          mimeType: media.mimeType,
          ...uploadIdentityFor(media),
        })
      }
      const concurrentService = new GeminiMediaService({
        config,
        logger: createLogger('silent'),
        api,
      })
      await Promise.all(
        [first, second].map(async (media) =>
          concurrentService.ensureUploaded({
            path: media.path,
            mimeType: media.mimeType,
            ...uploadIdentityFor(media),
          }),
        ),
      )
      expect(uploaded.toSorted()).toEqual(['AAAA', 'AAAA', 'BBBB', 'BBBB'])
    } finally {
      await first.cleanup()
      await second.cleanup()
    }
  })

  it('retains the leader download until a shared upload finishes after cancellation', async () => {
    fetchMock.mockImplementation(
      async () => new Response('media', { headers: { 'content-type': 'video/mp4' } }),
    )
    const first = await resolveMediaInput('https://example.com/media.mp4', config)
    const second = await resolveMediaInput('https://example.com/media.mp4', config)
    let releaseUpload!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve
    })
    const handle = { name: 'files/a', uri: 'file:a', mimeType: 'video/mp4', state: 'ACTIVE' }
    const api: GeminiApi = {
      uploadFile: async ({ path }) => {
        await gate
        expect(await readFile(path, 'utf8')).toBe('media')
        return handle
      },
      getFile: async () => handle,
      generateContent: async () => '',
    }
    const service = new GeminiMediaService({ config, logger: createLogger('silent'), api })
    const controller = new AbortController()
    try {
      const leader = service.ensureUploaded({
        path: first.path,
        mimeType: first.mimeType,
        ...uploadIdentityFor(first),
        signal: controller.signal,
      })
      const leaderResult = expect(leader).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
      const follower = service.ensureUploaded({
        path: second.path,
        mimeType: second.mimeType,
        ...uploadIdentityFor(second),
      })
      controller.abort()
      await leaderResult
      await first.cleanup()
      expect(await readFile(first.path, 'utf8')).toBe('media')
      releaseUpload()
      await expect(follower).resolves.toMatchObject({ state: 'ACTIVE' })
      await expect(readFile(first.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      releaseUpload()
      await first.cleanup()
      await second.cleanup()
    }
  })
})
