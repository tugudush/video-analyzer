import { z } from 'zod'
import {
  ANALYST_SYSTEM_INSTRUCTION,
  assertGeminiAvailable,
  getGeminiService,
  prepareMedia,
  uploadIdentityFor,
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
    const prepared = await prepareMedia(input.videoPath, ctx)
    try {
      const service = getGeminiService(ctx)
      const upload = uploadIdentityFor(prepared.media)

      const answer = await service.generateWithFile({
        path: prepared.path,
        mimeType: prepared.media.mimeType,
        ...upload,
        prompt: input.question,
        systemInstruction: ANALYST_SYSTEM_INSTRUCTION,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      })

      return {
        summary: answer.trim(),
        data: {
          question: input.question,
          durationSeconds: prepared.metadata.durationSeconds,
          source: prepared.media.source,
        },
      }
    } finally {
      await prepared.media.cleanup()
    }
  },
}
