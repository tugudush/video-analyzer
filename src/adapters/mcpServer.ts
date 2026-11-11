import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Config } from '../config.js'
import { loadOperationsForMcp } from './mcpTools.js'
import { createLogger, setLogSink } from '../utils/logger.js'
import { toVideoAnalyzerError } from '../utils/errors.js'
import { sweepStaleTempDirs } from '../utils/fsUtils.js'
import { VERSION } from '../version.js'

export const SERVER_NAME = 'video-analyzer'
export const SERVER_VERSION = VERSION

const SERVER_INSTRUCTIONS = [
  'Analysis toolkit for video and audio files.',
  '',
  'Choosing an operation:',
  '- A specific question about content → analyze_video',
  '- An overview of the whole video → summarize_video',
  '- "When does X happen?" → search_timestamp (timestamps are estimates)',
  '- Speech-to-text → transcribe_video (plain text, no diarization)',
  '- Technical details (duration, codec, resolution) → get_video_info',
  '- Still images at times or scene changes → extract_frames',
  '',
  'Inputs may be local paths, file:// URIs, or direct http(s) media URLs. Platform page downloads are disabled.',
  'Local operations (get_video_info, extract_frames) work without GEMINI_API_KEY.',
].join('\n')

export interface McpServerHandle {
  server: McpServer
  start(): Promise<void>
  close(): Promise<void>
}

/** Build an MCP server exposing the shared operation registry. */
export function createMcpServer(config: Config): McpServerHandle {
  const logger = createLogger(config.logLevel)

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { logging: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  )

  // MCP clients expect stdout to carry protocol frames only, so diagnostics are
  // forwarded through MCP logging notifications instead of console output.
  setLogSink((level, message) => {
    void server
      .sendLoggingMessage({ level: level === 'warn' ? 'warning' : level, data: message })
      .catch(() => undefined)
  })

  for (const tool of loadOperationsForMcp(config, logger, (message) => {
    void server.sendLoggingMessage({ level: 'info', data: message }).catch(() => undefined)
  })) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive,
          openWorldHint: true,
        },
      },
      async (args: unknown, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
        try {
          const result = await tool.invoke(args, { signal: extra.signal })
          return result satisfies CallToolResult
        } catch (error) {
          const normalized = toVideoAnalyzerError(error)
          logger.debug(`Tool ${tool.name} failed: ${normalized.code} ${normalized.message}`)
          const text = normalized.hint
            ? `${normalized.code}: ${normalized.message}\nHint: ${normalized.hint}`
            : `${normalized.code}: ${normalized.message}`
          return { isError: true, content: [{ type: 'text', text }] }
        }
      },
    )
  }

  return {
    server,
    async start() {
      void sweepStaleTempDirs({ logger }).catch((error: unknown) =>
        logger.warn(`Could not scan temporary directories: ${String(error)}`),
      )
      const transport = new StdioServerTransport()
      await server.connect(transport)
      logger.info(`${SERVER_NAME} MCP server ready (model: ${config.geminiModel}).`)
    },
    async close() {
      setLogSink(undefined)
      await server.close()
    },
  }
}

/** Run the MCP server over stdio until the transport closes. */
export async function runMcpServer(config: Config): Promise<void> {
  const handle = createMcpServer(config)
  await handle.start()
}
