import { ZodError, type z } from 'zod'
import type { Config } from '../config.js'
import type { OperationContext, OperationResult } from '../operations/types.js'
import { invalidInput } from '../utils/errors.js'
import { createLogger, type Logger } from '../utils/logger.js'

export interface ExecuteOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
  logger?: Logger
}

const defaultLoggers = new WeakMap<Config, Logger>()

/** Turn a Zod validation failure into an actionable, interface-neutral error. */
export function zodErrorToInvalidInput(error: ZodError): Error {
  const issues = error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join('.') : '(input)'
      return `${location}: ${issue.message}`
    })
    .join('; ')
  return invalidInput(`Invalid arguments: ${issues}`)
}

/**
 * Validate raw input against the operation's own schema.
 *
 * `executeOperation` is part of the public embedding surface, so validation
 * happens there rather than only in the adapters: an embedder that skips them
 * must still get `INVALID_INPUT` instead of an unvalidated value reaching
 * FFmpeg or the AI service.
 */
export function parseOperationInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  try {
    return schema.parse(input) as z.infer<S>
  } catch (error) {
    if (error instanceof ZodError) throw zodErrorToInvalidInput(error)
    throw error
  }
}

/**
 * Run a registered operation with normalized context.
 *
 * Shared by both adapters so validation, logging, and progress behave identically
 * whichever interface invoked the operation.
 */
export async function executeOperation<S extends z.ZodTypeAny>(
  operation: {
    inputSchema: S
    run: (input: z.infer<S>, ctx: OperationContext) => Promise<OperationResult>
  },
  input: unknown,
  config: Config,
  options: ExecuteOptions = {},
): Promise<OperationResult> {
  let logger = options.logger ?? defaultLoggers.get(config)
  if (!logger) {
    logger = createLogger(config.logLevel)
    defaultLoggers.set(config, logger)
  }
  const ctx: OperationContext = {
    config,
    logger,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  }

  return operation.run(parseOperationInput(operation.inputSchema, input), ctx)
}
