import path from 'node:path'
import { z } from 'zod'
import { VideoAnalyzerError, invalidInput } from '../utils/errors.js'
import { createTempDir, ensureDir, removeDir } from '../utils/fsUtils.js'
import {
  extractFramesEvenly,
  readFrameBase64,
  renderRedactedVideo,
  renderRedactionPreview,
  type RedactionEffect,
  type RedactionRegion,
} from '../services/ffmpeg.js'
import {
  createArtifactDir,
  extractJsonPayload,
  formatTimestamp,
  getGeminiService,
  prepareMedia,
} from './shared.js'
import type { Operation, OperationResult } from './types.js'

export const redactRegionInput = z.object({
  x: z.number().min(0).describe('Left edge in pixels of the source frame.'),
  y: z.number().min(0).describe('Top edge in pixels of the source frame.'),
  width: z.number().min(2).describe('Region width in pixels.'),
  height: z.number().min(2).describe('Region height in pixels.'),
  startTime: z.number().min(0).optional().describe('Start of the redaction window in seconds.'),
  endTime: z.number().min(0).optional().describe('End of the redaction window in seconds.'),
  label: z.string().optional().describe('Optional label describing what the region hides.'),
})

export const redactSensitiveInput = z.object({
  videoPath: z.string().min(1).describe('Local path, file:// URI, or direct http(s) media URL.'),
  effect: z
    .enum(['blur', 'pixelate', 'blackout'])
    .optional()
    .describe('How to hide the regions. Default "blur".'),
  regions: z
    .array(redactRegionInput)
    .optional()
    .describe('Explicit regions to hide. Required unless detectionMode is "ai".'),
  detectionMode: z
    .enum(['manual', 'ai'])
    .optional()
    .describe(
      '"manual" (default) uses the supplied regions. "ai" asks Gemini to locate sensitive regions.',
    ),
  allowRemoteAnalysis: z
    .boolean()
    .optional()
    .describe(
      'Must be true when detectionMode is "ai": frames are uploaded to Gemini, so the content leaves this machine.',
    ),
  sampleCount: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe('How many frames to sample for AI detection. Default 8.'),
  previewOnly: z
    .boolean()
    .optional()
    .describe(
      'When true, return preview frames with the regions outlined instead of rendering a video.',
    ),
  outputPath: z
    .string()
    .optional()
    .describe(
      'Where to write the redacted video. Defaults to an auto-created .mp4 in the output directory.',
    ),
})

const DETECTION_PROMPT = (width: number, height: number) =>
  [
    `These frames come from a screen recording that is ${width}x${height} pixels.`,
    'Identify regions that expose sensitive information: API keys, tokens, passwords, secrets,',
    'private keys, email addresses, phone numbers, account IDs, internal hostnames or URLs.',
    '',
    'Reply with a JSON array only, no prose and no code fences. Each element must be:',
    '{"x":<int>,"y":<int>,"width":<int>,"height":<int>,"label":"<what it hides>","confidence":"low|medium|high"}',
    '',
    'Coordinates are pixels in the frame, with the origin at the top-left. Merge overlapping',
    'detections into one region. Reply with [] when nothing sensitive is visible.',
  ].join('\n')

interface DetectedRegion extends RedactionRegion {
  confidence?: string
}

/** Validate/clamp model-provided regions against the real frame size. */
export function normalizeDetectedRegions(
  payload: unknown,
  width: number,
  height: number,
): DetectedRegion[] {
  if (!Array.isArray(payload)) return []

  const regions: DetectedRegion[] = []
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const x = Number(record['x'])
    const y = Number(record['y'])
    const w = Number(record['width'])
    const h = Number(record['height'])
    if (![x, y, w, h].every(Number.isFinite)) continue
    if (w < 2 || h < 2) continue

    const clampedX = Math.min(Math.max(0, Math.round(x)), Math.max(0, width - 2))
    const clampedY = Math.min(Math.max(0, Math.round(y)), Math.max(0, height - 2))
    const clampedW = Math.min(Math.round(w), width - clampedX)
    const clampedH = Math.min(Math.round(h), height - clampedY)
    if (clampedW < 2 || clampedH < 2) continue

    regions.push({
      x: clampedX,
      y: clampedY,
      width: clampedW,
      height: clampedH,
      ...(typeof record['label'] === 'string' ? { label: record['label'] } : {}),
      ...(typeof record['confidence'] === 'string' ? { confidence: record['confidence'] } : {}),
    })
  }
  return regions
}

/** Validate caller-supplied regions against the real frame size. */
export function normalizeManualRegions(
  regions: z.infer<typeof redactRegionInput>[],
  width: number,
  height: number,
): RedactionRegion[] {
  return regions.map((region, index) => {
    if (
      region.endTime !== undefined &&
      region.startTime !== undefined &&
      region.endTime <= region.startTime
    ) {
      throw invalidInput(`Region ${index + 1}: endTime must be greater than startTime.`)
    }
    if (region.x >= width || region.y >= height) {
      throw invalidInput(
        `Region ${index + 1}: origin (${region.x}, ${region.y}) is outside the ${width}x${height} frame.`,
      )
    }

    const clampedWidth = Math.min(Math.round(region.width), width - Math.round(region.x))
    const clampedHeight = Math.min(Math.round(region.height), height - Math.round(region.y))

    return {
      x: Math.round(region.x),
      y: Math.round(region.y),
      width: Math.max(2, clampedWidth),
      height: Math.max(2, clampedHeight),
      ...(region.startTime !== undefined ? { startTime: region.startTime } : {}),
      ...(region.endTime !== undefined ? { endTime: region.endTime } : {}),
      ...(region.label ? { label: region.label } : {}),
    }
  })
}

function describeRegions(regions: RedactionRegion[]): string {
  return regions
    .map((region, index) => {
      const window =
        region.startTime !== undefined || region.endTime !== undefined
          ? ` [${formatTimestamp(region.startTime ?? 0)} – ${formatTimestamp(region.endTime ?? region.startTime ?? 0)}]`
          : ' [whole video]'
      const label = region.label ? ` (${region.label})` : ''
      return `  ${index + 1}. ${region.width}x${region.height} at (${region.x}, ${region.y})${window}${label}`
    })
    .join('\n')
}

export const redactSensitiveOperation: Operation<typeof redactSensitiveInput> = {
  name: 'redact_sensitive',
  title: 'Redact Sensitive Regions',
  description:
    'Hide sensitive areas of a video with blur, pixelate, or blackout. Regions are supplied explicitly, or Gemini can locate them when allowRemoteAnalysis is true. Manual mode needs no AI provider.',
  inputSchema: redactSensitiveInput,
  category: 'editing',
  requiresGemini: false,

  async run(input, ctx): Promise<OperationResult> {
    const effect: RedactionEffect = input.effect ?? 'blur'
    const detectionMode = input.detectionMode ?? 'manual'
    const warnings: string[] = []

    if (detectionMode === 'ai' && input.allowRemoteAnalysis !== true) {
      throw new VideoAnalyzerError(
        'CONSENT_REQUIRED',
        'AI-assisted detection uploads frames of this video to Google.',
        {
          hint: 'Set allowRemoteAnalysis: true to confirm, or supply explicit regions with detectionMode "manual".',
        },
      )
    }

    if (detectionMode === 'manual' && (!input.regions || input.regions.length === 0)) {
      throw invalidInput('detectionMode "manual" requires at least one region.', {
        hint: 'Provide regions as {x, y, width, height}, or use detectionMode "ai" with allowRemoteAnalysis: true.',
      })
    }

    const prepared = await prepareMedia(input.videoPath, ctx)
    const workDir = await createTempDir()

    try {
      const { width, height } = prepared.metadata.video ?? { width: 0, height: 0 }
      if (!width || !height) {
        throw new VideoAnalyzerError(
          'UNSUPPORTED_INPUT',
          'Redaction needs a video stream with known dimensions.',
        )
      }

      let regions: RedactionRegion[] = input.regions
        ? normalizeManualRegions(input.regions, width, height)
        : []

      if (detectionMode === 'ai') {
        ctx.onProgress?.('Sampling frames for sensitive-region detection…')
        const sampleCount = input.sampleCount ?? 8

        // Helper frames are capped at 1280px wide and never upscaled, so the
        // detections Gemini reports map back to the source with one factor.
        const sampleWidth = Math.min(1280, width)
        const sampleHeight = Math.max(2, Math.round((height * sampleWidth) / width))
        const scale = width / sampleWidth

        const frames = await extractFramesEvenly(prepared.path, sampleCount, ctx.config, {
          outDir: path.join(workDir, 'samples'),
          maxWidth: sampleWidth,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })

        if (frames.length === 0) {
          throw new VideoAnalyzerError(
            'MEDIA_PROCESSING_FAILED',
            'Could not sample frames for AI detection.',
          )
        }

        const images = await Promise.all(
          frames.map(async (framePath) => ({
            kind: 'inlineImage' as const,
            mimeType: 'image/jpeg',
            data: await readFrameBase64(framePath),
          })),
        )

        ctx.onProgress?.('Asking Gemini to locate sensitive regions…')
        const response = await getGeminiService(ctx).generate({
          parts: [...images, { kind: 'text', text: DETECTION_PROMPT(sampleWidth, sampleHeight) }],
          temperature: 0,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })

        const payload = extractJsonPayload(response)
        const detected = normalizeDetectedRegions(payload, sampleWidth, sampleHeight)
        const scaled: RedactionRegion[] = detected.map((region) => ({
          x: Math.round(region.x * scale),
          y: Math.round(region.y * scale),
          width: Math.round(region.width * scale),
          height: Math.round(region.height * scale),
          ...(region.label ? { label: region.label } : {}),
        }))

        if (payload === undefined) {
          warnings.push('Gemini did not return parseable JSON, so no AI regions were added.')
        }
        if (scaled.length === 0) {
          warnings.push(
            'AI detection found no sensitive regions. Review the video before sharing it.',
          )
        }
        if (input.regions) {
          warnings.push(
            'Both manual regions and AI detection were used; the region list is the union of the two.',
          )
        }

        regions = [...regions, ...normalizeManualRegions(scaled, width, height)]
      }

      if (regions.length === 0) {
        return {
          summary: 'No regions to redact. Nothing was rendered.',
          data: { regions: [], rendered: false },
          warnings,
        }
      }

      if (input.previewOnly) {
        ctx.onProgress?.('Rendering preview frames…')
        const duration = prepared.metadata.durationSeconds
        const previewTimestamps = [0, duration / 2, Math.max(0, duration - 1)].filter(
          (value, index, all) => value >= 0 && all.indexOf(value) === index,
        )
        const previewDir = await createArtifactDir(ctx.config, 'redaction-preview')
        const previews = await renderRedactionPreview(
          prepared.path,
          previewTimestamps,
          regions,
          ctx.config,
          previewDir,
          ctx.signal,
        )

        return {
          summary: [
            `Preview for ${prepared.path}`,
            `Effect: ${effect}`,
            `Detection: ${detectionMode}`,
            'Regions:',
            describeRegions(regions),
            '',
            'Re-run with previewOnly: false to render the video.',
          ].join('\n'),
          data: {
            effect,
            detectionMode,
            previewOnly: true,
            regions,
            previewDir,
            previewTimestamps,
          },
          images: previews.map((previewPath, index) => ({
            path: previewPath,
            mimeType: 'image/jpeg',
            label: `t=${Number(previewTimestamps[index]).toFixed(2)}s`,
          })),
          ...(warnings.length > 0 ? { warnings } : {}),
        }
      }

      const extension = input.outputPath ? path.extname(input.outputPath).toLowerCase() : '.mp4'
      const outPath = input.outputPath
        ? path.resolve(input.outputPath)
        : path.join(
            await createArtifactDir(ctx.config, 'redacted'),
            `${path.parse(prepared.path).name}-redacted${extension || '.mp4'}`,
          )
      await ensureDir(path.dirname(outPath))

      if (outPath === path.resolve(prepared.path)) {
        throw invalidInput('outputPath must not overwrite the source video.')
      }

      ctx.onProgress?.('Rendering redacted video…')
      await renderRedactedVideo(prepared.path, outPath, regions, effect, ctx.config, ctx.signal)

      return {
        summary: [
          `Redacted ${prepared.path}`,
          `Effect: ${effect}`,
          `Detection: ${detectionMode}`,
          'Regions:',
          describeRegions(regions),
          '',
          `Output: ${outPath}`,
        ].join('\n'),
        data: {
          effect,
          detectionMode,
          previewOnly: false,
          regions,
          outputPath: outPath,
        },
        artifacts: [{ path: outPath, kind: 'video' as const }],
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } finally {
      await removeDir(workDir)
      await prepared.media.cleanup()
    }
  },
}
