import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Config } from '../config.js'
import { VideoAnalyzerError, invalidInput } from '../utils/errors.js'
import { createTempDir, ensureDir, removeDir } from '../utils/fsUtils.js'
import { isMediaMimeType, mimeTypeFromPath } from '../utils/mime.js'
import { downloadToFile } from '../utils/net.js'

export type MediaSource = 'local' | 'direct'

export interface ResolvedMedia {
  /** Absolute path to a readable local media file. */
  path: string
  source: MediaSource
  mimeType: string
  sizeBytes: number
  /** Set when we created a temp working directory that the caller should remove. */
  tempDir: string | null
  /** Removes the temp directory (no-op for caller-owned local files). */
  cleanup(): Promise<void>
}

export interface ResolveOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function isFileUri(value: string): boolean {
  return /^file:\/\//i.test(value)
}

/** Normalize a local path or `file://` URI into an absolute filesystem path. */
export function normalizeLocalPath(input: string): string {
  if (isFileUri(input)) {
    try {
      return path.resolve(fileURLToPath(input))
    } catch (error) {
      throw invalidInput(`Invalid file:// URI: ${input}`, { cause: error })
    }
  }
  return path.resolve(input)
}

async function statFile(filePath: string): Promise<{ size: number }> {
  let info
  try {
    info = await stat(filePath)
  } catch {
    throw new VideoAnalyzerError('INPUT_NOT_FOUND', `File not found: ${filePath}`, {
      hint: 'Check the path, or pass an http(s) URL instead.',
    })
  }
  if (!info.isFile()) {
    throw new VideoAnalyzerError('UNSUPPORTED_INPUT', `Not a regular file: ${filePath}`)
  }
  if (info.size === 0) {
    throw new VideoAnalyzerError('UNSUPPORTED_INPUT', `File is empty: ${filePath}`)
  }
  return { size: info.size }
}

function resolveMimeType(filePath: string, override?: string): string {
  const mimeType = override ?? mimeTypeFromPath(filePath)
  if (!mimeType || !isMediaMimeType(mimeType)) {
    throw new VideoAnalyzerError(
      'UNSUPPORTED_INPUT',
      `Unsupported or unknown media type: ${path.basename(filePath)}`,
      {
        hint: 'Supported inputs are common video formats (mp4, mov, webm, mkv, avi, …) and audio formats (mp3, m4a, wav, …).',
      },
    )
  }
  return mimeType
}

async function resolveDirect(
  url: string,
  config: Config,
  opts: ResolveOptions,
): Promise<ResolvedMedia> {
  opts.onProgress?.('Downloading remote media…')
  const tempDir = await createTempDir()
  const destination = path.join(tempDir, 'source.media')

  try {
    const result = await downloadToFile(url, destination, {
      maxBytes: config.downloadMaxBytes,
      timeoutMs: Math.max(config.requestTimeoutMs, 60_000),
      allowPrivateHosts: config.allowPrivateHosts,
      signal: opts.signal,
    })

    const declared = result.contentType?.split(';')[0]?.trim().toLowerCase()
    const fromUrl = mimeTypeFromPath(new URL(result.finalUrl).pathname)

    if (
      declared &&
      !isMediaMimeType(declared) &&
      !(declared === 'application/octet-stream' && isMediaMimeType(fromUrl))
    ) {
      throw new VideoAnalyzerError('UNSUPPORTED_INPUT', 'The URL did not return media.', {
        hint: 'Use a direct media URL or a local file. Platform page downloads are disabled because their destinations cannot be validated.',
      })
    }

    const mimeType = declared && isMediaMimeType(declared) ? declared : fromUrl
    if (!mimeType) {
      await removeDir(tempDir)
      throw new VideoAnalyzerError(
        'UNSUPPORTED_INPUT',
        'Could not determine the media type of the downloaded file.',
        {
          hint: 'Use a URL whose path ends in a media extension, or a local file.',
          details: { url: result.finalUrl, contentType: result.contentType },
        },
      )
    }

    return {
      path: destination,
      source: 'direct',
      mimeType,
      sizeBytes: result.bytesWritten,
      tempDir,
      cleanup: () => removeDir(tempDir),
    }
  } catch (error) {
    await removeDir(tempDir)
    throw error
  }
}

async function resolveLocal(input: string): Promise<ResolvedMedia> {
  const filePath = normalizeLocalPath(input)
  const { size } = await statFile(filePath)
  return {
    path: filePath,
    source: 'local',
    mimeType: resolveMimeType(filePath),
    sizeBytes: size,
    tempDir: null,
    cleanup: async () => undefined,
  }
}

/**
 * Resolve any supported media input to a readable local file.
 *
 * Resolution order: local path / `file://` URI → direct HTTP(S) download.
 */
export async function resolveMediaInput(
  input: string,
  config: Config,
  opts: ResolveOptions = {},
): Promise<ResolvedMedia> {
  const trimmed = input.trim()
  if (!trimmed) throw invalidInput('videoPath must not be empty.')

  if (isRemoteUrl(trimmed)) {
    return resolveDirect(trimmed, config, opts)
  }

  return resolveLocal(trimmed)
}

/** Resolve an output path, creating its parent directory. */
export async function resolveOutputPath(
  requested: string | undefined,
  config: Config,
  fallbackName: string,
): Promise<string> {
  const target = requested
    ? path.resolve(requested)
    : path.resolve(config.outputDir ?? process.cwd(), fallbackName)
  await ensureDir(path.dirname(target))
  return target
}
