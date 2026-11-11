import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { isRemoteUrl, normalizeLocalPath } from '../services/mediaInput.js'
import { invalidInput } from '../utils/errors.js'
import { isSameFile } from '../utils/fsUtils.js'
import { getGeminiService, prepareMedia, statForUpload } from './shared.js'
import type { Operation } from './types.js'

export const transcribeVideoInput = z.object({
  videoPath: z
    .string()
    .min(1)
    .describe(
      'Local path, file:// URI, or direct http(s) media URL. Accepts video or audio files.',
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
      'Optional file path to also write the transcript to. Parent directories are created. The source media is never overwritten.',
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'Replace an existing output file. Defaults to false, which rejects an existing target instead of silently overwriting it.',
    ),
})

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt'])

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

/**
 * Local source path when the input is already a file, `undefined` for remote
 * URLs (their local copy only exists after the download).
 */
function localSourcePath(videoPath: string): string | undefined {
  const trimmed = videoPath.trim()
  if (!trimmed || isRemoteUrl(trimmed)) return undefined
  return normalizeLocalPath(trimmed)
}

async function assertNotSourceAlias(target: string, sourcePath: string): Promise<void> {
  if (!(await isSameFile(target, sourcePath))) return
  throw invalidInput('outputPath must not refer to the source media file.', {
    hint: 'Writing the transcript there would destroy the original video or audio. Choose a different path, for example "./transcript.txt".',
    details: { videoPath: sourcePath, outputPath: target },
  })
}

/**
 * Validate the output target before any upload or generation work.
 *
 * The source media is never an acceptable target, and an existing file is only
 * replaced when the caller explicitly asks for it.
 */
async function resolveTranscriptTarget(
  outputPath: string,
  overwrite: boolean,
  sourcePath: string | undefined,
): Promise<string> {
  const extension = path.extname(outputPath).toLowerCase()
  if (SUBTITLE_EXTENSIONS.has(extension)) {
    throw invalidInput(
      `Subtitle output (${extension}) is not supported: Gemini does not provide reliable per-cue timings.`,
      {
        hint: 'Write a plain .txt transcript, or generate subtitles with a dedicated speech-to-text service.',
      },
    )
  }

  const target = path.resolve(outputPath)
  if (sourcePath) await assertNotSourceAlias(target, sourcePath)

  const info = await stat(target).catch(() => null)
  if (info) {
    if (info.isDirectory()) {
      throw invalidInput(`outputPath is a directory, not a file: ${target}`, {
        hint: 'Pass a file path such as "./transcript.txt".',
      })
    }
    if (!overwrite) {
      throw invalidInput(`Refusing to overwrite an existing file: ${target}`, {
        hint: 'Pass overwrite: true to replace it, or choose a different output path.',
        details: { outputPath: target },
      })
    }
  }

  return target
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
    const sourcePath = localSourcePath(input.videoPath)
    const target = input.outputPath
      ? await resolveTranscriptTarget(input.outputPath, input.overwrite ?? false, sourcePath)
      : undefined

    const prepared = await prepareMedia(input.videoPath, ctx)
    try {
      // A downloaded copy only has a local path after resolution.
      if (target && !sourcePath) await assertNotSourceAlias(target, prepared.path)

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
      if (target && !noSpeech) {
        await writeFile(target, `${text}\n`, 'utf8')
        artifacts.push({
          path: target,
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
