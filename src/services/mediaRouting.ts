import { fetch } from 'undici'
import type { Config } from '../config.js'
import { VideoAnalyzerError, operationCancelled } from '../utils/errors.js'
import { isMediaMimeType, mimeTypeFromPath } from '../utils/mime.js'
import { assertSafeHttpUrl } from '../utils/net.js'

/**
 * Decide how an AI operation should hand remote media to Gemini.
 *
 * Gemini can fetch a YouTube page and a small public file itself, which removes
 * both the download and the upload. Everything else is downloaded first, so the
 * analyzer keeps one predictable upload path for the rest of the pipeline.
 */

/** Google documents 15 MB per file for externally fetched media. */
export const GEMINI_DIRECT_URL_MAX_BYTES = 15_000_000

const MAX_PROBE_REDIRECTS = 5
const PROBE_TIMEOUT_MS = 30_000

/**
 * Exact hosts, never substrings: `notyoutube.com` and `youtube.com.evil.test`
 * must not be treated as the platform.
 */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

/** True when the input is a YouTube page URL Gemini can be asked to fetch. */
export function isYouTubeUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username || url.password) return false
  // A host that merely resolves to youtube.com on a non-standard port is not
  // the platform; the provider would fetch a different service.
  if (url.port !== '') return false
  return YOUTUBE_HOSTS.has(url.hostname.toLowerCase())
}

export interface DirectMediaProbe {
  url: string
  mimeType: string
  sizeBytes: number
}

/**
 * Resolve a public direct media URL that Gemini can fetch itself.
 *
 * Returns `null` for anything ineligible, which routes the caller to the
 * download path. A rejected host or a cancellation is a real error and is
 * rethrown, because the download path must not silently bypass either.
 */
export async function probeDirectMediaUrl(
  input: string,
  config: Config,
  opts: { signal?: AbortSignal } = {},
): Promise<DirectMediaProbe | null> {
  const timeout = AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, config.requestTimeoutMs))
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let current = input.trim()

  try {
    for (let hop = 0; hop <= MAX_PROBE_REDIRECTS; hop++) {
      const url = await assertSafeHttpUrl(current, {
        allowPrivateHosts: config.allowPrivateHosts,
      })

      // Only metadata is needed: a HEAD keeps the probe cheap and never streams
      // the body that Gemini would fetch itself.
      const response = await fetch(url.href, {
        method: 'HEAD',
        redirect: 'manual',
        signal,
        headers: { 'user-agent': 'video-analyzer' },
      })
      await response.body?.cancel().catch(() => undefined)

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return null
        current = new URL(location, url).href
        continue
      }

      if (!response.ok) return null

      const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      const fromUrl = mimeTypeFromPath(url.pathname)
      // An extension is only a fallback for a missing or generic type: a page
      // served from `/video.mp4` must not be reported as media, because the
      // provider would receive HTML and fail after the round trip.
      const generic = !declared || declared === 'application/octet-stream'
      const mimeType =
        declared && isMediaMimeType(declared)
          ? declared
          : generic && fromUrl && isMediaMimeType(fromUrl)
            ? fromUrl
            : undefined
      if (!mimeType) return null

      // An unencoded or absent length cannot establish eligibility, and a
      // guessed length is worse than downloading: the provider would reject
      // the request after paying for the round trip.
      const encoding = response.headers.get('content-encoding')
      if (encoding && encoding.toLowerCase() !== 'identity') return null

      const length = Number(response.headers.get('content-length') ?? Number.NaN)
      if (!Number.isInteger(length) || length <= 0) return null
      if (length > GEMINI_DIRECT_URL_MAX_BYTES) return null

      return { url: url.href, mimeType, sizeBytes: length }
    }

    return null
  } catch (error) {
    if (opts.signal?.aborted) throw operationCancelled({ cause: error })
    // A rejected URL (private host, bad scheme, embedded credentials) and a
    // failed DNS lookup are policy failures, not "this is not media".
    if (error instanceof VideoAnalyzerError) throw error
    return null
  }
}

export type GeminiUrlSource = 'youtube' | 'direct-file'

export type AiInputRoute =
  | {
      kind: 'gemini-url'
      url: string
      source: GeminiUrlSource
      /** Absent for YouTube, whose page URL is enough for Gemini. */
      mimeType: string | undefined
      sizeBytes: number | null
    }
  | { kind: 'download'; url: string }

/**
 * Choose the AI route for a remote input.
 *
 * YouTube is preferred for the direct path even though privacy cannot be read
 * from a URL: a provider rejection downgrades to the download path once, in
 * `operations/shared.ts`.
 */
export async function classifyAiInput(
  input: string,
  config: Config,
  opts: { signal?: AbortSignal } = {},
): Promise<AiInputRoute> {
  const trimmed = input.trim()

  if (isYouTubeUrl(trimmed)) {
    return {
      kind: 'gemini-url',
      url: trimmed,
      source: 'youtube',
      mimeType: undefined,
      sizeBytes: null,
    }
  }

  const probe = await probeDirectMediaUrl(trimmed, config, opts)
  if (probe) {
    return {
      kind: 'gemini-url',
      url: probe.url,
      source: 'direct-file',
      mimeType: probe.mimeType,
      sizeBytes: probe.sizeBytes,
    }
  }

  return { kind: 'download', url: trimmed }
}

/**
 * Whether a Gemini failure means "this URL cannot be used" rather than "the
 * service is unhappy".
 *
 * Quota, authentication, cancellation, and network failures are deliberately
 * excluded: retrying those through a download would hide the real problem and
 * pay for the download twice.
 */
export function isDirectUrlRejection(error: unknown): boolean {
  if (!(error instanceof VideoAnalyzerError)) return false
  if (error.code !== 'GEMINI_REQUEST_FAILED') return false

  const haystack = [
    error.message,
    error.hint ?? '',
    typeof error.cause === 'object' && error.cause !== null && 'message' in error.cause
      ? String((error.cause as { message: unknown }).message)
      : '',
  ]
    .join(' ')
    .toLowerCase()

  return (
    /url_retrieval_status|unsupported video|video is not supported|unsupported ur[il]|cannot (be )?fetch|unable to (retrieve|fetch)|invalid argument.*(file|uri|url)|not a valid (youtube|video)|video unavailable|private video|permission_denied.*(url|uri)/.test(
      haystack,
    ) && !/quota|rate limit|api key|unauthenticated|deadline|cancel/i.test(haystack)
  )
}
