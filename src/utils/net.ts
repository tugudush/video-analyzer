import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { Agent, fetch, type Response } from 'undici'
import { clampTimerMs, runWithBounds } from '../utils/abort.js'
import { VideoAnalyzerError, operationCancelled } from '../utils/errors.js'

/**
 * Network helpers with SSRF protection.
 *
 * Each redirect is resolved and validated independently, then its connection
 * uses only those addresses while retaining the original hostname for TLS.
 * Set `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true` to allow private-network media.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

const MAX_REDIRECTS = 5

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

function inIpv4Range(value: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/')
  const baseValue = ipv4ToInt(base ?? '')
  const bits = Number(bitsRaw)
  if (baseValue === undefined || !Number.isInteger(bits)) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (baseValue & mask)
}

const BLOCKED_IPV4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]

function expandIpv6(ip: string): number[] | undefined {
  let withoutZone = ip.split('%')[0] ?? ip

  // Normalize IPv4-embedded forms (::ffff:1.2.3.4) into pure hex groups.
  if (withoutZone.includes('.')) {
    const lastColon = withoutZone.lastIndexOf(':')
    if (lastColon < 0) return undefined
    const embedded = ipv4ToInt(withoutZone.slice(lastColon + 1))
    if (embedded === undefined) return undefined
    const high = Math.floor(embedded / 65536)
    const low = embedded % 65536
    withoutZone = `${withoutZone.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
  }

  const sections = withoutZone.split('::')
  if (sections.length > 2) return undefined

  const head = sections[0] ? sections[0].split(':') : []
  const tail = sections.length === 2 && sections[1] ? sections[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0) return undefined

  const groups = [
    ...head,
    ...(sections.length === 2 ? Array<string>(missing).fill('0') : []),
    ...tail,
  ]
  if (groups.length !== 8) return undefined

  const values: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
    values.push(parseInt(group, 16))
  }
  return values
}

function embeddedIpv4(values: number[]): string | undefined {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = values as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  // IPv4-compatible, IPv4-mapped and well-known NAT64 forms.
  const compatible = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
  if (!compatible && !mapped && !nat64) return undefined
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`
}

/** True when the address belongs to a range that must not be reached remotely. */
export function isPrivateAddress(address: string): boolean {
  const family = address.includes(':') ? 6 : 4

  if (family === 4) {
    const value = ipv4ToInt(address)
    if (value === undefined) return true
    return BLOCKED_IPV4_RANGES.some((range) => inIpv4Range(value, range))
  }

  const values = expandIpv6(address)
  if (!values) return true

  const allZero = values.every((group) => group === 0)
  if (allZero) return true
  if (values.slice(0, 7).every((group) => group === 0) && values[7] === 1) return true

  const first = values[0] as number
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 deprecated site local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (first === 0x2002) return true // 2002::/16 6to4

  const inner = embeddedIpv4(values)
  return inner ? isPrivateAddress(inner) : false
}

export interface UrlSafetyOptions {
  allowPrivateHosts?: boolean
}

/** Remove credentials and query/fragment data before a URL reaches diagnostics. */
export function redactedUrl(url: URL): string {
  const safe = new URL(url.href)
  safe.username = ''
  safe.password = ''
  safe.search = ''
  safe.hash = ''
  return safe.href
}

/**
 * Redact every URL embedded in free text.
 *
 * Subprocess output (yt-dlp's stderr in particular) quotes the input URL, and a
 * signed URL carries its authorization in the query string. Before such text is
 * published as an error hint or detail, each URL is reduced to scheme, host, and
 * path so no token, fragment, or embedded credential survives. yt-dlp sometimes
 * quotes only the last URL component (`clip.mp4?X-Amz-Signature=…`), so any
 * remaining `?query` is dropped as well.
 */
export function redactUrlsInText(text: string): string {
  const withoutUrls = text.replace(/https?:\/\/[^\s"'<>\\]+/gi, (match) => {
    try {
      return redactedUrl(new URL(match))
    } catch {
      return match
    }
  })
  return withoutUrls.replace(/[^\s"'<>\\]*\?[^\s"'<>\\]*/g, (match) => {
    // Sentence punctuation after the URL belongs to the message, not the query.
    const punctuation = /[.,;:)\]]+$/.exec(match)?.[0] ?? ''
    return match.slice(0, match.indexOf('?')) + punctuation
  })
}

/**
 * Validate that a URL is an http(s) URL pointing at a public address.
 *
 * The resolved addresses are returned so a connection can be made to exactly
 * those addresses; resolving again at connect time would reopen the window this
 * check closes.
 */
export async function resolveSafeHttpUrl(
  rawUrl: string,
  options: UrlSafetyOptions = {},
  signal?: AbortSignal,
): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  if (signal?.aborted) throw signal.reason
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new VideoAnalyzerError('URL_REJECTED', 'Not a valid absolute URL.', {
      hint: 'Provide an http:// or https:// URL, a local file path, or a file:// URI.',
    })
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new VideoAnalyzerError('URL_REJECTED', `Unsupported URL protocol: ${url.protocol}`, {
      hint: 'Only http and https URLs are supported.',
    })
  }

  if (url.username || url.password) {
    throw new VideoAnalyzerError(
      'URL_REJECTED',
      'URLs containing embedded credentials are not supported.',
    )
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (
    !options.allowPrivateHosts &&
    (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost'))
  ) {
    throw new VideoAnalyzerError('URL_REJECTED', `Refusing to contact ${hostname}.`, {
      hint: 'Set VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true to allow private-network hosts.',
    })
  }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await runWithBounds(() => lookup(hostname, { all: true, verbatim: true }), {
      timeoutMs: 0,
      ...(signal ? { signal } : {}),
      onCancel: () =>
        signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'),
      onTimeout: () => new DOMException('Timed out', 'TimeoutError'),
    })
  } catch {
    if (signal?.aborted) throw signal.reason
    throw new VideoAnalyzerError('URL_REJECTED', `Could not resolve host: ${hostname}`)
  }

  if (addresses.length === 0) {
    throw new VideoAnalyzerError('URL_REJECTED', `Could not resolve host: ${hostname}`)
  }

  for (const entry of addresses) {
    if (!options.allowPrivateHosts && isPrivateAddress(entry.address)) {
      throw new VideoAnalyzerError(
        'URL_REJECTED',
        `Refusing to contact ${hostname}: ${entry.address} is a private or reserved address.`,
        {
          hint: 'Set VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true if this media lives on your local network.',
          details: { hostname, address: entry.address },
        },
      )
    }
  }

  return { url, addresses }
}

/** Validate that a URL is an http(s) URL pointing at a public address. */
export async function assertSafeHttpUrl(
  rawUrl: string,
  options: UrlSafetyOptions = {},
): Promise<URL> {
  return (await resolveSafeHttpUrl(rawUrl, options)).url
}

export interface PinnedFetchOptions extends UrlSafetyOptions {
  method?: string
  headers?: Record<string, string>
  /** Request body for methods that carry one. */
  body?: Uint8Array | string
  signal?: AbortSignal
  /**
   * Follow 3xx responses (default). A caller that must see redirects itself,
   * such as the egress proxy, disables this.
   */
  followRedirects?: boolean
}

export interface PinnedFetchResult {
  response: Response
  /** URL of the response, after the redirects that were followed. */
  finalUrl: URL
  /** True when a redirect chain was longer than the guard follows. */
  tooManyRedirects: boolean
  /** Release the connection used by `response`. Never throws. */
  close(): Promise<void>
}

/**
 * Fetch a URL through the same per-hop validation and address pinning that
 * `downloadToFile` uses.
 *
 * Redirects are followed here rather than by the client, so every hop is
 * resolved and validated before it is contacted, and each connection is made to
 * an address that was already checked. A redirect that cannot be followed
 * (missing, malformed, or too many hops) comes back as the 3xx response.
 */
export async function fetchPinned(
  rawUrl: string,
  options: PinnedFetchOptions = {},
): Promise<PinnedFetchResult> {
  let current = rawUrl

  for (let redirects = 0; ; redirects++) {
    const { url, addresses } = await resolveSafeHttpUrl(current, options, options.signal)

    const agent = new Agent({
      connect: {
        lookup: (_hostname, lookupOptions, callback) => {
          const eligible = lookupOptions.family
            ? addresses.filter((entry) => entry.family === lookupOptions.family)
            : addresses
          const first = eligible[0]
          if (!first) {
            callback(
              Object.assign(new Error('No validated address for this family.'), {
                code: 'ENOTFOUND',
              }),
              '',
            )
          } else if (lookupOptions.all) {
            callback(null, eligible)
          } else {
            callback(null, first.address, first.family)
          }
        },
      },
    })
    const close = async () => {
      await agent.destroy().catch(() => undefined)
    }

    let response: Response
    try {
      response = await fetch(url, {
        redirect: 'manual',
        ...(options.method ? { method: options.method } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        dispatcher: agent,
      })
    } catch (error) {
      await close()
      throw error
    }

    if (options.followRedirects === false) {
      return { response, finalUrl: url, tooManyRedirects: false, close }
    }

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: url, tooManyRedirects: false, close }
    }

    const location = response.headers.get('location')
    const beyondLimit = redirects >= MAX_REDIRECTS
    let next: URL | undefined
    if (location !== null && !beyondLimit) {
      try {
        next = new URL(location, url)
      } catch {
        next = undefined
      }
    }
    if (!next) {
      return {
        response,
        finalUrl: url,
        tooManyRedirects: beyondLimit && location !== null,
        close,
      }
    }

    await response.body?.cancel().catch(() => undefined)
    await close()
    current = next.href
  }
}

export interface DownloadResult {
  bytesWritten: number
  contentType: string | undefined
  finalUrl: string
  sha256: string
}

export interface DownloadOptions extends UrlSafetyOptions {
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
}

/** Download a remote resource to `destPath` with size, timeout, and SSRF guards. */
export async function downloadToFile(
  url: string,
  destPath: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  // A delay Node cannot represent would otherwise abort on the next tick.
  const timeoutMs = clampTimerMs(options.timeoutMs)
  const signals: AbortSignal[] = []
  if (options.signal) signals.push(options.signal)
  signals.push(AbortSignal.timeout(timeoutMs))
  const signal = signals.length === 1 ? (signals[0] as AbortSignal) : AbortSignal.any(signals)

  /**
   * A cancelled download and an expired deadline both surface as an abort, but
   * neither is a network or disk failure, so they are classified before the
   * generic branches: telling the user to "check network access" or that a
   * write failed sends them after the wrong problem.
   */
  const classifyDownloadFailure = (
    error: unknown,
    stage: 'download' | 'write',
    current?: URL,
  ): VideoAnalyzerError => {
    if (options.signal?.aborted) return operationCancelled({ cause: error })

    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new VideoAnalyzerError(
        'DOWNLOAD_FAILED',
        `The download did not finish within ${timeoutMs} ms.`,
        {
          hint: 'The download budget is max(VIDEO_ANALYZER_REQUEST_TIMEOUT_MS, 60 s). Raise VIDEO_ANALYZER_REQUEST_TIMEOUT_MS for large files or slow links.',
          details: {
            timeoutMs,
            ...(current ? { url: redactedUrl(current) } : {}),
            stage,
          },
          cause: error,
        },
      )
    }

    return stage === 'download'
      ? new VideoAnalyzerError(
          'DOWNLOAD_FAILED',
          `Failed to download${current ? ` ${redactedUrl(current)}` : ''}`,
          {
            hint: 'Check network access and that the URL is publicly reachable.',
            cause: error,
          },
        )
      : new VideoAnalyzerError('DOWNLOAD_FAILED', `Failed to write ${destPath}`, { cause: error })
  }

  const validate = async (rawUrl: string, previous?: URL) => {
    try {
      return await resolveSafeHttpUrl(rawUrl, options, signal)
    } catch (error) {
      if (signal.aborted) throw classifyDownloadFailure(signal.reason, 'download', previous)
      throw error
    }
  }

  let resolved = await validate(url)
  let current = resolved.url
  let response: Response | undefined
  let agent: Agent | undefined

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      let attempt: Response
      const addresses = resolved.addresses
      agent = new Agent({
        connect: {
          lookup: (_hostname, lookupOptions, callback) => {
            const eligible = lookupOptions.family
              ? addresses.filter((entry) => entry.family === lookupOptions.family)
              : addresses
            const first = eligible[0]
            if (!first) {
              callback(
                Object.assign(new Error('No validated address for this family.'), {
                  code: 'ENOTFOUND',
                }),
                '',
              )
            } else if (lookupOptions.all) {
              callback(null, eligible)
            } else {
              callback(null, first.address, first.family)
            }
          },
        },
      })
      try {
        const request = {
          redirect: 'manual' as const,
          signal,
          headers: { 'user-agent': 'video-analyzer' },
          dispatcher: agent,
        }
        attempt = await fetch(current, request)
      } catch (error) {
        throw classifyDownloadFailure(error, 'download', current)
      }

      if (attempt.status >= 300 && attempt.status < 400) {
        const location = attempt.headers.get('location')
        await attempt.body?.cancel().catch(() => undefined)
        await agent.destroy()
        agent = undefined
        if (!location) {
          throw new VideoAnalyzerError(
            'DOWNLOAD_FAILED',
            `Redirect without a Location header from ${redactedUrl(current)}`,
          )
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new VideoAnalyzerError(
            'DOWNLOAD_FAILED',
            `Too many redirects while fetching ${redactedUrl(current)}`,
            { hint: `More than ${MAX_REDIRECTS} redirects were followed.` },
          )
        }
        let next: URL
        try {
          next = new URL(location, current)
        } catch (error) {
          throw new VideoAnalyzerError('DOWNLOAD_FAILED', 'Redirect has an invalid Location.', {
            cause: error,
          })
        }
        resolved = await validate(next.href, current)
        current = resolved.url
        continue
      }

      response = attempt
      break
    }

    if (!response) {
      throw new VideoAnalyzerError(
        'DOWNLOAD_FAILED',
        `Too many redirects while fetching ${redactedUrl(current)}`,
        { hint: `More than ${MAX_REDIRECTS} redirects were followed.` },
      )
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      // The declared type is part of the diagnosis: a refused document may still
      // be retrievable by the platform downloader, while a refused media stream
      // is not.
      const contentType = response.headers.get('content-type') ?? undefined
      throw new VideoAnalyzerError(
        'DOWNLOAD_FAILED',
        `Download failed with HTTP ${response.status} ${response.statusText}`.trim(),
        {
          details: {
            url: redactedUrl(current),
            status: response.status,
            ...(contentType ? { contentType } : {}),
          },
        },
      )
    }

    const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new VideoAnalyzerError(
        'DOWNLOAD_FAILED',
        'Remote file exceeds the download size limit.',
        {
          hint: 'Raise VIDEO_ANALYZER_DOWNLOAD_MAX_MB to allow larger downloads.',
          details: { declaredLength, maxBytes: options.maxBytes },
        },
      )
    }

    if (!response.body) {
      throw new VideoAnalyzerError('DOWNLOAD_FAILED', 'Download returned no body.')
    }

    const stream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
    let bytesWritten = 0
    const hash = createHash('sha256')
    const output = createWriteStream(destPath)

    try {
      await pipeline(
        stream,
        async function* (source: AsyncIterable<Buffer | Uint8Array>) {
          for await (const chunk of source) {
            bytesWritten += chunk.byteLength
            if (bytesWritten > options.maxBytes) {
              throw new VideoAnalyzerError(
                'DOWNLOAD_FAILED',
                'Remote file exceeded the download size limit while streaming.',
                {
                  hint: 'Raise VIDEO_ANALYZER_DOWNLOAD_MAX_MB to allow larger downloads.',
                  details: { maxBytes: options.maxBytes },
                },
              )
            }
            hash.update(chunk)
            yield chunk
          }
        },
        output,
      )
    } catch (error) {
      output.destroy()
      if (error instanceof VideoAnalyzerError) throw error
      throw classifyDownloadFailure(error, 'write', current)
    }

    return {
      bytesWritten,
      contentType: response.headers.get('content-type') ?? undefined,
      finalUrl: current.href,
      sha256: hash.digest('hex'),
    }
  } finally {
    await agent?.destroy()
  }
}
