import path from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
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
    .optional()
    .describe(
      'Required for a new extraction: local path, file:// URI, or direct http(s) media URL.',
    ),
  frameSetDir: z
    .string()
    .min(1)
    .optional()
    .describe(
      'For another page, pass data.outputDir from a previous extraction instead of videoPath.',
    ),
  mode: z
    .enum(['even', 'interval', 'timestamps', 'scene'])
    .optional()
    .describe(
      'even = N evenly spaced frames (default), interval = one frame every intervalSec, timestamps = frames at the requested times, scene = one frame per detected scene change.',
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
      `For mode "interval": seconds between samples, ${MIN_INTERVAL_SEC} or more. Labels are approximate sampling-grid times. Extraction stops at the configured frame budget (VIDEO_ANALYZER_MAX_FRAMES, hard ceiling 500).`,
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
const FRAME_SET_FILE = '.video-analyzer-frames.json'
const INTERVAL_TIMESTAMP_WARNING =
  'Interval timestamps are approximate sampling-grid times, not the presentation times of the selected source frames.'
const REQUESTED_TIMESTAMP_WARNING =
  'Timestamp labels are requested times, not the presentation times of the selected source frames. Extraction selects the first frame at or after the requested time, or the final frame if the seek reaches the end.'
const frameSetSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['even', 'interval', 'timestamps', 'scene']),
  files: z.array(z.string().regex(/^frame-\d{4}\.jpg$/)).max(MAX_FRAMES_PER_EXTRACTION),
  timestamps: z.array(z.number().nonnegative()).max(MAX_FRAMES_PER_EXTRACTION),
  truncated: z.boolean(),
  warnings: z.array(z.string().max(2000)).max(10),
  intervalStats: z.object({ expectedFrames: z.number(), frameBudget: z.number() }).optional(),
})
type FrameSet = z.infer<typeof frameSetSchema>

async function loadFrameSet(dir: string): Promise<FrameSet> {
  const manifest = path.join(dir, FRAME_SET_FILE)
  let raw: string
  try {
    const info = await stat(manifest)
    if (!info.isFile() || info.size > 128 * 1024) throw new Error('Invalid manifest size.')
    raw = await readFile(manifest, 'utf8')
  } catch (error) {
    throw invalidInput(`Could not read the frame set in ${dir}.`, {
      hint: 'Use data.outputDir from a completed extraction whose files still exist.',
      cause: error,
    })
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw invalidInput(`Invalid frame set manifest in ${dir}.`, { cause: error })
  }
  const parsed = frameSetSchema.safeParse(value)
  if (
    !parsed.success ||
    (parsed.data.timestamps.length !== 0 &&
      parsed.data.timestamps.length !== parsed.data.files.length) ||
    new Set(parsed.data.files).size !== parsed.data.files.length
  ) {
    throw invalidInput(`Invalid frame set manifest in ${dir}.`)
  }
  return parsed.data
}

/**
 * Page summary.
 *
 * Paging a saved frame set performs no extraction, so it must not claim to have
 * produced the frames it only read back from disk.
 */
function pageSummary(
  frameSet: FrameSet,
  outDir: string,
  offset: number,
  pageLength: number,
  fromExtraction: boolean,
): string {
  const { mode, files } = frameSet
  if (files.length === 0) {
    return 'No frames were extracted. The video may be shorter than the sampling interval, or no scene changes exceeded the threshold.'
  }
  if (pageLength === 0) {
    return `No frames on this page: offset ${offset} is past the ${files.length} frame(s) in this frame set (mode: ${mode}).`
  }
  if (!fromExtraction) {
    return `Returned frames ${offset + 1}-${offset + pageLength} of ${files.length} from ${outDir} (mode: ${mode}).`
  }
  return `Extracted ${pageLength} frame(s) (mode: ${mode}) into ${outDir}.`
}

async function renderFramePage(
  frameSet: FrameSet,
  outDir: string,
  offset: number,
  maxImages: number,
  fromExtraction: boolean,
): Promise<OperationResult> {
  const { mode, files, timestamps, truncated, intervalStats } = frameSet
  const warnings = [...frameSet.warnings]
  if (mode === 'interval' && !warnings.includes(INTERVAL_TIMESTAMP_WARNING)) {
    warnings.push(INTERVAL_TIMESTAMP_WARNING)
  }
  if (mode === 'timestamps' && !warnings.includes(REQUESTED_TIMESTAMP_WARNING)) {
    warnings.push(REQUESTED_TIMESTAMP_WARNING)
  }
  const page = files.slice(offset, offset + maxImages).map((file) => path.join(outDir, file))
  const pageTimestamps = timestamps.slice(offset, offset + maxImages)
  const hasMore = offset + page.length < files.length
  for (const frame of page) {
    let info
    try {
      info = await stat(frame)
    } catch (error) {
      throw invalidInput(`Frame is missing from the saved frame set: ${frame}`, { cause: error })
    }
    if (!info.isFile() || info.size === 0) {
      throw invalidInput(`Frame is not a readable image file: ${frame}`)
    }
  }

  if (hasMore) {
    warnings.push(
      `Returned frames ${offset + 1}-${offset + page.length} of ${files.length}. Use frameSetDir=${outDir} and offset=${offset + page.length} for the next page.`,
    )
  }

  const images = page.map((framePath, index) => ({
    path: framePath,
    mimeType: 'image/jpeg',
    label:
      pageTimestamps[index] !== undefined
        ? mode === 'timestamps'
          ? `requested t=${pageTimestamps[index]}s`
          : `t=${Number(pageTimestamps[index]).toFixed(2)}s`
        : path.basename(framePath),
  }))

  return {
    summary: pageSummary(frameSet, outDir, offset, page.length, fromExtraction),
    data: {
      mode,
      outputDir: outDir,
      ...(files.length === 0 ? { frames: [] } : {}),
      totalFrames: files.length,
      offset,
      hasMore,
      truncated,
      ...intervalStats,
      ...(pageTimestamps.length > 0 ? { timestamps: pageTimestamps } : {}),
    },
    images,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

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

    if (input.frameSetDir) {
      if (
        input.videoPath !== undefined ||
        input.mode !== undefined ||
        input.count !== undefined ||
        input.intervalSec !== undefined ||
        input.timestamps !== undefined ||
        input.sceneThreshold !== undefined ||
        input.outputDir !== undefined
      ) {
        throw invalidInput('frameSetDir cannot be combined with extraction input or options.', {
          hint: 'Use frameSetDir with only offset and maxImages to page an existing frame set.',
        })
      }
      const outDir = path.resolve(input.frameSetDir)
      return renderFramePage(await loadFrameSet(outDir), outDir, offset, maxImages, false)
    }
    if (!input.videoPath) {
      throw invalidInput('A new extraction requires videoPath.', {
        hint: 'To page an existing extraction, pass frameSetDir instead.',
      })
    }

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

      // Cover art is a still image stream, so the metadata's choice of motion
      // video stream decides what every mode maps below.
      const videoStreamIndex = prepared.metadata.video?.index ?? 0

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
          videoStreamIndex,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      } else if (mode === 'interval') {
        const intervalSec = input.intervalSec as number
        const result = await extractFramesAtInterval(prepared.path, intervalSec, ctx.config, {
          outDir,
          durationSeconds: prepared.metadata.durationSeconds,
          maxFrames: ctx.config.maxFrames,
          videoStreamIndex,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        paths = result.paths
        truncated = result.truncated
        intervalStats = { expectedFrames: result.expectedFrames, frameBudget: result.frameBudget }
        timestamps.push(...result.timestamps)
        if (result.truncated) {
          // `0` and any value at or above the hard ceiling both end up at the
          // ceiling, where raising the setting would change nothing.
          const atHardCeiling =
            result.frameBudget === MAX_FRAMES_PER_EXTRACTION &&
            (ctx.config.maxFrames <= 0 || ctx.config.maxFrames >= MAX_FRAMES_PER_EXTRACTION)
          if (paths.length >= result.frameBudget) {
            warnings.push(
              `intervalSec ${intervalSec} would produce about ${result.expectedFrames} frames over ${prepared.metadata.durationSeconds.toFixed(1)}s; extraction stopped after ${paths.length} frames against the ${result.frameBudget}-frame budget. ${
                atHardCeiling
                  ? 'That is the hard ceiling per extraction, so use a larger intervalSec or mode "even" to cover the whole clip.'
                  : 'Raise VIDEO_ANALYZER_MAX_FRAMES, use a larger intervalSec, or use mode "even" for a fixed spread.'
              }`,
            )
          } else {
            warnings.push(
              `Expected about ${result.expectedFrames} interval frames, but ffmpeg produced ${paths.length}; the media may not cover the whole sampling grid.`,
            )
          }
        }
      } else if (mode === 'timestamps') {
        const requested = input.timestamps as number[]
        paths = await extractFramesAtTimestamps(prepared.path, requested, ctx.config, {
          outDir,
          videoStreamIndex,
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
            videoStreamIndex,
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

      const frameSet: FrameSet = {
        version: 1,
        mode,
        files: paths.map((framePath) => path.basename(framePath)),
        timestamps,
        truncated,
        warnings,
        ...(intervalStats ? { intervalStats } : {}),
      }
      try {
        await writeFile(path.join(outDir, FRAME_SET_FILE), JSON.stringify(frameSet), {
          encoding: 'utf8',
          flag: 'wx',
        })
      } catch (error) {
        throw new VideoAnalyzerError('OUTPUT_FAILED', 'Could not save frame set metadata.', {
          details: { outputDir: outDir },
          cause: error,
        })
      }
      return await renderFramePage(frameSet, outDir, offset, maxImages, true)
    } catch (error) {
      // A failed extraction must not leave a half-populated folder behind, so the
      // caller can trust that reported output directories are complete.
      await removeDir(outDir, ctx.logger)
      throw error
    } finally {
      await prepared.media.cleanup()
    }
  },
}
