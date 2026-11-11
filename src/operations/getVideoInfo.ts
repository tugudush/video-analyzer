import { z } from 'zod'
import { formatBytes, formatTimestamp, prepareMedia } from './shared.js'
import type { MediaMetadata } from '../services/ffmpeg.js'
import type { Operation } from './types.js'

export const getVideoInfoInput = z.object({
  videoPath: z
    .string()
    .min(1)
    .describe('Local path, file:// URI, or direct http(s) media URL. No AI is used.'),
})

/** Render a metadata object as a compact Markdown-ish block. */
export function formatMetadata(metadata: MediaMetadata, source: string): string {
  const lines: string[] = []
  lines.push(`Container: ${metadata.container}`)
  lines.push(`Duration: ${formatTimestamp(metadata.durationSeconds)}`)
  lines.push(`Size: ${formatBytes(metadata.sizeBytes)}`)
  if (metadata.bitRate) lines.push(`Overall bitrate: ${Math.round(metadata.bitRate / 1000)} kbps`)

  if (metadata.video) {
    const { codec, width, height, fps, pixelFormat } = metadata.video
    const rate = fps ? `${fps.toFixed(2)} fps` : 'unknown frame rate'
    lines.push(
      `Video: ${codec} ${width}x${height}, ${rate}${pixelFormat ? `, ${pixelFormat}` : ''}`,
    )
  } else {
    lines.push('Video: none')
  }

  if (metadata.audio) {
    const { codec, sampleRate, channels } = metadata.audio
    const parts = [codec]
    if (sampleRate) parts.push(`${sampleRate} Hz`)
    if (channels) parts.push(`${channels} channel${channels === 1 ? '' : 's'}`)
    lines.push(`Audio: ${parts.join(', ')}`)
  } else {
    lines.push('Audio: none')
  }

  lines.push(`Source: ${source}`)
  return lines.join('\n')
}

export const getVideoInfoOperation: Operation<typeof getVideoInfoInput> = {
  name: 'get_video_info',
  title: 'Get Video Info',
  description:
    'Read container and stream metadata (duration, resolution, frame rate, codec, audio layout, size) with ffprobe. No AI provider required.',
  inputSchema: getVideoInfoInput,
  category: 'local',
  requiresGemini: false,

  async run(input, ctx) {
    const prepared = await prepareMedia(input.videoPath, ctx)
    try {
      const warnings: string[] = []
      if (!prepared.metadata.hasVideo) {
        warnings.push('No video stream found; this looks like an audio-only file.')
      }

      return {
        summary: formatMetadata(prepared.metadata, prepared.media.source),
        data: {
          ...prepared.metadata,
          source: prepared.media.source,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } finally {
      await prepared.media.cleanup()
    }
  },
}
