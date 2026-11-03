import { lookup } from 'node:dns/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { VideoAnalyzerError } from '../utils/errors.js'

/**
 * Network helpers with best-effort SSRF protection.
 *
 * Every hop of a redirect chain is validated, and DNS is resolved before the
 * connection is made. A determined attacker can still win a DNS-rebinding race
 * between the check and the connect, so this is defense in depth rather than a
 * cryptographic guarantee. Set `VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true` to
 * deliberately allow private-network media.
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
  // ::ffff:a.b.c.d  and  64:ff9b::a.b.c.d
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
  if (!mapped && !nat64) return undefined
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
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast

  const inner = embeddedIpv4(values)
  return inner ? isPrivateAddress(inner) : false
}

export interface UrlSafetyOptions {
  allowPrivateHosts?: boolean
}

/** Validate that a URL is an http(s) URL pointing at a public address. */
export async function assertSafeHttpUrl(
  rawUrl: string,
  options: UrlSafetyOptions = {},
): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new VideoAnalyzerError('URL_REJECTED', `Not a valid absolute URL: ${rawUrl}`, {
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

  if (options.allowPrivateHosts) return url

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new VideoAnalyzerError('URL_REJECTED', `Refusing to contact ${hostname}.`, {
      hint: 'Set VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true to allow private-network hosts.',
    })
  }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new VideoAnalyzerError('URL_REJECTED', `Could not resolve host: ${hostname}`)
  }

  if (addresses.length === 0) {
    throw new VideoAnalyzerError('URL_REJECTED', `Could not resolve host: ${hostname}`)
  }

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
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

  return url
}

export interface DownloadResult {
  bytesWritten: number
  contentType: string | undefined
  finalUrl: string
}

export interface DownloadOptions extends UrlSafetyOptions {
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
  headers?: Record<string, string>
}

/** Download a remote resource to `destPath` with size, timeout, and SSRF guards. */
export async function downloadToFile(
  url: string,
  destPath: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const signals: AbortSignal[] = []
  if (options.signal) signals.push(options.signal)
  signals.push(AbortSignal.timeout(options.timeoutMs))
  const signal = signals.length === 1 ? (signals[0] as AbortSignal) : AbortSignal.any(signals)

  let current = await assertSafeHttpUrl(url, options)
  let response: Response | undefined

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let attempt: Response
    try {
      attempt = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': 'video-analyzer', ...options.headers },
      })
    } catch (error) {
      throw new VideoAnalyzerError('DOWNLOAD_FAILED', `Failed to download ${current.href}`, {
        hint: 'Check network access and that the URL is publicly reachable.',
        cause: error,
      })
    }

    if (attempt.status >= 300 && attempt.status < 400) {
      const location = attempt.headers.get('location')
      await attempt.body?.cancel().catch(() => undefined)
      if (!location) {
        throw new VideoAnalyzerError(
          'DOWNLOAD_FAILED',
          `Redirect without a Location header from ${current.href}`,
        )
      }
      current = await assertSafeHttpUrl(new URL(location, current).href, options)
      continue
    }

    response = attempt
    break
  }

  if (!response) {
    throw new VideoAnalyzerError('DOWNLOAD_FAILED', `Too many redirects while fetching ${url}`, {
      hint: `More than ${MAX_REDIRECTS} redirects were followed.`,
    })
  }

  if (!response.ok) {
    throw new VideoAnalyzerError(
      'DOWNLOAD_FAILED',
      `Download failed with HTTP ${response.status} ${response.statusText}`.trim(),
      { details: { url: current.href, status: response.status } },
    )
  }

  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
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
          yield chunk
        }
      },
      output,
    )
  } catch (error) {
    output.destroy()
    throw error instanceof VideoAnalyzerError
      ? error
      : new VideoAnalyzerError('DOWNLOAD_FAILED', `Failed to write ${destPath}`, { cause: error })
  }

  return {
    bytesWritten,
    contentType: response.headers.get('content-type') ?? undefined,
    finalUrl: current.href,
  }
}
