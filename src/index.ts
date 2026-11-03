/**
 * Public entry point.
 *
 * Import from here to embed the toolkit in another program; the CLI and MCP
 * server are separate entry points (`dist/cli.js`, `dist/mcp.js`).
 */

export { loadConfig, requireGeminiApiKey, DEFAULT_GEMINI_MODEL } from './config.js'
export type { Config } from './config.js'

export {
  OPERATIONS,
  getOperation,
  listOperations,
  requireOperation,
} from './operations/registry.js'
export type { OperationName } from './operations/registry.js'
export { executeOperation } from './operations/execute.js'
export type {
  Artifact,
  ImageArtifact,
  Operation,
  OperationContext,
  OperationResult,
} from './operations/types.js'

export { createMcpServer, runMcpServer } from './adapters/mcpServer.js'
export { runCli } from './adapters/cli.js'

export { VideoAnalyzerError, toErrorEnvelope, toVideoAnalyzerError } from './utils/errors.js'
export type { ErrorCode, ErrorEnvelope } from './utils/errors.js'

export { GeminiMediaService } from './services/gemini.js'
export type { GeminiApi, GeminiFileHandle, GeminiPart } from './services/gemini.js'
