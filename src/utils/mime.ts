import path from 'node:path'

const MIME_BY_EXTENSION: Record<string, string> = {
  // video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
  // audio
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  // images (frame extraction output)
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** Guess a MIME type from a file extension, or `undefined` when unknown. */
export function mimeTypeFromPath(filePath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()]
}

export function isAudioMimeType(mimeType: string): boolean {
  return mimeType.startsWith('audio/')
}

export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.startsWith('video/')
}

export function isMediaMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  return isAudioMimeType(mimeType) || isVideoMimeType(mimeType)
}
