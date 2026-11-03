import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { invalidInput } from '../utils/errors.js'
import { getGeminiService, prepareMedia, statForUpload } from './shared.js'
import type { Operation } from './types.js'

export const transcribeVideoInput = z.object({
  videoPath: z
    .string()
    .min(1)
    .describe(
      'Local path, file:// URI, direct http(s) media URL, or a platform URL supported by yt-dlp. Accepts video or audio files.',
    ),
  language: z
    .string()
    .optional()
    .describe('Optional spoken language hint, for example "Spanish" or "es-ES".'),
  translateToEnglish: z
    .boolean()
    .optional()
    .describe(
      'When true, return the transcript translated into English instead of the original language.',
    ),
  outputPath: z
    .string()
    .optional()
    .describe(
      'Optional file path to also write the transcript to. Parent directories are created.',
    ),
})

const TRANSCRIBE_SYSTEM_INSTRUCTION = [
  'You transcribe speech precisely.',
  'Output only the transcript, one sentence or short utterance per line.',
  'Do not add commentary, headings, speaker labels, or timestamps.',
  'If there is no audible speech, output exactly: NO_SPEECH',
].join(' ')

function buildPrompt(language: string | undefined, translateToEnglish: boolean): string {
  const lines = ['Provide a verbatim transcript of all spoken audio in this recording.']
  if (language) lines.push(`The main spoken language is ${language}.`)
  if (translateToEnglish) {
    lines.push('Translate the transcript into English.')
  } else {
    lines.push('Keep the original spoken language.')
  }
  if (!language) lines.push('Identify the spoken language from the audio.')
  return lines.join(' ')
}

export const transcribeVideoOperation: Operation<typeof transcribeVideoInput> = {
  name: 'transcribe_video',
  title: 'Transcribe Video',
  description:
    'Transcribe spoken audio from a video or audio file using Gemini. Returns plain text without speaker diarization or word-level timestamps.',
  inputSchema: transcribeVideoInput,
  category: 'analysis',
  requiresGemini: true,

  async run(input, ctx) {
    if (input.outputPath) {
      const extension = path.extname(input.outputPath).toLowerCase()
      if (extension === '.srt' || extension === '.vtt') {
        throw invalidInput(
          `Subtitle output (${extension}) is not supported: Gemini does not provide reliable per-cue timings.`,
          {
            hint: 'Write a plain .txt transcript, or generate subtitles with a dedicated speech-to-text service.',
          },
        )
      }
    }

    const prepared = await prepareMedia(input.videoPath, ctx)
    try {
      const service = getGeminiService(ctx)
      const { sizeBytes, mtimeMs } = await statForUpload(prepared.media)

      const transcript = await service.generateWithFile({
        path: prepared.path,
        mimeType: prepared.media.mimeType,
        sizeBytes,
        mtimeMs,
        prompt: buildPrompt(input.language, input.translateToEnglish ?? false),
        systemInstruction: TRANSCRIBE_SYSTEM_INSTRUCTION,
        temperature: 0.1,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      })

      const text = transcript.trim()
      const noSpeech = /\bNO_SPEECH\b/.test(text)
      const warnings: string[] = []

      if (noSpeech) {
        warnings.push('Gemini reported no audible speech in this media.')
      }

      const artifacts = []
      if (input.outputPath && !noSpeech) {
        await writeFile(input.outputPath, `${text}\n`, 'utf8')
        artifacts.push({
          path: path.resolve(input.outputPath),
          kind: 'transcript' as const,
          mimeType: 'text/plain',
        })
      }

      if (prepared.metadata.hasAudio === false) {
        warnings.push('The container reports no audio track; the transcript may be incomplete.')
      }

      return {
        summary: noSpeech ? 'No audible speech detected.' : text,
        data: {
          language: input.language ?? null,
          translatedToEnglish: input.translateToEnglish ?? false,
          noSpeech,
          durationSeconds: prepared.metadata.durationSeconds,
          characters: text.length,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      }
    } finally {
      await prepared.media.cleanup()
    }
  },
}
