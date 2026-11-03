import type { Config } from '../config.js'
import type { OperationContext, OperationResult } from '../operations/types.js'
import { createLogger, type Logger } from '../utils/logger.js'

export interface ExecuteOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
  logger?: Logger
}

/**
 * Run a registered operation with normalized context.
 *
 * Shared by both adapters so retries, logging, and progress behave identically
 * whichever interface invoked the operation.
 */
export async function executeOperation(
  operation: { run: (input: never, ctx: OperationContext) => Promise<OperationResult> },
  input: unknown,
  config: Config,
  options: ExecuteOptions = {},
): Promise<OperationResult> {
  const logger = options.logger ?? createLogger(config.logLevel)
  const ctx: OperationContext = {
    config,
    logger,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  }

  return operation.run(input as never, ctx)
}
