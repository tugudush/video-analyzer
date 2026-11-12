import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GEMINI_MODEL,
  DOTENV_KEYS,
  applyDotEnv,
  loadConfig,
  requireGeminiApiKey,
} from '../../src/config.js'
import { MAX_TIMER_MS } from '../../src/utils/abort.js'

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({})
    expect(config.geminiApiKey).toBeUndefined()
    expect(config.geminiModel).toBe(DEFAULT_GEMINI_MODEL)
    expect(config.maxFrames).toBe(100)
    expect(config.downloadMaxBytes).toBe(2048 * 1024 * 1024)
    expect(config.requestTimeoutMs).toBe(300_000)
    expect(config.uploadTimeoutMs).toBe(600_000)
    expect(config.pollIntervalMs).toBe(2_000)
    expect(config.ffmpegPath).toBe('ffmpeg')
    expect(config.ffprobePath).toBe('ffprobe')
    expect(config.ytdlpPath).toBeUndefined()
    expect(config.ytdlpMaxResolution).toBe(720)
    expect(config.allowPrivateHosts).toBe(false)
    expect(config.logLevel).toBe('warn')
    expect(config.outputDir).toBeUndefined()
  })

  it('reads overrides', () => {
    const config = loadConfig({
      GEMINI_API_KEY: 'key-123',
      GEMINI_MODEL: 'custom-model',
      VIDEO_ANALYZER_MAX_FRAMES: '0',
      VIDEO_ANALYZER_DOWNLOAD_MAX_MB: '50',
      VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: '5000',
      VIDEO_ANALYZER_LOG_LEVEL: 'debug',
      VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS: 'true',
      VIDEO_ANALYZER_OUTPUT_DIR: '/tmp/out',
    })

    expect(config.geminiApiKey).toBe('key-123')
    expect(config.geminiModel).toBe('custom-model')
    expect(config.maxFrames).toBe(0)
    expect(config.downloadMaxBytes).toBe(50 * 1024 * 1024)
    expect(config.requestTimeoutMs).toBe(5000)
    expect(config.logLevel).toBe('debug')
    expect(config.allowPrivateHosts).toBe(true)
    expect(config.outputDir).toBe('/tmp/out')
  })

  it('reads the platform download settings', () => {
    const config = loadConfig({
      YT_DLP_PATH: '/opt/yt-dlp',
      YT_DLP_MAX_RESOLUTION: '480',
      YT_DLP_COOKIES_FILE: '/secrets/cookies.txt',
      YT_DLP_IMPERSONATE: 'chrome-136',
    })
    expect(config.ytdlpPath).toBe('/opt/yt-dlp')
    expect(config.ytdlpMaxResolution).toBe(480)
    expect(config.ytdlpCookiesFile).toBe('/secrets/cookies.txt')
    expect(config.ytdlpImpersonate).toBe('chrome-136')
  })

  it('defaults platform downloads to 720p with yt-dlp from PATH', () => {
    const config = loadConfig({})
    expect(config.ytdlpPath).toBeUndefined()
    expect(config.ytdlpMaxResolution).toBe(720)
    expect(config.ytdlpCookiesFile).toBeUndefined()
    expect(config.ytdlpImpersonate).toBeUndefined()
  })

  it('rejects an unusable platform resolution', () => {
    expect(() => loadConfig({ YT_DLP_MAX_RESOLUTION: '80' })).toThrowError(/YT_DLP_MAX_RESOLUTION/)
    expect(() => loadConfig({ YT_DLP_MAX_RESOLUTION: 'high' })).toThrowError(
      /YT_DLP_MAX_RESOLUTION/,
    )
  })

  it('rejects an impersonation token that could be read as a flag', () => {
    expect(() => loadConfig({ YT_DLP_IMPERSONATE: '--exec' })).toThrowError(/YT_DLP_IMPERSONATE/)
  })

  it('treats blank strings as unset', () => {
    const config = loadConfig({ GEMINI_API_KEY: '   ', GEMINI_MODEL: '' })
    expect(config.geminiApiKey).toBeUndefined()
    expect(config.geminiModel).toBe(DEFAULT_GEMINI_MODEL)
  })

  it('rejects non-integer numeric settings', () => {
    expect(() => loadConfig({ VIDEO_ANALYZER_MAX_FRAMES: 'abc' })).toThrowError(
      /VIDEO_ANALYZER_MAX_FRAMES/,
    )
    expect(() => loadConfig({ VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: '10' })).toThrowError(
      /VIDEO_ANALYZER_REQUEST_TIMEOUT_MS/,
    )
  })

  it('accepts the largest delay Node timers can represent', () => {
    const config = loadConfig({
      VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: String(MAX_TIMER_MS),
      VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS: String(MAX_TIMER_MS),
      VIDEO_ANALYZER_POLL_INTERVAL_MS: String(MAX_TIMER_MS),
    })
    expect(config.requestTimeoutMs).toBe(MAX_TIMER_MS)
    expect(config.uploadTimeoutMs).toBe(MAX_TIMER_MS)
    expect(config.pollIntervalMs).toBe(MAX_TIMER_MS)
  })

  /**
   * Node clamps a `setTimeout` delay above 2^31-1 ms to 1 ms, which would turn an
   * "effectively unlimited" budget into an immediate failure.
   */
  it.each([
    'VIDEO_ANALYZER_REQUEST_TIMEOUT_MS',
    'VIDEO_ANALYZER_UPLOAD_TIMEOUT_MS',
    'VIDEO_ANALYZER_POLL_INTERVAL_MS',
  ])('rejects %s above the timer ceiling', (name) => {
    expect(() => loadConfig({ [name]: String(MAX_TIMER_MS + 1) })).toThrowError(
      new RegExp(`between \\d+ and ${MAX_TIMER_MS}`),
    )
  })

  it('rejects unknown boolean values', () => {
    expect(() => loadConfig({ VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS: 'maybe' })).toThrowError(
      /must be a boolean/,
    )
  })

  it('falls back to the default log level for unknown values', () => {
    expect(loadConfig({ VIDEO_ANALYZER_LOG_LEVEL: 'verbose' }).logLevel).toBe('warn')
  })
})

describe('requireGeminiApiKey', () => {
  it('returns the key when present', () => {
    expect(requireGeminiApiKey(loadConfig({ GEMINI_API_KEY: 'abc' }))).toBe('abc')
  })

  it('throws CONFIG_MISSING with a hint when absent', () => {
    try {
      requireGeminiApiKey(loadConfig({}))
      throw new Error('expected throw')
    } catch (error) {
      const err = error as { code?: string; hint?: string }
      expect(err.code).toBe('CONFIG_MISSING')
      expect(err.hint).toContain('GEMINI_API_KEY')
    }
  })
})

/**
 * `.env` travels with the working directory, which in the Skill workflow is a
 * repository the agent did not write. It may supply the tool's own settings, but
 * it must not choose which executable runs or relax the network policy.
 */
describe('.env trust boundary', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-dotenv-policy-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('applies the tool settings a repository may choose', async () => {
    const file = path.join(dir, '.env')
    await writeFile(
      file,
      [
        'GEMINI_API_KEY=from-file',
        'VIDEO_ANALYZER_MAX_FRAMES=7',
        'VIDEO_ANALYZER_OUTPUT_DIR=/tmp/out',
      ].join('\n'),
      'utf8',
    )

    const target: NodeJS.ProcessEnv = {}
    expect(applyDotEnv(target, file).toSorted()).toEqual([
      'GEMINI_API_KEY',
      'VIDEO_ANALYZER_MAX_FRAMES',
      'VIDEO_ANALYZER_OUTPUT_DIR',
    ])
    expect(target['VIDEO_ANALYZER_MAX_FRAMES']).toBe('7')
  })

  it.each([
    'PATH',
    'FFMPEG_PATH',
    'FFPROBE_PATH',
    'VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS',
    'VIDEO_ANALYZER_CLI_PATH',
    'YT_DLP_PATH',
    'YT_DLP_COOKIES_FILE',
    'YT_DLP_IMPERSONATE',
  ])('ignores %s from the file', async (name) => {
    const file = path.join(dir, '.env')
    await writeFile(file, `${name}=/tmp/attacker-controlled\n`, 'utf8')

    const target: NodeJS.ProcessEnv = {}
    expect(applyDotEnv(target, file)).toEqual([])
    expect(target).not.toHaveProperty(name)
  })

  it('keeps the allowlist limited to settings this toolkit reads', () => {
    for (const forbidden of [
      'PATH',
      'FFMPEG_PATH',
      'FFPROBE_PATH',
      'VIDEO_ANALYZER_ALLOW_PRIVATE_HOSTS',
      'YT_DLP_PATH',
      'YT_DLP_COOKIES_FILE',
      'YT_DLP_IMPERSONATE',
      'YT_DLP_MAX_RESOLUTION',
    ]) {
      expect(DOTENV_KEYS as readonly string[]).not.toContain(forbidden)
    }
    expect(DOTENV_KEYS as readonly string[]).toContain('VIDEO_ANALYZER_OUTPUT_DIR')
  })
})
