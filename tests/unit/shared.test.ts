import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { loadConfig } from '../../src/config.js'
import { executeOperation } from '../../src/operations/execute.js'
import {
  createArtifactDir,
  formatBytes,
  formatTimestamp,
  getGeminiService,
} from '../../src/operations/shared.js'
import { createLogger } from '../../src/utils/logger.js'

describe('formatTimestamp', () => {
  it('renders HH:MM:SS.mmm', () => {
    expect(formatTimestamp(0)).toBe('00:00:00.000')
    expect(formatTimestamp(65.25)).toBe('00:01:05.250')
    expect(formatTimestamp(3725.5)).toBe('01:02:05.500')
  })

  it('carries rounded milliseconds into the seconds field', () => {
    expect(formatTimestamp(1.9996)).toBe('00:00:02.000')
    expect(formatTimestamp(5.9999)).toBe('00:00:06.000')
    expect(formatTimestamp(59.9999)).toBe('00:01:00.000')
    expect(formatTimestamp(1.9994)).toBe('00:00:01.999')
  })

  it('handles invalid input', () => {
    expect(formatTimestamp(Number.NaN)).toBe('unknown')
    expect(formatTimestamp(-1)).toBe('unknown')
  })
})

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

it('reuses Gemini services only within the same config and logger', () => {
  const config = loadConfig({ GEMINI_API_KEY: 'test-key' })
  const first = { config, logger: createLogger('silent') }
  const second = { config, logger: createLogger('silent') }
  expect(getGeminiService(first)).toBe(getGeminiService(first))
  expect(getGeminiService(first)).not.toBe(getGeminiService(second))
})

it('keeps the default embedding logger stable for one config', async () => {
  const config = loadConfig({})
  const loggers: unknown[] = []
  const operation = {
    inputSchema: z.object({}),
    async run(_input: object, ctx: { logger: unknown }) {
      loggers.push(ctx.logger)
      return { summary: 'ok' }
    },
  }
  await executeOperation(operation, {}, config)
  await executeOperation(operation, {}, config)
  expect(loggers[0]).toBe(loggers[1])
})

/**
 * A base directory that cannot be created is a caller mistake, so it must not
 * surface as `INTERNAL` with a raw filesystem message.
 */
describe('createArtifactDir', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-artifact-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates a new subdirectory of the requested base', async () => {
    const created = await createArtifactDir(loadConfig({}), 'frames', dir)
    expect(path.dirname(created)).toBe(path.resolve(dir))
  })

  it('reports a file used as outputDir as OUTPUT_FAILED naming the argument', async () => {
    const file = path.join(dir, 'not-a-dir.txt')
    await writeFile(file, 'x', 'utf8')

    await expect(createArtifactDir(loadConfig({}), 'frames', file)).rejects.toMatchObject({
      code: 'OUTPUT_FAILED',
      hint: expect.stringContaining('outputDir'),
      details: { outputDir: path.resolve(file) },
    })
  })

  it('names the setting when the configured output root is unusable', async () => {
    const file = path.join(dir, 'root.txt')
    await writeFile(file, 'x', 'utf8')

    await expect(
      createArtifactDir(loadConfig({ VIDEO_ANALYZER_OUTPUT_DIR: file }), 'frames'),
    ).rejects.toMatchObject({
      code: 'OUTPUT_FAILED',
      hint: expect.stringContaining('VIDEO_ANALYZER_OUTPUT_DIR'),
    })
  })
})
