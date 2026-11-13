import { z } from 'zod'
import {
  ANALYST_SYSTEM_INSTRUCTION,
  DIRECT_MEDIA_METADATA_WARNING,
  assertGeminiAvailable,
  withAiMedia,
} from './shared.js'
import type { Operation } from './types.js'

export const analyzeVideoInput = z.object({
  videoPath: z.string().min(1).describe('Local path, file:// URI, or direct http(s) media URL.'),
  question: z.string().min(1).describe('Question to answer about the video content.'),
})

export const analyzeVideoOperation: Operation<typeof analyzeVideoInput> = {
  name: 'analyze_video',
  title: 'Analyze Video',
  description:
    'Answer a question about a video (and its audio) using Gemini. Use for targeted questions such as "what is the presenter showing at the end?", not for whole-video overviews.',
  inputSchema: analyzeVideoInput,
  category: 'analysis',
  requiresGemini: true,

  async run(input, ctx) {
    assertGeminiAvailable(ctx)

    const {
      result: answer,
      metadata,
      source,
    } = await withAiMedia(input.videoPath, ctx, (media) =>
      media.generate({
        prompt: input.question,
        systemInstruction: ANALYST_SYSTEM_INSTRUCTION,
      }),
    )

    return {
      summary: answer.trim(),
      data: {
        question: input.question,
        durationSeconds: metadata?.durationSeconds ?? null,
        source,
      },
      ...(metadata ? {} : { warnings: [DIRECT_MEDIA_METADATA_WARNING] }),
    }
  },
}
