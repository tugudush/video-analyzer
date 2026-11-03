import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMcpServer, type McpServerHandle } from '../../src/adapters/mcpServer.js'
import { loadConfig } from '../../src/config.js'
import { createSampleVideo, ffmpegAvailable } from '../helpers/media.js'

const available = await ffmpegAvailable()

async function connect(): Promise<{ handle: McpServerHandle; client: Client }> {
  const handle = createMcpServer(loadConfig({ VIDEO_ANALYZER_LOG_LEVEL: 'silent' }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await handle.server.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)

  return { handle, client }
}

describe('MCP adapter', () => {
  let handle: McpServerHandle
  let client: Client

  beforeAll(async () => {
    const connected = await connect()
    handle = connected.handle
    client = connected.client
  })

  afterAll(async () => {
    await client.close()
    await handle.close()
  })

  it('advertises exactly the seven analysis operations', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'analyze_video',
      'extract_frames',
      'get_video_info',
      'redact_sensitive',
      'search_timestamp',
      'summarize_video',
      'transcribe_video',
    ])
  })

  it('publishes an input schema for every tool', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description?.length).toBeGreaterThan(20)
    }
  })

  it('returns a structured error instead of throwing for a missing file', async () => {
    const result = await client.callTool({
      name: 'get_video_info',
      arguments: { videoPath: path.join(tmpdir(), 'definitely-missing-video.mp4') },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? ''
    expect(text).toContain('INPUT_NOT_FOUND')
  })

  it('rejects schema violations before the handler runs', async () => {
    const result = await client.callTool({
      name: 'analyze_video',
      arguments: { videoPath: 'a.mp4' },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? ''
    // The MCP SDK validates arguments against the shared Zod schema itself and
    // reports a JSON-RPC -32602 error naming the offending field.
    expect(text).toMatch(/validation error|-32602/)
    expect(text).toContain('question')
  })

  it('does not expose generative tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)
    for (const forbidden of [
      'text_to_speech',
      'generate_image',
      'generate_video',
      'generate_music',
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it.skipIf(!available)('serves get_video_info over MCP', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'video-analyzer-mcp-'))
    try {
      const sample = await createSampleVideo(workDir)
      const result = await client.callTool({
        name: 'get_video_info',
        arguments: { videoPath: sample.path },
      })

      expect(result.isError).toBeFalsy()
      const texts = (result.content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')

      expect(texts).toContain('Duration')
      expect(texts).toContain('320x240')
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
