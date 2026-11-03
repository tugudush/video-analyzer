import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Config } from '../config.js'
import { VideoAnalyzerError, dependencyMissing, invalidInput } from '../utils/errors.js'
import { createTempDir, ensureDir, removeDir } from '../utils/fsUtils.js'
import { isMediaMimeType, mimeTypeFromPath } from '../utils/mime.js'
import { downloadToFile } from '../utils/net.js'

const execFileAsync = promisify(execFile)

export type MediaSource = 'local' | 'direct' | 'platform'

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

/**
 * Hosts handled by yt-dlp rather than a plain HTTP download. This is a
 * best-effort list: unknown hosts first try a direct download and then fall
 * back to yt-dlp, so the list only needs to cover common platform URLs where a
 * direct fetch would return an HTML page.
 */
const PLATFORM_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'vimeo.com',
  'dailymotion.com',
  'dai.ly',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'twitter.com',
  'x.com',
  'twitch.tv',
  'bilibili.com',
  'b23.tv',
  'rumble.com',
  'odysee.com',
  'soundcloud.com',
  'bandcamp.com',
  'ted.com',
  'udemy.com',
  'coursera.org',
  'archive.org',
  'loom.com',
  'streamable.com',
]

export function isPlatformUrl(rawUrl: string): boolean {
  let hostname: string
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return PLATFORM_HOSTS.some((known) => hostname === known || hostname.endsWith(`.${known}`))
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

async function runYtDlp(
  url: string,
  outputDir: string,
  config: Config,
  signal?: AbortSignal,
): Promise<string> {
  const binary = config.ytDlpPath ?? 'yt-dlp'
  const outputTemplate = path.join(outputDir, 'source.%(ext)s')
  const args = [
    '--no-playlist',
    '--no-progress',
    '--print',
    'after_move:filepath',
    '-o',
    outputTemplate,
  ]

  if (config.ytDlpMaxResolution && Number.isFinite(config.ytDlpMaxResolution)) {
    args.push(
      '-f',
      `bestvideo[height<=${config.ytDlpMaxResolution}]+bestaudio/best[height<=${config.ytDlpMaxResolution}]/best`,
    )
  }
  if (config.ytDlpCookiesFile) args.push('--cookies', config.ytDlpCookiesFile)
  if (config.ytDlpImpersonate) args.push('--impersonate', config.ytDlpImpersonate)
  args.push('--', url)

  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: 15 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    })
    const printed = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .findLast(Boolean)
    if (!printed) {
      throw new VideoAnalyzerError('DOWNLOAD_FAILED', 'yt-dlp did not report an output file.', {
        hint: 'The URL may not be supported by yt-dlp, or the download was interrupted.',
      })
    }
    return printed
  } catch (error) {
    if (error instanceof VideoAnalyzerError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw dependencyMissing('yt-dlp is required for platform URLs but was not found.', {
        hint: 'Install yt-dlp (https://github.com/yt-dlp/yt-dlp) or set YT_DLP_PATH.',
      })
    }
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new VideoAnalyzerError('DOWNLOAD_FAILED', 'yt-dlp download failed.', {
      hint: stderr ? stderr.split('\n').slice(-3).join('\n') : undefined,
      cause: error,
    })
  }
}

async function resolvePlatform(
  url: string,
  config: Config,
  opts: ResolveOptions,
): Promise<ResolvedMedia> {
  opts.onProgress?.('Downloading platform video with yt-dlp…')
  const tempDir = await createTempDir()
  try {
    const downloaded = await runYtDlp(url, tempDir, config, opts.signal)
    const filePath = path.resolve(downloaded)
    const { size } = await statFile(filePath)
    return {
      path: filePath,
      source: 'platform',
      mimeType: resolveMimeType(filePath),
      sizeBytes: size,
      tempDir,
      cleanup: () => removeDir(tempDir),
    }
  } catch (error) {
    await removeDir(tempDir)
    throw error
  }
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

    if (declared && !isMediaMimeType(declared)) {
      // The server returned HTML or another non-media type; let yt-dlp try.
      await removeDir(tempDir)
      return await resolvePlatform(url, config, opts)
    }

    const mimeType = declared && isMediaMimeType(declared) ? declared : fromUrl
    if (!mimeType) {
      await removeDir(tempDir)
      throw new VideoAnalyzerError(
        'UNSUPPORTED_INPUT',
        'Could not determine the media type of the downloaded file.',
        {
          hint: 'Use a URL whose path ends in a media extension, or a platform URL supported by yt-dlp.',
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
 * Resolution order: local path / `file://` URI → platform URL (yt-dlp) →
 * direct HTTP(S) download with yt-dlp fallback for unknown hosts.
 */
export async function resolveMediaInput(
  input: string,
  config: Config,
  opts: ResolveOptions = {},
): Promise<ResolvedMedia> {
  const trimmed = input.trim()
  if (!trimmed) throw invalidInput('videoPath must not be empty.')

  if (isRemoteUrl(trimmed)) {
    return isPlatformUrl(trimmed)
      ? resolvePlatform(trimmed, config, opts)
      : resolveDirect(trimmed, config, opts)
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
