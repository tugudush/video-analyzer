import path from 'node:path'
import { z } from 'zod'
import { VideoAnalyzerError, invalidInput } from '../utils/errors.js'
import { ensureDir } from '../utils/fsUtils.js'
import {
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
    .max(500)
    .optional()
    .describe('For mode "even": how many frames to extract. Default 5.'),
  intervalSec: z
    .number()
    .positive()
    .optional()
    .describe('For mode "interval": seconds between frames.'),
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
      'Directory to write frames into. Defaults to an auto-created folder under the output directory.',
    ),
})

const DEFAULT_COUNT = 5
const DEFAULT_SCENE_THRESHOLD = 0.35
const DEFAULT_MAX_IMAGES = 20

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

    try {
      if (mode !== 'scene' && !prepared.metadata.hasVideo) {
        throw new VideoAnalyzerError(
          'UNSUPPORTED_INPUT',
          'Frame extraction needs a video stream; this input has none.',
          { hint: 'Use transcribe_video for audio-only files.' },
        )
      }

      const outDir = input.outputDir
        ? path.resolve(input.outputDir)
        : await createArtifactDir(ctx.config, 'frames')
      await ensureDir(outDir)

      let paths: string[] = []
      const timestamps: number[] = []

      if (mode === 'even') {
        // `count` defines the whole frame set; pagination pages through it, so
        // extraction is never trimmed to the current page.
        paths = await extractFramesEvenly(prepared.path, input.count ?? DEFAULT_COUNT, ctx.config, {
          outDir,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      } else if (mode === 'interval') {
        paths = await extractFramesAtInterval(
          prepared.path,
          input.intervalSec as number,
          ctx.config,
          {
            outDir,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
        )
        paths.forEach((_, index) => timestamps.push(index * (input.intervalSec as number)))
      } else if (mode === 'timestamps') {
        const requested = input.timestamps as number[]
        paths = await extractFramesAtTimestamps(prepared.path, requested, ctx.config, {
          outDir,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        timestamps.push(...requested)
      } else {
        const sceneBudget = ctx.config.maxFrames > 0 ? ctx.config.maxFrames : 0
        const result = await extractSceneFrames(
          prepared.path,
          input.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD,
          ctx.config,
          {
            outDir,
            maxFrames: sceneBudget > 0 ? Math.min(sceneBudget, 200) : 200,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
        )
        paths = result.paths
        timestamps.push(...result.timestamps)
        if (result.truncated) {
          warnings.push(
            `Scene detection produced more frames than the ${sceneBudget || 200}-frame safety ceiling; the list was truncated.`,
          )
        }
      }

      if (paths.length === 0) {
        return {
          summary:
            'No frames were extracted. The video may be shorter than the sampling interval, or no scene changes exceeded the threshold.',
          data: { mode, outputDir: outDir, frames: [], totalFrames: 0, offset, hasMore: false },
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
          ...(pageTimestamps.length > 0 ? { timestamps: pageTimestamps } : {}),
        },
        images,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } finally {
      await prepared.media.cleanup()
    }
  },
}
