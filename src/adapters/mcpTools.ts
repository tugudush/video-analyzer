import { ZodError, type z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Config } from '../config.js'
import { listOperations } from '../operations/registry.js'
import { executeOperation, zodErrorToInvalidInput } from '../operations/execute.js'
import type { Logger } from '../utils/logger.js'
import { loadImages } from './envelope.js'

export interface McpToolDescriptor {
  name: string
  title: string
  description: string
  inputSchema: z.ZodTypeAny
  readOnly: boolean
  destructive: boolean
  /**
   * Run the operation. `signal` carries MCP request cancellation so in-flight
   * Gemini calls and polling stop when the client gives up.
   */
  invoke(args: unknown, options?: { signal?: AbortSignal }): Promise<CallToolResult>
}

async function toCallToolResult(
  result: Awaited<ReturnType<typeof executeOperation>>,
): Promise<CallToolResult> {
  const content: CallToolResult['content'] = [{ type: 'text', text: result.summary }]

  if (result.data !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(result.data, null, 2) })
  }

  for (const warning of result.warnings ?? []) {
    content.push({ type: 'text', text: `Warning: ${warning}` })
  }

  for (const artifact of result.artifacts ?? []) {
    content.push({ type: 'text', text: `Saved ${artifact.kind}: ${artifact.path}` })
  }

  for (const image of await loadImages(result)) {
    content.push({
      type: 'image',
      data: image.base64,
      mimeType: image.mimeType,
    } as CallToolResult['content'][number])
  }

  return { content }
}

/**
 * Build MCP tool descriptors from the shared registry.
 *
 * Capability parity with the CLI is structural: both iterate the same list.
 */
export function loadOperationsForMcp(
  config: Config,
  logger: Logger,
  onProgress?: (message: string) => void,
): McpToolDescriptor[] {
  return listOperations().map((operation) => ({
    name: operation.name,
    title: operation.title,
    description: operation.description,
    inputSchema: operation.inputSchema,
    readOnly: operation.readOnly ?? operation.category === 'analysis',
    destructive: operation.destructive ?? false,
    async invoke(args: unknown, options?: { signal?: AbortSignal }) {
      let parsed: unknown
      try {
        parsed = operation.inputSchema.parse(args)
      } catch (error) {
        if (error instanceof ZodError) throw zodErrorToInvalidInput(error)
        throw error
      }

      const result = await executeOperation(operation, parsed, config, {
        logger,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(onProgress ? { onProgress } : {}),
      })
      return toCallToolResult(result)
    },
  }))
}
