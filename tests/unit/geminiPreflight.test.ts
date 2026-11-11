import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { analyzeVideoOperation } from '../../src/operations/analyzeVideo.js'
import { searchTimestampOperation } from '../../src/operations/searchTimestamp.js'
import { summarizeVideoOperation } from '../../src/operations/summarizeVideo.js'
import { transcribeVideoOperation } from '../../src/operations/transcribeVideo.js'
import { createLogger } from '../../src/utils/logger.js'
import type { Operation, OperationContext } from '../../src/operations/types.js'

const REMOTE = 'https://media.example.com/demo.mp4'

const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
}))
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchMock,
}))

function context(): OperationContext {
  // No API key: the pre-flight check is the behaviour under test.
  return { config: loadConfig({}), logger: createLogger('silent') }
}

const geminiOperations: Array<{ operation: Operation; input: Record<string, unknown> }> = [
  { operation: analyzeVideoOperation, input: { videoPath: REMOTE, question: 'What happens?' } },
  { operation: summarizeVideoOperation, input: { videoPath: REMOTE } },
  { operation: searchTimestampOperation, input: { videoPath: REMOTE, query: 'a red car' } },
  { operation: transcribeVideoOperation, input: { videoPath: REMOTE } },
]

describe('Gemini pre-flight', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it.each(geminiOperations)(
    'reports the missing key before downloading media ($operation.name)',
    async ({ operation, input }) => {
      await expect(operation.run(input as never, context())).rejects.toMatchObject({
        code: 'CONFIG_MISSING',
      })

      // The most expensive part of the call must not have happened.
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('still validates the transcript target before the provider check', async () => {
    await expect(
      transcribeVideoOperation.run({ videoPath: REMOTE, outputPath: './notes.srt' }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not create output directories for a request that fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'video-analyzer-preflight-'))
    try {
      const target = path.join(dir, 'nested', 'deeper', 'transcript.txt')

      await expect(
        transcribeVideoOperation.run({ videoPath: REMOTE, outputPath: target }, context()),
      ).rejects.toMatchObject({ code: 'CONFIG_MISSING' })

      // Validation must not leave a directory tree behind for a failed call.
      await expect(stat(path.join(dir, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
