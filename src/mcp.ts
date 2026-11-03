#!/usr/bin/env node
import { loadConfig } from './config.js'
import { runMcpServer } from './adapters/mcpServer.js'

async function main(): Promise<void> {
  const config = loadConfig()
  await runMcpServer(config)
}

main().catch((error: unknown) => {
  process.stderr.write(
    `FATAL: failed to start the video-analyzer MCP server: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
  process.exitCode = 1
})
