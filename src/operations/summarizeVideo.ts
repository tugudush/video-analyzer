import { z } from 'zod'
import {
  ANALYST_SYSTEM_INSTRUCTION,
  DIRECT_MEDIA_METADATA_WARNING,
  TIMESTAMP_ESTIMATE_WARNING,
  assertGeminiAvailable,
  withAiMedia,
} from './shared.js'
import type { Operation } from './types.js'

export const summarizeVideoInput = z.object({
  videoPath: z.string().min(1).describe('Local path, file:// URI, or direct http(s) media URL.'),
  focus: z
    .string()
    .optional()
    .describe(
      'Optional aspect to emphasise in the summary, for example "pricing or licensing details".',
    ),
})

const SUMMARY_PROMPT = [
  'Summarise this video using these sections:',
  '1. Overview — 2-4 sentences on what the video is about.',
  '2. Key moments — bullet list of the most important scenes or statements. Give an approximate',
  '   timestamp where you can, and say "timestamp approximate" rather than inventing precision.',
  '3. Notable dialogue, on-screen text, or audio cues.',
  '4. Tone and intended audience.',
  '5. Notable gaps — anything a viewer would expect but that the video does not cover.',
].join('\n')

export const summarizeVideoOperation: Operation<typeof summarizeVideoInput> = {
  name: 'summarize_video',
  title: 'Summarize Video',
  description:
    'Produce a structured summary of a video (overview, key moments, dialogue/on-screen text, tone) using Gemini. Use when the user wants the gist rather than an answer to one specific question.',
  inputSchema: summarizeVideoInput,
  category: 'analysis',
  requiresGemini: true,

  async run(input, ctx) {
    assertGeminiAvailable(ctx)

    const prompt = input.focus
      ? `${SUMMARY_PROMPT}\n\nPay particular attention to: ${input.focus}`
      : SUMMARY_PROMPT

    const {
      result: summary,
      metadata,
      source,
    } = await withAiMedia(input.videoPath, ctx, (media) =>
      media.generate({ prompt, systemInstruction: ANALYST_SYSTEM_INSTRUCTION }),
    )

    return {
      summary: summary.trim(),
      data: {
        durationSeconds: metadata?.durationSeconds ?? null,
        source,
        ...(input.focus ? { focus: input.focus } : {}),
      },
      warnings: [TIMESTAMP_ESTIMATE_WARNING, ...(metadata ? [] : [DIRECT_MEDIA_METADATA_WARNING])],
    }
  },
}
