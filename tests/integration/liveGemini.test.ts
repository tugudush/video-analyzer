import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { analyzeVideoOperation } from '../../src/operations/analyzeVideo.js'
import { executeOperation } from '../../src/operations/execute.js'
import { createSampleVideo, ffmpegAvailable } from '../helpers/media.js'

/**
 * Opt-in end-to-end check of the real SDK wiring: upload, ACTIVE polling, and
 * generation against the configured model. It needs both `GEMINI_API_KEY` and
 * `VIDEO_ANALYZER_LIVE_TEST=1`, so the default suite stays offline and free and
 * a transient network failure cannot break a normal run.
 */
const requested = process.env['VIDEO_ANALYZER_LIVE_TEST'] === '1'
const config = loadConfig()
const enabled = requested && Boolean(config.geminiApiKey) && (await ffmpegAvailable())

describe.skipIf(!enabled)(
  'live Gemini smoke test (requires VIDEO_ANALYZER_LIVE_TEST=1, GEMINI_API_KEY, and ffmpeg)',
  () => {
    let workDir: string

    beforeAll(async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'video-analyzer-live-'))
    })

    afterAll(async () => {
      await rm(workDir, { recursive: true, force: true })
    })

    it('answers a question about a generated clip', async () => {
      const sample = await createSampleVideo(workDir, {
        durationSeconds: 2,
        width: 320,
        height: 240,
      })

      const result = await executeOperation(
        analyzeVideoOperation,
        {
          videoPath: sample.path,
          question: 'Describe what is visible and whether a steady tone is audible.',
        },
        config,
      )

      expect(result.summary.trim().length).toBeGreaterThan(0)
      expect(result.data).toMatchObject({
        question: 'Describe what is visible and whether a steady tone is audible.',
        durationSeconds: expect.any(Number),
        source: 'local',
      })
    }, 180_000)
  },
)
