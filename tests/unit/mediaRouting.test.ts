import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import {
  GEMINI_DIRECT_URL_MAX_BYTES,
  classifyAiInput,
  isYouTubeUrl,
  probeDirectMediaUrl,
} from '../../src/services/mediaRouting.js'

const network = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: network.fetch }
})

/**
 * The probe must never reach a real network, and host validation is exercised
 * through `assertSafeHttpUrl`, so only that boundary is stubbed here.
 */
vi.mock('../../src/utils/net.js', () => ({
  assertSafeHttpUrl: vi.fn(async (raw: string) => new URL(raw)),
  redactedUrl: (url: URL) => url.href,
}))

interface FakeResponse {
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  body?: { cancel(): Promise<void> }
}

function response(
  status: number,
  headers: Record<string, string> = {},
  options: { body?: boolean } = {},
): FakeResponse {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
    ...(options.body === false ? {} : { body: { cancel: async () => undefined } }),
  }
}

afterEach(() => {
  network.fetch.mockReset()
})

describe('isYouTubeUrl', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc123',
    'https://youtube.com/watch?v=abc123',
    'https://m.youtube.com/watch?v=abc123',
    'https://youtu.be/abc123',
    'https://www.youtube-nocookie.com/embed/abc123',
  ])('accepts %s', (url) => {
    expect(isYouTubeUrl(url)).toBe(true)
  })

  it.each([
    'https://notyoutube.com/watch?v=abc',
    'https://youtube.com.evil.test/watch?v=abc',
    'https://evil.test/?next=youtube.com',
    'https://www.youtube.com:8443/watch?v=abc',
    'ftp://youtube.com/watch?v=abc',
    './local-video.mp4',
  ])('rejects %s', (value) => {
    expect(isYouTubeUrl(value)).toBe(false)
  })

  it('rejects a URL carrying credentials', () => {
    expect(isYouTubeUrl('https://user:pass@www.youtube.com/watch?v=abc')).toBe(false)
  })
})

describe('probeDirectMediaUrl', () => {
  it('accepts a public media URL at the documented limit', async () => {
    network.fetch.mockResolvedValueOnce(
      response(200, {
        'content-type': 'video/mp4',
        'content-length': String(GEMINI_DIRECT_URL_MAX_BYTES),
      }),
    )

    await expect(probeDirectMediaUrl('https://cdn.test/clip.mp4', loadConfig({}))).resolves.toEqual(
      {
        url: 'https://cdn.test/clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: GEMINI_DIRECT_URL_MAX_BYTES,
      },
    )
  })

  it('follows a redirect and reports the final URL', async () => {
    network.fetch
      .mockResolvedValueOnce(response(302, { location: 'https://cdn.test/final.webm' }))
      .mockResolvedValueOnce(
        response(200, { 'content-type': 'video/webm', 'content-length': '1024' }),
      )

    const probe = await probeDirectMediaUrl('https://cdn.test/start', loadConfig({}))
    expect(probe).toEqual({
      url: 'https://cdn.test/final.webm',
      mimeType: 'video/webm',
      sizeBytes: 1024,
    })
  })

  it.each([
    [
      'a file over the limit',
      response(200, { 'content-type': 'video/mp4', 'content-length': String(16_000_000) }),
    ],
    [
      'a page rather than media',
      response(200, { 'content-type': 'text/html', 'content-length': '900' }),
    ],
    ['a missing length', response(200, { 'content-type': 'video/mp4' })],
    [
      'a compressed response',
      response(200, {
        'content-type': 'video/mp4',
        'content-length': '1024',
        'content-encoding': 'gzip',
      }),
    ],
    ['an error status', response(404, {})],
  ])('declines %s', async (_label, fake) => {
    network.fetch.mockResolvedValueOnce(fake)
    await expect(
      probeDirectMediaUrl('https://cdn.test/video.mp4', loadConfig({})),
    ).resolves.toBeNull()
  })

  it('declines a redirect without a location', async () => {
    network.fetch.mockResolvedValueOnce(response(302, {}))
    await expect(probeDirectMediaUrl('https://cdn.test/start', loadConfig({}))).resolves.toBeNull()
  })
})

describe('classifyAiInput', () => {
  it('sends a YouTube page URL to Gemini without probing', async () => {
    const route = await classifyAiInput('https://youtu.be/abc123', loadConfig({}))
    expect(route).toEqual({
      kind: 'gemini-url',
      url: 'https://youtu.be/abc123',
      source: 'youtube',
      mimeType: undefined,
      sizeBytes: null,
    })
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('sends a small public media file to Gemini', async () => {
    network.fetch.mockResolvedValueOnce(
      response(200, { 'content-type': 'audio/mpeg', 'content-length': '2048' }),
    )
    await expect(
      classifyAiInput('https://cdn.test/talk.mp3', loadConfig({})),
    ).resolves.toMatchObject({ kind: 'gemini-url', source: 'direct-file', mimeType: 'audio/mpeg' })
  })

  it('downloads everything else', async () => {
    network.fetch.mockResolvedValueOnce(
      response(200, { 'content-type': 'text/html', 'content-length': '4096' }),
    )
    await expect(classifyAiInput('https://vimeo.test/12345', loadConfig({}))).resolves.toEqual({
      kind: 'download',
      url: 'https://vimeo.test/12345',
    })
  })
})
