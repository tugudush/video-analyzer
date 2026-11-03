#!/usr/bin/env node
import { runCli } from './adapters/cli.js'

try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error: unknown) {
  process.stderr.write(`FATAL: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
