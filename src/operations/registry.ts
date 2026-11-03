import type { z } from 'zod'
import { analyzeVideoOperation } from './analyzeVideo.js'
import { extractFramesOperation } from './extractFrames.js'
import { getVideoInfoOperation } from './getVideoInfo.js'
import { redactSensitiveOperation } from './redactSensitive.js'
import { searchTimestampOperation } from './searchTimestamp.js'
import { summarizeVideoOperation } from './summarizeVideo.js'
import { transcribeVideoOperation } from './transcribeVideo.js'
import { invalidInput } from '../utils/errors.js'
import type { Operation } from './types.js'

/**
 * Single source of truth for the toolkit's capabilities.
 *
 * The MCP adapter and the CLI adapter both read from this list, so a capability
 * can never exist in one interface and be missing from the other.
 */
export const OPERATIONS = [
  analyzeVideoOperation,
  summarizeVideoOperation,
  searchTimestampOperation,
  transcribeVideoOperation,
  getVideoInfoOperation,
  extractFramesOperation,
  redactSensitiveOperation,
] as const satisfies readonly Operation<z.ZodTypeAny>[]

export type OperationName = (typeof OPERATIONS)[number]['name']

export function listOperations(): readonly Operation<z.ZodTypeAny>[] {
  return OPERATIONS
}

export function getOperation(name: string): Operation<z.ZodTypeAny> | undefined {
  return OPERATIONS.find((operation) => operation.name === name)
}

/** Look up an operation or throw an actionable error listing valid names. */
export function requireOperation(name: string): Operation<z.ZodTypeAny> {
  const operation = getOperation(name)
  if (!operation) {
    throw invalidInput(`Unknown operation: ${name}`, {
      hint: `Available operations: ${OPERATIONS.map((entry) => entry.name).join(', ')}`,
    })
  }
  return operation
}

export type { Operation, OperationResult, OperationContext } from './types.js'
