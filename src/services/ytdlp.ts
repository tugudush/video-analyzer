import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Config } from '../config.js'
import { clampTimerMs, isAbortError } from '../utils/abort.js'
import {
  VideoAnalyzerError,
  dependencyMissing,
  invalidInput,
  operationCancelled,
} from '../utils/errors.js'
import { isMediaMimeType, mimeTypeFromPath } from '../utils/mime.js'
import { startEgressGuard, type EgressGuard } from './egressGuard.js'

const execFileAsync = promisify(execFile)

/** Download budgets are never shorter than this; platform extraction is slow. */
const MIN_TIMEOUT_MS = 60_000

/** Fixed stem so a finished download is unambiguous inside its temp directory. */
export const OUTPUT_STEM = 'platform-source'

/**
 * YouTube intermittently refuses media requests from the client yt-dlp picks by
 * default, answering HTTP 403. `web_safari` is the fallback that works; keeping
 * `default` first means yt-dlp's preferred client is still used when it is not
 * refused. The argument is keyed by extractor name, so other sites ignore it.
 */
const DEFAULT_EXTRACTOR_ARGS = 'youtube:player_client=default,web_safari'

export interface PlatformDownload {
  path: string
  mimeType: string
  sizeBytes: number
  sha256: string
}

export interface PlatformDownloadOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

/**
 * Format chain that prefers H.264/AAC in MP4.
 *
 * Gemini and FFmpeg both decode AV1 and VP9, but the H.264 chain is the safest
 * common denominator for containers handed to other tools, and it is what the
 * platform serves most widely. Each alternative is a fallback, so a site that
 * only offers VP9/AV1 still downloads. Every alternative keeps the height cap:
 * accepting a known over-cap stream as a last resort would defeat
 * `YT_DLP_MAX_RESOLUTION`. The `<=?` form also matches formats that report no
 * height, such as audio-only and some adaptive streams, which a plain `<=`
 * would silently exclude.
 */
export function buildFormatSelector(maxHeight: number): string {
  const cap = `[height<=?${maxHeight}]`
  return [
    `bestvideo${cap}[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo${cap}[vcodec^=avc]+bestaudio[ext=m4a]`,
    `bestvideo${cap}[ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo${cap}+bestaudio`,
    `best${cap}[ext=mp4]`,
    `best${cap}`,
  ].join('/')
}

export interface YtDlpArgsInput {
  url: string
  config: Config
  outputTemplate: string
  /** Proxy that enforces the tool's destination policy for yt-dlp's own requests. */
  proxyUrl?: string
}

/**
 * Build the yt-dlp command line.
 *
 * `--ignore-config` is deliberate: a user-level yt-dlp config can add options
 * such as `--exec`, which would run arbitrary commands on behalf of a tool that
 * only meant to download a video. Settings arrive through `YT_DLP_*` instead.
 */
export function buildYtDlpArgs({
  url,
  config,
  outputTemplate,
  proxyUrl,
}: YtDlpArgsInput): string[] {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--playlist-items',
    '1',
    '--no-progress',
    '--no-mtime',
    '--newline',
    '--socket-timeout',
    '15',
    '--retries',
    '2',
    '--fragment-retries',
    '2',
    '--extractor-args',
    DEFAULT_EXTRACTOR_ARGS,
    '--max-filesize',
    String(config.downloadMaxBytes),
    '--format',
    buildFormatSelector(config.ytdlpMaxResolution),
    '--merge-output-format',
    'mp4',
    '--output',
    outputTemplate,
  ]

  if (config.ytdlpCookiesFile) args.push('--cookies', config.ytdlpCookiesFile)
  if (config.ytdlpImpersonate) args.push('--impersonate', config.ytdlpImpersonate)
  if (proxyUrl) args.push('--proxy', proxyUrl)

  args.push('--', url)
  return args
}

function stderrTail(stderr: string): string | undefined {
  const tail = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('WARNING'))
    .slice(-4)
    .join('\n')
  return tail || undefined
}

function classifyFailure(stderr: string, maxResolution: number): VideoAnalyzerError {
  const hint = stderrTail(stderr)

  if (
    /impersonate target .* is not (available|supported)|impersonate.*not supported/i.test(stderr)
  ) {
    return new VideoAnalyzerError('DOWNLOAD_FAILED', 'yt-dlp cannot impersonate that browser.', {
      hint: `YT_DLP_IMPERSONATE is set but this yt-dlp build does not support it. Install the "default" extras (pip install -U "yt-dlp[default]"), or unset YT_DLP_IMPERSONATE. ${hint ?? ''}`.trim(),
      details: { stderr: hint },
    })
  }

  if (
    /sign in to confirm|confirm (that )?you.?re not a bot|age-restricted|login required/i.test(
      stderr,
    )
  ) {
    return new VideoAnalyzerError('DOWNLOAD_FAILED', 'The platform requires a signed-in session.', {
      hint: 'Export cookies from a signed-in browser and set YT_DLP_COOKIES_FILE to the Netscape cookies file. YT_DLP_IMPERSONATE=chrome can also help with bot checks.',
      details: { stderr: hint },
    })
  }

  if (/http error 403|403 forbidden/i.test(stderr)) {
    return new VideoAnalyzerError(
      'DOWNLOAD_FAILED',
      'The platform refused the media request (HTTP 403).',
      {
        hint: 'Set YT_DLP_IMPERSONATE=chrome, or set YT_DLP_COOKIES_FILE to a Netscape cookies file exported from a signed-in browser.',
        details: { stderr: hint },
      },
    )
  }

  if (/requested format (is )?not available/i.test(stderr)) {
    return new VideoAnalyzerError('DOWNLOAD_FAILED', 'No stream matches the requested format.', {
      hint: `Raise YT_DLP_MAX_RESOLUTION above ${maxResolution}, or check that the page still hosts video.`,
      details: { stderr: hint },
    })
  }

  if (/unsupported url|is not a valid url|no video formats found/i.test(stderr)) {
    return new VideoAnalyzerError('UNSUPPORTED_INPUT', 'yt-dlp does not support this URL.', {
      hint: 'Use a direct media URL, a local file, or a page URL a yt-dlp extractor covers.',
      details: { stderr: hint },
    })
  }

  if (/video unavailable|private video|this video is private/i.test(stderr)) {
    return new VideoAnalyzerError('DOWNLOAD_FAILED', 'The video is unavailable or private.', {
      hint: 'Set YT_DLP_COOKIES_FILE to cookies exported from an account that can play it.',
      details: { stderr: hint },
    })
  }

  return new VideoAnalyzerError('DOWNLOAD_FAILED', 'yt-dlp failed to download the media.', {
    hint: hint ?? 'Run yt-dlp on the same URL to see the full error.',
    details: { stderr: hint },
  })
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Locate the finished download, ignoring the `.part` file yt-dlp leaves mid-run. */
async function findOutput(destDir: string): Promise<string | undefined> {
  const entries = await readdir(destDir)
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith(`${OUTPUT_STEM}.`)) continue
    if (entry.endsWith('.part') || entry.endsWith('.ytdl')) continue
    const mimeType = mimeTypeFromPath(entry)
    if (!mimeType || !isMediaMimeType(mimeType)) continue
    candidates.push(path.join(destDir, entry))
  }
  return candidates.toSorted().at(-1)
}

/**
 * Resolve a platform page URL to a media file with yt-dlp.
 *
 * The download lands in `destDir`, which the caller owns (a per-request temp
 * directory), so a failure never leaves partial output behind for the next run.
 * yt-dlp performs its own network access, so its traffic is routed through a
 * loopback proxy that applies the tool's destination policy to every request —
 * including media hosts the page points at, which the caller's URL check never
 * sees.
 */
export async function downloadFromPlatform(
  url: string,
  destDir: string,
  config: Config,
  opts: PlatformDownloadOptions = {},
): Promise<PlatformDownload> {
  if (config.ytdlpCookiesFile) {
    try {
      await stat(config.ytdlpCookiesFile)
    } catch {
      throw invalidInput(`YT_DLP_COOKIES_FILE does not exist: ${config.ytdlpCookiesFile}`, {
        hint: 'Point it at a Netscape-format cookies file exported from a signed-in browser, or unset it.',
      })
    }
  }

  const guard = await startEgressGuard({ allowPrivateHosts: config.allowPrivateHosts }).catch(
    (error: unknown) => {
      throw new VideoAnalyzerError(
        'DOWNLOAD_FAILED',
        'Could not start the network guard for yt-dlp.',
        { cause: error },
      )
    },
  )

  try {
    return await downloadThroughGuard(url, destDir, config, guard, opts)
  } finally {
    await guard.close()
  }
}

function blockedDestinationError(blocked: string[]): VideoAnalyzerError {
  return new VideoAnalyzerError(
    'DOWNLOAD_FAILED',
    'The page pointed yt-dlp at a private or reserved destination, which was blocked.',
    {
      hint: 'Set VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS=true only if you trust the page and the media it points at.',
      details: { blocked },
    },
  )
}

async function downloadThroughGuard(
  url: string,
  destDir: string,
  config: Config,
  guard: EgressGuard,
  opts: PlatformDownloadOptions,
): Promise<PlatformDownload> {
  const binary = config.ytdlpPath ?? 'yt-dlp'
  const outputTemplate = path.join(destDir, `${OUTPUT_STEM}.%(ext)s`)
  const args = buildYtDlpArgs({ url, config, outputTemplate, proxyUrl: guard.url })
  const timeoutMs = clampTimerMs(Math.max(config.requestTimeoutMs, MIN_TIMEOUT_MS))

  opts.onProgress?.('Downloading from the platform with yt-dlp…')

  let stdout = ''
  try {
    const result = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      cwd: destDir,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    stdout = result.stdout
  } catch (error) {
    if (opts.signal?.aborted || isAbortError(error)) throw operationCancelled({ cause: error })

    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      const configured = binary.includes('/') || binary.includes('\\')
      throw dependencyMissing(
        configured
          ? `The configured yt-dlp binary was not found: ${binary}`
          : 'yt-dlp is required for platform page URLs but was not found on PATH.',
        {
          hint: 'Install yt-dlp (winget install --id yt-dlp.yt-dlp, brew install yt-dlp, or pipx install yt-dlp), or set YT_DLP_PATH to the executable.',
          details: { binary },
        },
      )
    }

    if ((error as { killed?: boolean }).killed === true) {
      throw new VideoAnalyzerError(
        'DOWNLOAD_FAILED',
        `yt-dlp did not finish within ${timeoutMs} ms.`,
        {
          hint: 'Raise VIDEO_ANALYZER_REQUEST_TIMEOUT_MS for long videos, or analyze a shorter clip.',
          details: { timeoutMs },
          cause: error,
        },
      )
    }

    const stderr = (error as { stderr?: string }).stderr ?? ''
    if (guard.blocked.length > 0) throw blockedDestinationError(guard.blocked)
    throw classifyFailure(stderr, config.ytdlpMaxResolution)
  }

  const produced = await findOutput(destDir)
  if (!produced) {
    if (guard.blocked.length > 0) throw blockedDestinationError(guard.blocked)
    throw new VideoAnalyzerError('DOWNLOAD_FAILED', 'yt-dlp finished but produced no media file.', {
      hint: stderrTail(stdout) ?? 'Run yt-dlp on the same URL to see why nothing was written.',
    })
  }

  const info = await stat(produced)
  if (info.size > config.downloadMaxBytes) {
    throw new VideoAnalyzerError('DOWNLOAD_FAILED', 'The downloaded file exceeds the size limit.', {
      hint: 'Raise VIDEO_ANALYZER_DOWNLOAD_MAX_MB, or lower YT_DLP_MAX_RESOLUTION.',
      details: { sizeBytes: info.size, maxBytes: config.downloadMaxBytes },
    })
  }

  const mimeType = mimeTypeFromPath(produced)
  if (!mimeType || !isMediaMimeType(mimeType)) {
    throw new VideoAnalyzerError(
      'UNSUPPORTED_INPUT',
      `yt-dlp produced an unsupported file type: ${path.basename(produced)}`,
      {
        hint: 'The platform served a container this tool cannot read; try another quality or a direct media URL.',
      },
    )
  }

  return { path: produced, mimeType, sizeBytes: info.size, sha256: await hashFile(produced) }
}
