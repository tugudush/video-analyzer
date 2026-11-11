import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { analyzeVideoOperation } from '../../src/operations/analyzeVideo.js'
import { searchTimestampOperation } from '../../src/operations/searchTimestamp.js'
import { summarizeVideoOperation } from '../../src/operations/summarizeVideo.js'
import { transcribeVideoOperation } from '../../src/operations/transcribeVideo.js'
import { createLogger } from '../../src/utils/logger.js'
import type { Operation, OperationContext } from '../../src/operations/types.js'

const REMOTE = 'https://media.example.com/demo.mp4'

const fetchMock = vi.fn()

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
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
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
})
