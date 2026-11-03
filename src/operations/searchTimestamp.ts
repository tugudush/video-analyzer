import { z } from 'zod'
import {
  ANALYST_SYSTEM_INSTRUCTION,
  formatTimestamp,
  getGeminiService,
  prepareMedia,
  statForUpload,
} from './shared.js'
import type { Operation } from './types.js'

export const searchTimestampInput = z.object({
  videoPath: z
    .string()
    .min(1)
    .describe(
      'Local path, file:// URI, direct http(s) media URL, or a platform URL supported by yt-dlp.',
    ),
  query: z.string().min(1).describe('The event, object, phrase, or moment to locate in the video.'),
})

export interface TimestampMatch {
  startSeconds: number
  endSeconds?: number
  description: string
}

const SEARCH_PROMPT = (query: string) =>
  [
    `Locate the moment(s) in this video where the following occurs: "${query}".`,
    '',
    'Reply with one line per occurrence, in this exact format:',
    'MATCH <start-seconds> <end-seconds> — <short description of what is happening>',
    '',
    'Use seconds from the start of the video as plain numbers (for example "MATCH 42.5 47.0 — the',
    'speaker points at the pricing table"). Base each timestamp on the content you actually observe.',
    'If several moments are plausible, list each one and order them by confidence.',
    'If the event does not occur, reply with exactly: NO_MATCH',
  ].join('\n')

/** Parse `MATCH <start> <end> — description` lines from a model response. */
export function parseTimestampMatches(text: string): TimestampMatch[] {
  const matches: TimestampMatch[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = line.match(
      /^[-*]?\s*MATCH\s+(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*|\s+)(\d+(?:\.\d+)?)\s*(?:[-–—:]\s*)?(.*)$/i,
    )
    if (!match) {
      const single = line.match(/^[-*]?\s*MATCH\s+(\d+(?:\.\d+)?)\s*(?:[-–—:]\s*)?(.*)$/i)
      if (single) {
        const start = Number(single[1])
        if (Number.isFinite(start)) {
          const description = (single[2] ?? '').trim()
          matches.push({
            startSeconds: start,
            description: description || 'No description provided.',
          })
        }
      }
      continue
    }

    const start = Number(match[1])
    if (!Number.isFinite(start)) continue
    const end = match[2] ? Number(match[2]) : undefined
    const description = (match[3] ?? '').trim()

    matches.push({
      startSeconds: start,
      ...(end !== undefined && Number.isFinite(end) ? { endSeconds: end } : {}),
      description: description || 'No description provided.',
    })
  }

  return matches
}

function isNoMatch(text: string): boolean {
  return /\bNO_MATCH\b/i.test(text) && parseTimestampMatches(text).length === 0
}

export const searchTimestampOperation: Operation<typeof searchTimestampInput> = {
  name: 'search_timestamp',
  title: 'Search Timestamp',
  description:
    'Find when something specific happens in a video and report approximate timestamps using Gemini. Timestamps are model estimates, not frame-accurate seek points.',
  inputSchema: searchTimestampInput,
  category: 'analysis',
  requiresGemini: true,

  async run(input, ctx) {
    const prepared = await prepareMedia(input.videoPath, ctx)
    try {
      const service = getGeminiService(ctx)
      const { sizeBytes, mtimeMs } = await statForUpload(prepared.media)

      const response = await service.generateWithFile({
        path: prepared.path,
        mimeType: prepared.media.mimeType,
        sizeBytes,
        mtimeMs,
        prompt: SEARCH_PROMPT(input.query),
        systemInstruction: ANALYST_SYSTEM_INSTRUCTION,
        temperature: 0.2,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      })

      const matches = parseTimestampMatches(response)
      const warnings: string[] = [
        'Timestamps are Gemini estimates derived from its internal sampling, not frame-accurate seek positions. Verify with extract_frames before cutting.',
      ]

      if (isNoMatch(response)) {
        return {
          summary: `No match found for "${input.query}".`,
          data: { query: input.query, matches: [], found: false },
          warnings,
        }
      }

      if (matches.length === 0) {
        warnings.push(
          'Gemini answered but did not use the MATCH format, so no structured timestamps were parsed. The raw answer is included below.',
        )
        return {
          summary: response.trim(),
          data: { query: input.query, matches: [], found: true, raw: response.trim() },
          warnings,
        }
      }

      const summary = [
        `Found ${matches.length} matching moment(s) for "${input.query}":`,
        ...matches.map((match) => {
          const range =
            match.endSeconds !== undefined
              ? `${formatTimestamp(match.startSeconds)} – ${formatTimestamp(match.endSeconds)}`
              : formatTimestamp(match.startSeconds)
          return `- ${range}: ${match.description}`
        }),
      ].join('\n')

      return {
        summary,
        data: {
          query: input.query,
          found: true,
          matches,
          durationSeconds: prepared.metadata.durationSeconds,
        },
        warnings,
      }
    } finally {
      await prepared.media.cleanup()
    }
  },
}
