import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { listOperations } from '../../src/operations/registry.js'
import { loadOperationsForMcp } from '../../src/adapters/mcpTools.js'
import { createLogger } from '../../src/utils/logger.js'
import { runCli } from '../../src/adapters/cli.js'

/**
 * Contract parity: the MCP interface and the CLI interface must expose the same
 * capabilities, from the same registry, with the same schemas.
 */
describe('CLI/MCP parity', () => {
  it('exposes identical operation names', () => {
    const registryNames = listOperations().map((operation) => operation.name)
    const mcpNames = loadOperationsForMcp(loadConfig({}), createLogger('silent')).map(
      (tool) => tool.name,
    )

    expect(mcpNames).toEqual(registryNames)
  })

  it('reports the same names through the CLI list command', async () => {
    const out: string[] = []
    await runCli(['list'], { stdout: (text) => out.push(text), stderr: () => undefined }, {})

    const payload = JSON.parse(out.join('')) as { operations: Array<{ name: string }> }
    expect(payload.operations.map((operation) => operation.name)).toEqual(
      listOperations().map((operation) => operation.name),
    )
  })

  it('shares the exact same schema object between interfaces', () => {
    const tools = loadOperationsForMcp(loadConfig({}), createLogger('silent'))
    for (const operation of listOperations()) {
      const tool = tools.find((entry) => entry.name === operation.name)
      expect(tool).toBeDefined()
      expect(tool?.inputSchema).toBe(operation.inputSchema)
    }
  })

  it('keeps tool descriptions identical to the registry', () => {
    const tools = loadOperationsForMcp(loadConfig({}), createLogger('silent'))
    for (const operation of listOperations()) {
      const tool = tools.find((entry) => entry.name === operation.name)
      expect(tool?.description).toBe(operation.description)
      expect(tool?.title).toBe(operation.title)
    }
  })

  it('marks read-only operations explicitly, including the local metadata probe', () => {
    const tools = loadOperationsForMcp(loadConfig({}), createLogger('silent'))
    const readOnly = tools.filter((tool) => tool.readOnly).map((tool) => tool.name)
    // get_video_info is in the local category but writes nothing the caller
    // keeps, so it must not prompt clients that gate on read-only tools.
    expect(readOnly).toEqual([
      'analyze_video',
      'summarize_video',
      'search_timestamp',
      'get_video_info',
    ])
  })

  it('advertises destructive writes only for transcribe_video', () => {
    const tools = loadOperationsForMcp(loadConfig({}), createLogger('silent'))
    const destructive = tools.filter((tool) => tool.destructive).map((tool) => tool.name)
    expect(destructive).toEqual(['transcribe_video'])
    // A tool that can replace a caller-supplied file cannot also claim read-only.
    for (const tool of tools) {
      if (tool.destructive) expect(tool.readOnly).toBe(false)
    }
  })

  it('excludes generative and licensing capabilities entirely', () => {
    const names = listOperations().map((operation) => operation.name)
    for (const forbidden of [
      'text_to_speech',
      'generate_image',
      'generate_video',
      'generate_music',
      'query_generation_task',
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })
})
