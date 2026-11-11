import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { resolveMediaInput } from '../../src/services/mediaInput.js'

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), execFile: vi.fn() }))

vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
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
  const config = loadConfig({ YT_DLP_PATH: '/configured/downloader' })
  const privateConfig = loadConfig({
    YT_DLP_PATH: '/configured/downloader',
    VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS: 'true',
  })
  const smallLimitConfig = loadConfig({ VIDEO_ANALYZER_DOWNLOAD_MAX_MB: '1' })
  const fetchMock = vi.fn()

  beforeEach(() => {
    mocks.lookup.mockReset()
    mocks.execFile.mockReset()
    fetchMock.mockReset()
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
})
