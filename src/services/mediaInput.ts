import { rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Config } from '../config.js'
import { VideoAnalyzerError, invalidInput } from '../utils/errors.js'
import { createTempDir, removeDir } from '../utils/fsUtils.js'
import { isMediaMimeType, mimeTypeFromPath } from '../utils/mime.js'
import { downloadToFile, redactedUrl, type DownloadResult } from '../utils/net.js'
import { downloadFromPlatform, type PlatformDownload } from './ytdlp.js'
import type { Logger } from '../utils/logger.js'

export type MediaSource = 'local' | 'direct'

export interface ResolvedMedia {
  /** Absolute path to a readable local media file. */
  path: string
  source: MediaSource
  mimeType: string
  sizeBytes: number
  /**
   * Content-based identity for downloads whose local path changes per request.
   */
  cacheKey?: string
  /** Set when we created a temp working directory that the caller should remove. */
  tempDir: string | null
  /** Removes the temp directory (no-op for caller-owned local files). */
  cleanup(): Promise<void>
  /** Retains a downloaded source while a shared upload still needs it. */
  retainSource?: () => () => Promise<void>
}

export interface ResolveOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
  logger?: Logger
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

function resolveMimeType(filePath: string): string {
  const mimeType = mimeTypeFromPath(filePath)
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

const PAGE_CONTENT_TYPES = /^text\/html|^application\/xhtml\+xml/

/** True when a declared Content-Type describes a document rather than media. */
function isPageContentType(value: string | undefined): boolean {
  return PAGE_CONTENT_TYPES.test(value?.split(';')[0]?.trim().toLowerCase() ?? '')
}

/**
 * Statuses a page uses to refuse an unauthenticated client. These are the ones
 * cookies or impersonation can turn into a success; a 404 or a 500 is not
 * something the downloader can fix.
 */
const REFUSED_PAGE_STATUSES = new Set([401, 403, 407, 429])

function refusedPageFailure(error: unknown): VideoAnalyzerError | undefined {
  if (!(error instanceof VideoAnalyzerError) || error.code !== 'DOWNLOAD_FAILED') return undefined
  const status = error.details?.['status']
  return typeof status === 'number' && REFUSED_PAGE_STATUSES.has(status) ? error : undefined
}

function contentTypeFromError(error: VideoAnalyzerError): string | undefined {
  const value = error.details?.['contentType']
  return typeof value === 'string' ? value : undefined
}

/**
 * Retry a refused page through the platform downloader.
 *
 * A page can answer an unauthenticated request with 401, 403, 407, or 429 while
 * `yt-dlp`, using the configured cookies and impersonation, can still fetch it.
 * A refused *media* response is left alone, because a downloader cannot talk a
 * CDN out of hotlink protection.
 */
async function downloadPageAfterRefusal(
  error: unknown,
  url: string,
  destDir: string,
  config: Config,
  opts: ResolveOptions,
): Promise<PlatformDownload | undefined> {
  const failure = refusedPageFailure(error)
  if (!failure) return undefined

  const declared = contentTypeFromError(failure)
  const declaredMediaType = declared?.split(';')[0]?.trim().toLowerCase()
  if (declaredMediaType && isMediaMimeType(declaredMediaType)) return undefined

  try {
    return await downloadFromPlatform(url, destDir, config, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    })
  } catch (platformError) {
    if (!(platformError instanceof VideoAnalyzerError)) throw platformError
    // Not a page the downloader supports: the HTTP failure is the real answer.
    if (platformError.code === 'UNSUPPORTED_INPUT') return undefined
    // A missing downloader only explains a served document; for anything else
    // the status the server returned is the more honest error.
    if (platformError.code === 'DEPENDENCY_MISSING' && !isPageContentType(declared))
      return undefined
    throw platformError
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
    let result: DownloadResult
    try {
      result = await downloadToFile(url, destination, {
        maxBytes: config.downloadMaxBytes,
        timeoutMs: Math.max(config.requestTimeoutMs, 60_000),
        allowPrivateHosts: config.allowPrivateHosts,
        signal: opts.signal,
      })
    } catch (error) {
      // A refused page may still be fetchable by yt-dlp; a refused media stream
      // or any other failure keeps the original error.
      const page = await downloadPageAfterRefusal(error, url, tempDir, config, opts)
      if (!page) throw error
      await rm(destination, { force: true })
      return buildResolved(
        page.path,
        page.mimeType,
        page.sizeBytes,
        `platform:${page.mimeType}:${page.sha256}`,
      )
    }

    const declared = result.contentType?.split(';')[0]?.trim().toLowerCase()
    const fromUrl = mimeTypeFromPath(new URL(result.finalUrl).pathname)

    const returnedMedia =
      !declared ||
      isMediaMimeType(declared) ||
      (declared === 'application/octet-stream' && isMediaMimeType(fromUrl))

    // Only a document is worth handing to the downloader: an image or a JSON
    // endpoint is not a platform page, and yt-dlp would produce a worse error
    // than the one this tool can give.
    const pageLike = isPageContentType(declared)

    if (!returnedMedia && pageLike) {
      // A platform page (HTML, JSON, …) rather than the media itself. The user
      // asked for what is behind it, so hand the URL to yt-dlp. If the probe
      // redirected to a login/consent interstitial, retry the original URL so
      // yt-dlp can apply cookies or impersonation directly.
      const downloadOpts: Parameters<typeof downloadFromPlatform>[3] = {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      }
      let platform: PlatformDownload
      try {
        platform = await downloadFromPlatform(result.finalUrl, tempDir, config, downloadOpts)
      } catch (platformError) {
        if (
          result.finalUrl === url ||
          !(platformError instanceof VideoAnalyzerError) ||
          (platformError.code !== 'UNSUPPORTED_INPUT' && platformError.code !== 'DOWNLOAD_FAILED')
        ) {
          throw platformError
        }
        platform = await downloadFromPlatform(url, tempDir, config, downloadOpts)
      }
      await rm(destination, { force: true })
      return buildResolved(
        platform.path,
        platform.mimeType,
        platform.sizeBytes,
        `platform:${platform.mimeType}:${platform.sha256}`,
      )
    }

    if (!returnedMedia) {
      throw new VideoAnalyzerError('UNSUPPORTED_INPUT', 'The URL did not return media.', {
        hint: 'Use a direct media URL, a local file, or a platform page URL (those are downloaded with yt-dlp).',
        details: { url: redactedUrl(new URL(result.finalUrl)), contentType: result.contentType },
      })
    }

    // A known media extension is only a fallback for a missing or generic
    // Content-Type; an image URL must not reach the AI service or be reported as
    // video just because the server omitted its type.
    const mimeType =
      declared && isMediaMimeType(declared)
        ? declared
        : isMediaMimeType(fromUrl)
          ? fromUrl
          : undefined
    if (!mimeType) {
      throw new VideoAnalyzerError(
        'UNSUPPORTED_INPUT',
        'Could not determine the media type of the downloaded file.',
        {
          hint: 'Use a URL whose path ends in a media extension, or a local file.',
          details: { url: redactedUrl(new URL(result.finalUrl)), contentType: result.contentType },
        },
      )
    }

    return buildResolved(
      destination,
      mimeType,
      result.bytesWritten,
      `direct:${mimeType}:${result.sha256}`,
    )
  } catch (error) {
    await removeDir(tempDir, opts.logger)
    throw error
  }

  function buildResolved(
    resolvedPath: string,
    mimeType: string,
    resolvedSize: number,
    key: string,
  ): ResolvedMedia {
    let references = 1
    const release = async () => {
      references -= 1
      if (references === 0) await removeDir(tempDir, opts.logger)
    }
    let cleaned = false
    return {
      path: resolvedPath,
      source: 'direct',
      mimeType,
      sizeBytes: resolvedSize,
      cacheKey: key,
      tempDir,
      cleanup: async () => {
        if (cleaned) return
        cleaned = true
        await release()
      },
      retainSource: () => {
        if (cleaned) throw new Error('Cannot retain a cleaned-up media source.')
        references += 1
        let released = false
        return async () => {
          if (released) return
          released = true
          await release()
        }
      },
    }
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
