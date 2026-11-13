import { createServer as createHttpServer } from 'node:http'
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startEgressGuard, type EgressGuard } from '../../src/services/egressGuard.js'
import { createLogger } from '../../src/utils/logger.js'

const logger = createLogger('silent')

interface Listening {
  port: number
  close(): Promise<void>
}

async function httpTarget(handler: (path: string) => string): Promise<Listening> {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(handler(req.url ?? ''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** Read a complete proxy response; the guard closes the reply after relaying. */
function readResponse(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      data += chunk
    })
    socket.once('end', () => resolve(data))
    socket.once('error', reject)
  })
}

/** Absolute-form request, which is how a client sends plain HTTP to a proxy. */
async function plainProxyRequest(proxyPort: number, target: string): Promise<string> {
  const socket = connect(proxyPort, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(`GET ${target} HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n`)
  return readResponse(socket)
}

/** Raw CONNECT through the proxy, returning the status line. */
function connectThroughProxy(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    socket.on('data', (chunk: string) => {
      response += chunk
      if (response.includes('\r\n')) {
        socket.destroy()
        resolve(response.split('\r\n')[0] ?? '')
      }
    })
    socket.once('error', reject)
  })
}

describe('egress guard', () => {
  let guard: EgressGuard | undefined
  const targets: Listening[] = []
  const extraSockets: Socket[] = []

  afterEach(async () => {
    await guard?.close()
    guard = undefined
    for (const socket of extraSockets.splice(0)) socket.destroy()
    for (const target of targets.splice(0)) await target.close()
  })

  it('blocks a plain HTTP request to a private destination', async () => {
    const target = await httpTarget(() => 'private data')
    targets.push(target)
    guard = await startEgressGuard({ allowPrivateHosts: false, logger })

    const response = await plainProxyRequest(guard.port, `http://127.0.0.1:${target.port}/secret`)

    expect(response).toMatch(/^HTTP\/1\.1 403/)
    expect(guard.blocked).toEqual([`127.0.0.1:${target.port}`])
  })

  it('relays an allowed plain HTTP request unchanged', async () => {
    const target = await httpTarget((path) => `path=${path}`)
    targets.push(target)
    guard = await startEgressGuard({ allowPrivateHosts: true, logger })

    const response = await plainProxyRequest(
      guard.port,
      `http://127.0.0.1:${target.port}/media.mp4`,
    )

    expect(response).toMatch(/^HTTP\/1\.1 200/)
    expect(response).toContain('path=/media.mp4')
    expect(guard.blocked).toEqual([])
  })

  it('refuses a CONNECT tunnel to a private destination', async () => {
    guard = await startEgressGuard({ allowPrivateHosts: false, logger })

    await expect(connectThroughProxy(guard.port, '127.0.0.1:443')).resolves.toMatch(/403/)
  })

  it('survives a client that resets the connection after a refusal', async () => {
    guard = await startEgressGuard({ allowPrivateHosts: false, logger })
    const proxyPort = guard.port

    await new Promise<void>((resolve, reject) => {
      const socket = connect(proxyPort, '127.0.0.1')
      socket.once('connect', () => {
        socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n')
      })
      socket.once('data', () => {
        socket.resetAndDestroy()
        resolve()
      })
      socket.once('error', reject)
    })

    // The guard must still serve the next request instead of crashing.
    await expect(connectThroughProxy(proxyPort, '127.0.0.1:443')).resolves.toMatch(/403/)
  })

  it('opens a CONNECT tunnel to an allowed destination', async () => {
    const echo = createTcpServer((socket) => {
      extraSockets.push(socket)
      socket.pipe(socket)
    })
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const echoPort = (echo.address() as AddressInfo).port
    targets.push({
      port: echoPort,
      close: () => new Promise((resolve) => echo.close(() => resolve())),
    })

    guard = await startEgressGuard({ allowPrivateHosts: true, logger })
    const proxyPort = guard.port
    const tunnelled = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxyPort, '127.0.0.1')
      let response = ''
      socket.setEncoding('utf8')
      socket.once('connect', () => {
        socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`)
      })
      socket.on('data', (chunk: string) => {
        response += chunk
        if (response.includes('200 Connection Established') && !response.includes('hello')) {
          socket.write('hello')
        } else if (response.includes('hello')) {
          socket.destroy()
          resolve(response)
        }
      })
      socket.once('error', reject)
    })

    expect(tunnelled).toContain('200 Connection Established')
    expect(tunnelled).toContain('hello')
  })
})
