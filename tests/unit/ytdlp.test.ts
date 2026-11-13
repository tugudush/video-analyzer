import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import {
  buildFormatSelector,
  buildYtDlpArgs,
  downloadFromPlatform,
} from '../../src/services/ytdlp.js'

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
}))

type ExecCallback = (error: unknown, result: { stdout: string; stderr: string }) => void

/** Callback-style mock, because the service reaches execFile through promisify. */
function failWith(error: Record<string, unknown>, stderr = ''): void {
  mocks.execFile.mockImplementation(
    (_binary: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
      // Node attaches captured stderr to the error itself, and the service
      // classifies failures by reading it from there.
      callback?.(Object.assign(new Error('spawn failed'), { stderr }, error), {
        stdout: '',
        stderr,
      })
    },
  )
}

/** Callback-style mock that writes the file named by the `--output` template. */
function succeedWith(content = 'downloaded media', extension = 'mp4'): void {
  mocks.execFile.mockImplementation(
    (_binary: string, args: string[], _options: unknown, callback?: ExecCallback) => {
      const outputIndex = args.indexOf('--output')
      const template = args[outputIndex + 1] ?? ''
      writeFileSync(template.replace('%(ext)s', extension), content)
      callback?.(null, { stdout: '', stderr: '' })
    },
  )
}

function outputTemplateOf(callIndex = 0): string {
  const args = mocks.execFile.mock.calls[callIndex]?.[1] as string[]
  const outputIndex = args.indexOf('--output')
  return args[outputIndex + 1] ?? ''
}

describe('yt-dlp argument construction', () => {
  const config = loadConfig({})

  it('caps resolution, keeps one video, and separates options from the URL', () => {
    const args = buildYtDlpArgs({
      url: 'https://www.youtube.com/watch?v=example',
      config,
      outputTemplate: '/tmp/out/platform-source.%(ext)s',
    })

    expect(args).toContain('--no-playlist')
    expect(args).toContain('--ignore-config')
    expect(args[args.indexOf('--extractor-args') + 1]).toBe(
      'youtube:player_client=default,web_safari',
    )
    expect(args[args.indexOf('--format') + 1]).toBe(buildFormatSelector(720))
    expect(args[args.indexOf('--max-filesize') + 1]).toBe(String(config.downloadMaxBytes))
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4')
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=example'])
  })

  it('prefers H.264/AAC in MP4 and keeps lower-quality fallbacks', () => {
    const selector = buildFormatSelector(480)
    expect(
      selector.startsWith('bestvideo[height<=?480][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]'),
    ).toBe(true)
    expect(selector.endsWith('/best[height<=?480]')).toBe(true)
    expect(selector).toContain('bestvideo[height<=?480]+bestaudio')
  })

  it('keeps the height cap on every alternative', () => {
    for (const alternative of buildFormatSelector(720).split('/')) {
      expect(alternative).toContain('[height<=?720]')
      // A bare `[height<=720]` would drop audio-only and height-less formats.
      expect(alternative).not.toContain('[height<=720]')
    }
  })

  it('adds the egress proxy before the URL separator', () => {
    const args = buildYtDlpArgs({
      url: 'https://example.com/v',
      config: loadConfig({}),
      outputTemplate: 'out.%(ext)s',
      proxyUrl: 'http://127.0.0.1:1234',
    })

    expect(args[args.indexOf('--proxy') + 1]).toBe('http://127.0.0.1:1234')
    expect(args.slice(-2)).toEqual(['--', 'https://example.com/v'])
  })

  it('passes the cookie file and impersonation target only when configured', () => {
    const configured = loadConfig({
      YT_DLP_COOKIES_FILE: '/secrets/cookies.txt',
      YT_DLP_IMPERSONATE: 'chrome',
    })
    const args = buildYtDlpArgs({
      url: 'https://example.com/video',
      config: configured,
      outputTemplate: 'out.%(ext)s',
    })

    expect(args[args.indexOf('--cookies') + 1]).toBe('/secrets/cookies.txt')
    expect(args[args.indexOf('--impersonate') + 1]).toBe('chrome')

    const plain = buildYtDlpArgs({
      url: 'https://example.com/video',
      config: loadConfig({}),
      outputTemplate: 'out.%(ext)s',
    })
    expect(plain).not.toContain('--cookies')
    expect(plain).not.toContain('--impersonate')
  })
})

describe('downloadFromPlatform', () => {
  let dir: string

  beforeEach(async () => {
    mocks.execFile.mockReset()
    dir = await mkdtemp(path.join(tmpdir(), 'va-ytdlp-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the downloaded file with a content identity', async () => {
    succeedWith('downloaded media')
    const result = await downloadFromPlatform(
      'https://www.youtube.com/watch?v=example',
      dir,
      loadConfig({}),
    )

    expect(result.mimeType).toBe('video/mp4')
    expect(result.sizeBytes).toBe('downloaded media'.length)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(result.path)).isFile()).toBe(true)
    expect(result.path.startsWith(dir)).toBe(true)
    expect(mocks.execFile.mock.calls[0]?.[0]).toBe('yt-dlp')
  })

  it('reports a missing downloader as a dependency problem', async () => {
    failWith({ code: 'ENOENT' })
    await expect(
      downloadFromPlatform('https://example.com/v', dir, loadConfig({})),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
      message: expect.stringMatching(/yt-dlp is required/),
    })
  })

  it('names YT_DLP_PATH when the configured binary is missing', async () => {
    failWith({ code: 'ENOENT' })
    const config = loadConfig({ YT_DLP_PATH: '/opt/nope/yt-dlp' })
    await expect(downloadFromPlatform('https://example.com/v', dir, config)).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
      message: expect.stringMatching(/configured yt-dlp binary/),
    })
  })

  it('explains the bot-check failure instead of echoing stderr', async () => {
    failWith(
      { code: 1 },
      'ERROR: [youtube] example: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser or --cookies',
    )
    await expect(
      downloadFromPlatform('https://www.youtube.com/watch?v=example', dir, loadConfig({})),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringMatching(/signed-in session/),
      hint: expect.stringMatching(/YT_DLP_COOKIES_FILE/),
    })
  })

  it('points a 403 at impersonation and cookies', async () => {
    failWith({ code: 1 }, 'ERROR: unable to download video data: HTTP Error 403: Forbidden')
    await expect(
      downloadFromPlatform('https://www.youtube.com/watch?v=example', dir, loadConfig({})),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      hint: expect.stringMatching(/YT_DLP_IMPERSONATE=chrome/),
    })
  })

  it('treats an unsupported page as unsupported input', async () => {
    failWith({ code: 1 }, 'ERROR: Unsupported URL: https://example.com/thing')
    await expect(
      downloadFromPlatform('https://example.com/thing', dir, loadConfig({})),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  })

  it('rejects a configured cookie file that does not exist before spawning', async () => {
    const config = loadConfig({ YT_DLP_COOKIES_FILE: path.join(dir, 'missing.txt') })
    await expect(downloadFromPlatform('https://example.com/v', dir, config)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/YT_DLP_COOKIES_FILE does not exist/),
    })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('rejects output that exceeds the download limit', async () => {
    // The mock ignores --max-filesize, which is exactly the case the
    // post-download check exists for.
    mocks.execFile.mockImplementation(
      (_binary: string, args: string[], _options: unknown, callback?: ExecCallback) => {
        const outputIndex = args.indexOf('--output')
        const template = args[outputIndex + 1] ?? ''
        writeFileSync(template.replace('%(ext)s', 'mp4'), Buffer.alloc(1_500_000))
        callback?.(null, { stdout: '', stderr: '' })
      },
    )
    const config = loadConfig({ VIDEO_ANALYZER_DOWNLOAD_MAX_MB: '1' })

    await expect(downloadFromPlatform('https://example.com/v', dir, config)).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringMatching(/exceeds the size limit/),
    })
  })

  it('reports a timeout as a download failure, not a spawn error', async () => {
    failWith({ code: null, killed: true })
    await expect(
      downloadFromPlatform('https://example.com/v', dir, loadConfig({})),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringMatching(/did not finish within/),
    })
  })

  it('writes into the caller-provided directory', async () => {
    succeedWith('downloaded media')
    await downloadFromPlatform('https://example.com/v', dir, loadConfig({}))
    expect(outputTemplateOf().startsWith(dir)).toBe(true)
  })

  it('routes the downloader through the egress guard', async () => {
    succeedWith('downloaded media')
    await downloadFromPlatform('https://example.com/v', dir, loadConfig({}))

    const args = mocks.execFile.mock.calls[0]?.[1] as string[]
    expect(args[args.indexOf('--proxy') + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('fails when the downloader exits cleanly without writing media', async () => {
    mocks.execFile.mockImplementation(
      (_binary: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        writeFileSync(path.join(dir, 'platform-source.mp4.part'), 'partial')
        callback?.(null, { stdout: '', stderr: '' })
      },
    )
    await expect(
      downloadFromPlatform('https://example.com/v', dir, loadConfig({})),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringMatching(/produced no media file/),
    })
  })
})
