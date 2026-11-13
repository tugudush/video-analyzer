import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { Readable, type Duplex } from 'node:stream'
import { fetchPinned, redactUrlsInText, resolveSafeHttpUrl } from '../utils/net.js'
import type { UrlSafetyOptions } from '../utils/net.js'
import { VideoAnalyzerError } from '../utils/errors.js'
import { createLogger, type Logger } from '../utils/logger.js'

/**
 * Loopback HTTP proxy that applies the tool's destination policy to another
 * process.
 *
 * `yt-dlp` resolves and contacts whatever host a page points it at, so the
 * caller's own URL checks only cover the page URL it was given. Routing yt-dlp
 * through this proxy extends the same policy — per-hop validation and
 * connection to an already-checked address — to every request the downloader
 * makes. HTTPS is tunnelled end to end, so certificates and SNI stay between
 * yt-dlp and the origin.
 */

export interface EgressGuardOptions extends UrlSafetyOptions {
  logger?: Logger
}

export interface EgressGuard {
  /** Proxy URL to hand to the downloader. */
  url: string
  port: number
  /** Destinations the policy refused, in the order they were refused. */
  readonly blocked: string[]
  /** Stop accepting connections and wait for open tunnels to close. */
  close(): Promise<void>
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const MAX_REQUEST_BODY_BYTES = 1024 * 1024

function filterHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'accept-encoding') continue
    result[lower] = Array.isArray(value) ? value.join(', ') : value
  }
  return result
}

function responseHeaders(headers: Headers): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of headers.entries()) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    result[name] = value
  }
  return result
}

function deny(res: ServerResponse, message: string): void {
  res.writeHead(403, { 'content-type': 'text/plain' }).end(message)
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(message)
}

/** True when the URL was refused by policy rather than failing to resolve. */
function isPolicyBlock(error: unknown): boolean {
  return (
    error instanceof VideoAnalyzerError &&
    error.code === 'URL_REJECTED' &&
    (error.details?.['address'] !== undefined || /Refusing to contact/i.test(error.message))
  )
}

function denyTunnel(socket: Duplex, status: string, message: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\n\r\n${message}`)
}

/** Record a refusal so the caller can explain it, without growing without bound. */
function recordBlocked(blocked: string[], entry: string | undefined): void {
  if (!entry || blocked.includes(entry) || blocked.length >= 5) return
  blocked.push(entry)
}

function authorityOf(target: string): string {
  try {
    const url = new URL(target)
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return target.slice(0, 200)
  }
}

/** `host:port` without userinfo a client may have placed in a CONNECT authority. */
function safeAuthority(authority: string | undefined): string {
  return (authority?.split('@').at(-1) ?? '(missing)').slice(0, 200)
}

/** Resolve a CONNECT authority (`host:port`) into a validated address and port. */
async function validateAuthority(
  authority: string | undefined,
  options: EgressGuardOptions,
): Promise<{ address: string; family: number; port: number } | undefined> {
  if (!authority) return undefined
  const resolved = await resolveSafeHttpUrl(`https://${authority}`, options)
  const first = resolved.addresses[0]
  if (!first) return undefined
  const port = Number(resolved.url.port || 443)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { address: first.address, family: first.family, port }
}

async function readBody(req: IncomingMessage): Promise<Uint8Array | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === undefined) return undefined
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_REQUEST_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks)
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  options: EgressGuardOptions,
  logger: Logger,
  blocked: string[],
): Promise<void> {
  const target = req.url
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Absolute-form URL required.')
    return
  }

  let body: Uint8Array | undefined
  try {
    body = await readBody(req)
  } catch (error) {
    res.writeHead(413, { 'content-type': 'text/plain' }).end(String(error))
    return
  }

  try {
    const { response, close } = await fetchPinned(target, {
      ...options,
      method: req.method ?? 'GET',
      headers: filterHeaders(req.headers),
      followRedirects: false,
      ...(body !== undefined ? { body } : {}),
    })

    res.once('close', () => {
      void response.body?.cancel().catch(() => undefined)
      void close()
    })
    res.writeHead(response.status, response.statusText, responseHeaders(response.headers))
    if (!response.body) {
      res.end()
      return
    }
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
      .on('error', (error: unknown) => {
        logger.debug(`Egress proxy response failed: ${String(error)}`)
        res.destroy()
      })
      .pipe(res)
  } catch (error) {
    logger.debug(`Egress proxy denied ${redactUrlsInText(target)}: ${String(error)}`)
    if (isPolicyBlock(error)) {
      recordBlocked(blocked, authorityOf(target))
      deny(res, 'Blocked by the video-analyzer network policy.')
    } else {
      fail(res, 502, 'The network guard could not reach the destination.')
    }
  }
}

function tunnel(
  authority: string | undefined,
  clientSocket: Duplex,
  head: Buffer,
  options: EgressGuardOptions,
  logger: Logger,
  blocked: string[],
): void {
  void (async () => {
    let target: { address: string; family: number; port: number } | undefined
    let policyBlock = false
    try {
      target = await validateAuthority(authority, options)
    } catch (error) {
      logger.debug(`Egress proxy refused ${safeAuthority(authority)}: ${String(error)}`)
      policyBlock = isPolicyBlock(error)
      if (policyBlock) recordBlocked(blocked, authorityOf(`https://${authority ?? ''}`))
    }
    if (!target) {
      if (policyBlock) {
        denyTunnel(clientSocket, '403 Forbidden', 'Blocked by the video-analyzer network policy.')
      } else {
        denyTunnel(
          clientSocket,
          '502 Bad Gateway',
          'The network guard could not reach the destination.',
        )
      }
      return
    }

    const upstream = connect(target.port, target.address, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
    clientSocket.on('close', () => upstream.destroy())
    upstream.on('close', () => clientSocket.destroy())
  })()
}

/** Start a loopback proxy that enforces `options` for every request it relays. */
export async function startEgressGuard(options: EgressGuardOptions = {}): Promise<EgressGuard> {
  const logger = options.logger ?? createLogger('warn')
  const sockets = new Set<Duplex>()
  const blocked: string[] = []

  const server = createServer((req, res) => {
    void forward(req, res, options, logger, blocked)
  })
  server.on('connect', (req, socket, head) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // A client that gives up mid-handshake resets the connection. Without a
    // listener that reset would be an unhandled `error` event and would take the
    // whole server down with it.
    socket.on('error', () => socket.destroy())
    tunnel(req.url, socket, head, options, logger, blocked)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    server.close()
    throw new Error('The egress guard did not bind a loopback port.')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    blocked,
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
