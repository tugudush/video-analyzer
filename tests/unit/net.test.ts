import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertSafeHttpUrl,
  downloadToFile,
  isPrivateAddress,
  redactUrlsInText,
} from '../../src/utils/net.js'
import { MAX_TIMER_MS } from '../../src/utils/abort.js'
import { toErrorEnvelope } from '../../src/utils/errors.js'

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
  ])('treats %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1'])(
    'treats %s as public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false)
    },
  )

  it('handles IPv6 reserved ranges', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('::')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('ff02::1')).toBe(true)
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isPrivateAddress('::127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::8.8.8.8')).toBe(false)
    expect(isPrivateAddress('fec0::1')).toBe(true)
    expect(isPrivateAddress('2002:7f00:1::')).toBe(true)
    expect(isPrivateAddress('2002:0808:0808::')).toBe(true)
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false)
  })

  it('fails closed on unparseable input', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true)
  })
})

describe('redactUrlsInText', () => {
  it('removes credentials, query strings, and fragments from embedded URLs', () => {
    const text =
      'ERROR: could not fetch https://user:pass@example.com/a.mp4?token=abc#frag (blocked)'

    expect(redactUrlsInText(text)).toBe(
      'ERROR: could not fetch https://example.com/a.mp4 (blocked)',
    )
  })

  it('drops a query string yt-dlp quotes without the rest of the URL', () => {
    expect(redactUrlsInText('ERROR: [generic] clip.mp4?X-Amz-Signature=abc: HTTP Error 403')).toBe(
      'ERROR: [generic] clip.mp4: HTTP Error 403',
    )
  })
})

describe('assertSafeHttpUrl', () => {
  it('rejects non-http protocols', async () => {
    await expect(assertSafeHttpUrl('file:///etc/passwd')).rejects.toThrowError(
      /Unsupported URL protocol/,
    )
    await expect(assertSafeHttpUrl('ftp://example.com/a.mp4')).rejects.toThrowError(
      /Unsupported URL protocol/,
    )
  })

  it('rejects malformed URLs', async () => {
    await expect(assertSafeHttpUrl('not a url')).rejects.toThrowError(/Not a valid absolute URL/)
  })

  it('rejects embedded credentials', async () => {
    await expect(assertSafeHttpUrl('https://user:pass@example.com/a.mp4')).rejects.toThrowError(
      /credentials/,
    )
  })

  it('rejects localhost and metadata hosts without DNS', async () => {
    await expect(assertSafeHttpUrl('http://localhost:8080/a.mp4')).rejects.toThrowError(/Refusing/)
    await expect(assertSafeHttpUrl('http://metadata.google.internal/x')).rejects.toThrowError(
      /Refusing/,
    )
    await expect(assertSafeHttpUrl('http://127.0.0.1/a.mp4')).rejects.toThrowError(
      /private or reserved/,
    )
    await expect(assertSafeHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrowError(
      /private or reserved/,
    )
  })

  it.each([
    'http://[fec0::1]/media.mp4',
    'http://[2002:7f00:1::]/media.mp4',
    'http://[::127.0.0.1]/media.mp4',
  ])('rejects reserved IPv6 URL %s', async (url) => {
    await expect(assertSafeHttpUrl(url)).rejects.toMatchObject({ code: 'URL_REJECTED' })
  })

  it('allows private hosts when explicitly opted in', async () => {
    const url = await assertSafeHttpUrl('http://127.0.0.1:9000/a.mp4', { allowPrivateHosts: true })
    expect(url.hostname).toBe('127.0.0.1')
  })
})

/**
 * `downloadToFile` failures are classified before the generic branches: telling
 * the user to check their network or their disk when they simply pressed Ctrl-C,
 * or when a slow link ran out of budget, sends them after the wrong problem.
 */
describe('downloadToFile failure classification', () => {
  const servers: Server[] = []
  const dirs: string[] = []

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind a port')
    return `http://127.0.0.1:${address.port}/media.mp4`
  }

  async function destination(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'video-analyzer-net-'))
    dirs.push(dir)
    return path.join(dir, 'download.bin')
  }

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('reports an expired download budget as a timeout, not a network problem', async () => {
    // Accepts the connection and never answers.
    const url = await listen(() => undefined)

    const outcome = await downloadToFile(
      `${url}?token=example-secret#private`,
      await destination(),
      {
        maxBytes: 1_000_000,
        timeoutMs: 200,
        allowPrivateHosts: true,
      },
    ).catch((error: unknown) => toErrorEnvelope(error))
    expect(outcome).toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringContaining('did not finish within 200 ms'),
      details: { timeoutMs: 200, url },
    })
    expect(JSON.stringify(outcome)).not.toContain('example-secret')
    expect(JSON.stringify(outcome)).not.toContain('private')
  })

  it('reports a caller cancellation as OPERATION_CANCELLED, not a write failure', async () => {
    // Sends headers and a partial body, then stalls so the abort lands mid-stream.
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '1000000' })
      response.write(Buffer.alloc(1024))
    })

    const controller = new AbortController()
    const pending = downloadToFile(url, await destination(), {
      maxBytes: 2_000_000,
      timeoutMs: 30_000,
      allowPrivateHosts: true,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })

  it('treats a budget larger than Node timers can represent as a long wait, not an instant abort', async () => {
    // Node clamps a delay above 2^31-1 ms to 1 ms, so the download used to fail
    // on the next tick even though the caller asked for an unlimited budget.
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4' })
      response.end('media')
    })

    await expect(
      downloadToFile(url, await destination(), {
        maxBytes: 1_000_000,
        timeoutMs: MAX_TIMER_MS + 1,
        allowPrivateHosts: true,
      }),
    ).resolves.toMatchObject({ bytesWritten: 5 })
  })

  it('keeps a genuine network failure on the download path', async () => {
    const url = await listen((request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end('unavailable')
    })

    await expect(
      downloadToFile(url, await destination(), {
        maxBytes: 1_000_000,
        timeoutMs: 5_000,
        allowPrivateHosts: true,
      }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', details: { status: 503 } })
  })

  it.each([
    { status: 403, length: '1000000' },
    { status: 200, length: '1000000' },
  ])('closes the rejected $status response body', async ({ status, length }) => {
    let closed = false
    const url = await listen((_request, response) => {
      response.on('close', () => {
        closed = true
      })
      response.writeHead(status, { 'content-length': length })
      response.flushHeaders()
      response.write('partial')
    })

    await expect(
      downloadToFile(url, await destination(), {
        maxBytes: 100,
        timeoutMs: 30_000,
        allowPrivateHosts: true,
      }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 })
  })

  it.each([
    { kind: 'http error', status: 403, location: undefined },
    { kind: 'redirect without a location', status: 302, location: undefined },
    { kind: 'invalid redirect', status: 302, location: 'http://[invalid?token=redirect-secret' },
    { kind: 'redirect loop', status: 302, location: '?token=redirect-secret#redirect-fragment' },
  ])('redacts signed URL data in $kind errors', async ({ status, location }) => {
    const url = await listen((_request, response) => {
      response.writeHead(status, location ? { location } : {})
      response.end()
    })
    const outcome = await downloadToFile(
      `${url}?token=initial-secret#initial-fragment`,
      await destination(),
      { maxBytes: 100, timeoutMs: 5_000, allowPrivateHosts: true },
    ).catch((error: unknown) => toErrorEnvelope(error))
    expect(outcome).toMatchObject({ code: 'DOWNLOAD_FAILED' })
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('fragment')
  })

  it('does not echo malformed signed URLs', async () => {
    await expect(assertSafeHttpUrl('http://[invalid?token=example-secret')).rejects.not.toThrow(
      /example-secret/,
    )
  })
})
