import path from 'node:path'
import { z } from 'zod'
import { VideoAnalyzerError, invalidInput } from '../utils/errors.js'
import { removeDir } from '../utils/fsUtils.js'
import {
  MAX_FRAMES_PER_EXTRACTION,
  MAX_SCENE_FRAMES,
  MIN_INTERVAL_SEC,
  extractFramesAtInterval,
  extractFramesAtTimestamps,
  extractFramesEvenly,
  extractSceneFrames,
} from '../services/ffmpeg.js'
import { createArtifactDir, prepareMedia } from './shared.js'
import type { Operation, OperationResult } from './types.js'

export const extractFramesInput = z.object({
  videoPath: z
    .string()
    .min(1)
    .describe('Local path, file:// URI, or direct http(s) media URL. No AI is used.'),
  mode: z
    .enum(['even', 'interval', 'timestamps', 'scene'])
    .optional()
    .describe(
      'even = N evenly spaced frames (default), interval = one frame every intervalSec, timestamps = the exact list supplied, scene = one frame per detected scene change.',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_FRAMES_PER_EXTRACTION)
    .optional()
    .describe('For mode "even": how many frames to extract. Default 5.'),
  intervalSec: z
    .number()
    .min(
      MIN_INTERVAL_SEC,
      `intervalSec must be at least ${MIN_INTERVAL_SEC} seconds; use mode "even" for denser sampling.`,
    )
    .optional()
    .describe(
      `For mode "interval": seconds between frames, ${MIN_INTERVAL_SEC} or more. Extraction stops at the configured frame budget (VIDEO_ANALYZER_MAX_FRAMES, hard ceiling 500).`,
    ),
  timestamps: z
    .array(z.number().min(0))
    .max(100)
    .optional()
    .describe('For mode "timestamps": timestamps in seconds.'),
  sceneThreshold: z
    .number()
    .min(0.05)
    .max(0.95)
    .optional()
    .describe('For mode "scene": scene-change sensitivity between 0.05 and 0.95. Default 0.35.'),
  maxImages: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum images to return in this page. Default 20.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of frames to skip before returning results, for pagination. Default 0.'),
  outputDir: z
    .string()
    .optional()
    .describe(
      'Parent directory for the frames. Each request writes into a new subfolder of it, so earlier frames are never overwritten or mixed into this result. Defaults to an auto-created folder under the output directory.',
    ),
})

const DEFAULT_COUNT = 5
const DEFAULT_SCENE_THRESHOLD = 0.35
const DEFAULT_MAX_IMAGES = 20

/**
 * Reject timestamps at or beyond the end of the media.
 *
 * FFmpeg would otherwise fail the whole run (and leave the earlier frames on
 * disk) without naming the offending value, so this is checked up front with the
 * duration in the message.
 */
function assertTimestampsWithinDuration(timestamps: number[], durationSeconds: number): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return
  const index = timestamps.findIndex((timestamp) => timestamp >= durationSeconds)
  if (index === -1) return
  const duration = durationSeconds.toFixed(2)
  throw invalidInput(
    `Timestamp ${timestamps[index]}s is outside the media: the clip is ${duration}s long.`,
    {
      hint: `Use values from 0 up to ${duration}. Timestamps are indexed from the start of the media.`,
      details: {
        timestamp: timestamps[index],
        index,
        durationSeconds: Number(duration),
      },
    },
  )
}

export const extractFramesOperation: Operation<typeof extractFramesInput> = {
  name: 'extract_frames',
  title: 'Extract Frames',
  description:
    'Extract frames from a video by even spacing, fixed interval, explicit timestamps, or scene changes. Writes JPEGs to disk and returns their paths. No AI provider required.',
  inputSchema: extractFramesInput,
  category: 'local',
  requiresGemini: false,

  async run(input, ctx): Promise<OperationResult> {
    const mode = input.mode ?? 'even'
    const maxImages = input.maxImages ?? DEFAULT_MAX_IMAGES
    const offset = input.offset ?? 0

    // Validate mode-specific arguments before doing any expensive work.
    if (mode === 'interval' && input.intervalSec === undefined) {
      throw invalidInput('mode "interval" requires intervalSec.')
    }
    if (mode === 'timestamps' && (!input.timestamps || input.timestamps.length === 0)) {
      throw invalidInput('mode "timestamps" requires a non-empty timestamps array.')
    }

    const warnings: string[] = []
    const prepared = await prepareMedia(input.videoPath, ctx)
    let outDir: string | undefined

    try {
      if (!prepared.metadata.hasVideo) {
        throw new VideoAnalyzerError(
          'UNSUPPORTED_INPUT',
          'Frame extraction needs a video stream; this input has none.',
          { hint: 'Use transcribe_video for audio-only files.' },
        )
      }

      // Validate the whole array before the first subprocess: one bad value used
      // to discard the frames the valid timestamps produced and report a bare
      // "ffmpeg failed".
      if (mode === 'timestamps') {
        assertTimestampsWithinDuration(
          input.timestamps as number[],
          prepared.metadata.durationSeconds,
        )
      }

      // Every extraction gets its own folder. Writing straight into a
      // caller-supplied directory would leave frames from an earlier run in the
      // listing, so `totalFrames`, paging, and `truncated` would describe a
      // mixed set instead of the frames this request produced. `outputDir` is a
      // parent; `createArtifactDir` resolves it and returns an absolute path.
      outDir = await createArtifactDir(ctx.config, 'frames', input.outputDir)

      let paths: string[] = []
      const timestamps: number[] = []
      let truncated = false
      let intervalStats: { expectedFrames: number; frameBudget: number } | undefined

      if (mode === 'even') {
        // `count` defines the whole frame set; pagination pages through it, so
        // extraction is never trimmed to the current page.
        paths = await extractFramesEvenly(prepared.path, input.count ?? DEFAULT_COUNT, ctx.config, {
          outDir,
          durationSeconds: prepared.metadata.durationSeconds,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      } else if (mode === 'interval') {
        const intervalSec = input.intervalSec as number
        const result = await extractFramesAtInterval(prepared.path, intervalSec, ctx.config, {
          outDir,
          durationSeconds: prepared.metadata.durationSeconds,
          maxFrames: ctx.config.maxFrames,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        paths = result.paths
        truncated = result.truncated
        intervalStats = { expectedFrames: result.expectedFrames, frameBudget: result.frameBudget }
        timestamps.push(...result.timestamps)
        if (!result.timestampsExact) {
          warnings.push(
            'ffmpeg did not report frame times, so the timestamps are the requested sampling grid (every intervalSec), not exact presentation times.',
          )
        }
        if (result.truncated) {
          // `0` and any value at or above the hard ceiling both end up at the
          // ceiling, where raising the setting would change nothing.
          const atHardCeiling =
            result.frameBudget === MAX_FRAMES_PER_EXTRACTION &&
            (ctx.config.maxFrames <= 0 || ctx.config.maxFrames >= MAX_FRAMES_PER_EXTRACTION)
          warnings.push(
            `intervalSec ${intervalSec} would produce about ${result.expectedFrames} frames over ${prepared.metadata.durationSeconds.toFixed(1)}s; extraction stopped after ${paths.length} frames against the ${result.frameBudget}-frame budget. ${
              atHardCeiling
                ? 'That is the hard ceiling per extraction, so use a larger intervalSec or mode "even" to cover the whole clip.'
                : 'Raise VIDEO_ANALYZER_MAX_FRAMES, use a larger intervalSec, or use mode "even" for a fixed spread.'
            }`,
          )
        }
      } else if (mode === 'timestamps') {
        const requested = input.timestamps as number[]
        paths = await extractFramesAtTimestamps(prepared.path, requested, ctx.config, {
          outDir,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        timestamps.push(...requested)
      } else {
        const sceneBudget = ctx.config.maxFrames > 0 ? ctx.config.maxFrames : 0
        const sceneLimit =
          sceneBudget > 0 ? Math.min(sceneBudget, MAX_SCENE_FRAMES) : MAX_SCENE_FRAMES
        const result = await extractSceneFrames(
          prepared.path,
          input.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD,
          ctx.config,
          {
            outDir,
            maxFrames: sceneLimit,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
        )
        paths = result.paths
        truncated = result.truncated
        timestamps.push(...result.timestamps)
        if (result.truncated) {
          warnings.push(
            `Scene detection produced more frames than the ${sceneLimit}-frame safety ceiling; the list was truncated.`,
          )
        }
      }

      if (paths.length === 0) {
        return {
          summary:
            'No frames were extracted. The video may be shorter than the sampling interval, or no scene changes exceeded the threshold.',
          data: {
            mode,
            outputDir: outDir,
            frames: [],
            totalFrames: 0,
            offset,
            hasMore: false,
            truncated,
            ...intervalStats,
          },
          images: [],
          warnings,
        }
      }

      const page = paths.slice(offset, offset + maxImages)
      const pageTimestamps = timestamps.slice(offset, offset + maxImages)
      const hasMore = offset + page.length < paths.length

      if (hasMore) {
        warnings.push(
          `Returned frames ${offset + 1}-${offset + page.length} of ${paths.length}. Re-run with offset=${offset + page.length} for the next page.`,
        )
      }

      const images = page.map((framePath, index) => ({
        path: framePath,
        mimeType: 'image/jpeg',
        label:
          pageTimestamps[index] !== undefined
            ? `t=${Number(pageTimestamps[index]).toFixed(2)}s`
            : path.basename(framePath),
      }))

      return {
        summary: `Extracted ${page.length} frame(s) (mode: ${mode}) into ${outDir}.`,
        data: {
          mode,
          outputDir: outDir,
          totalFrames: paths.length,
          offset,
          hasMore,
          truncated,
          ...intervalStats,
          ...(pageTimestamps.length > 0 ? { timestamps: pageTimestamps } : {}),
        },
        images,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } catch (error) {
      // A failed extraction must not leave a half-populated folder behind, so the
      // caller can trust that reported output directories are complete.
      await removeDir(outDir)
      throw error
    } finally {
      await prepared.media.cleanup()
    }
  },
}
