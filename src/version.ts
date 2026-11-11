import { createRequire } from 'node:module'

/**
 * Single source of truth for the reported version.
 *
 * `package.json` sits one level above both `src/` (tests, via the Vitest
 * transform) and `dist/` (the published build), so the same relative lookup works
 * in both and a version bump can never leave the MCP handshake or `--version`
 * reporting a stale number.
 */
const nodeRequire = createRequire(import.meta.url)

export const VERSION: string = (nodeRequire('../package.json') as { version: string }).version
