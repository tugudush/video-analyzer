import { z } from 'zod'
import {
  ANALYST_SYSTEM_INSTRUCTION,
  TIMESTAMP_ESTIMATE_WARNING,
  assertGeminiAvailable,
  formatTimestamp,
  missingMetadataWarning,
  withAiMedia,
} from './shared.js'
import type { Operation } from './types.js'

export const searchTimestampInput = z.object({
  videoPath: z.string().min(1).describe('Local path, file:// URI, or direct http(s) media URL.'),
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
    const match =
      line.match(
        /^[-*]?\s*MATCH\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?=\s|[-–—:]|$)\s*(?:[-–—:]\s*)?(.*)$/i,
      ) ??
      line.match(
        /^[-*]?\s*MATCH\s+(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*[-–—:]\s*(.*)$/i,
      )
    if (!match) {
      // Require whitespace, dash, end-of-line, or `:` not followed by a digit so
      // `MATCH 01:23 — ...` is never misparsed as `startSeconds: 1`.
      const single = line.match(
        /^[-*]?\s*MATCH\s+(\d+(?:\.\d+)?)(?=\s|[-–—]|:(?!\d)|$)\s*(?:[-–—:]\s*)?(.*)$/i,
      )
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
      ...(end !== undefined && Number.isFinite(end) && end > start ? { endSeconds: end } : {}),
      description: description || 'No description provided.',
    })
  }

  return matches
}

function isNoMatch(text: string): boolean {
  return /^NO_MATCH$/i.test(text.trim())
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
    assertGeminiAvailable(ctx)

    const {
      result: response,
      metadata,
      source,
    } = await withAiMedia(input.videoPath, ctx, (media) =>
      media.generate({
        prompt: SEARCH_PROMPT(input.query),
        systemInstruction: ANALYST_SYSTEM_INSTRUCTION,
        temperature: 0.2,
      }),
    )

    const matches = parseTimestampMatches(response)
    const durationSeconds = metadata?.durationSeconds ?? null
    const warnings: string[] = [TIMESTAMP_ESTIMATE_WARNING]
    if (durationSeconds === null) warnings.push(missingMetadataWarning(source))

    if (isNoMatch(response)) {
      return {
        summary: `No match found for "${input.query}".`,
        data: {
          query: input.query,
          matches: [],
          found: false,
          durationSeconds,
          raw: response.trim(),
        },
        warnings,
      }
    }

    if (matches.length === 0) {
      warnings.push(
        'Gemini answered but did not use the MATCH format, so no structured timestamps were parsed. The raw answer is included below.',
      )
      return {
        summary: response.trim(),
        data: {
          query: input.query,
          matches: [],
          found: null,
          durationSeconds,
          raw: response.trim(),
        },
        warnings,
      }
    }

    // A model reply is not validated against the media length, so an obviously
    // impossible estimate is flagged instead of being presented as a real
    // moment. The end of a range is checked too: a range that closes past the
    // clip is just as impossible as one that starts past it.
    const knownDuration = durationSeconds
    const beyondDuration =
      knownDuration === null
        ? []
        : matches.filter(
            (match) =>
              knownDuration > 0 &&
              (match.startSeconds > knownDuration ||
                (match.endSeconds !== undefined && match.endSeconds > knownDuration)),
          )
    if (beyondDuration.length > 0 && knownDuration !== null) {
      warnings.push(
        `${beyondDuration.length} reported timestamp(s) fall beyond the ${formatTimestamp(knownDuration)} clip and cannot be real moments. Treat them as out of range.`,
      )
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
        durationSeconds,
      },
      warnings,
    }
  },
}
