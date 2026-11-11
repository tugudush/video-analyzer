import type { z } from 'zod'
import type { Config } from '../config.js'
import type { Logger } from '../utils/logger.js'

/** A file the caller may keep (transcript, extracted frames). */
export interface Artifact {
  path: string
  kind: 'transcript' | 'video' | 'frame' | 'metadata'
  mimeType?: string
  label?: string
}

export interface ImageArtifact {
  path: string
  mimeType: string
  label?: string
}

/**
 * Interface-neutral result of an operation.
 *
 * `summary` is always present so both adapters have something human/LLM readable
 * to return. Structured data, image artifacts, and file artifacts are optional.
 */
export interface OperationResult {
  summary: string
  data?: unknown
  warnings?: string[]
  images?: ImageArtifact[]
  artifacts?: Artifact[]
}

export interface OperationContext {
  config: Config
  logger: Logger
  signal?: AbortSignal
  /** Optional progress hook (MCP logging notifications, CLI stderr in verbose mode). */
  onProgress?: (message: string) => void
  /** Test seam: supply a pre-built Gemini service instead of the process-wide one. */
  geminiService?: import('../services/gemini.js').GeminiMediaService
}

export interface Operation<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** snake_case name shared by the MCP tool and the CLI subcommand. */
  name: string
  title: string
  description: string
  inputSchema: Schema
  /** Capability hints used by the operation-selection guidance in the Skill. */
  category: 'analysis' | 'local'
  /** False when the operation can write files. Defaults to `category === 'analysis'`. */
  readOnly?: boolean
  /**
   * True when the operation can replace a file the caller did not create during
   * this call. Published to MCP clients as `destructiveHint`; defaults to false.
   */
  destructive?: boolean
  requiresGemini: boolean
  run(input: z.infer<Schema>, ctx: OperationContext): Promise<OperationResult>
}
