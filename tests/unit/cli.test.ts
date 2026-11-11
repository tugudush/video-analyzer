import { readFile } from 'node:fs/promises'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { defaultCliIO, parseArgs, readStdinToEnd, runCli } from '../../src/adapters/cli.js'
import { VERSION } from '../../src/version.js'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    out,
    err,
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  }
}

describe('parseArgs', () => {
  it('defaults to help', () => {
    expect(parseArgs([])).toMatchObject({ command: 'help', pretty: false, help: false })
  })

  it('parses --input', () => {
    const parsed = parseArgs(['get_video_info', '--input', '{"videoPath":"a.mp4"}'])
    expect(parsed.command).toBe('get_video_info')
    expect(parsed.input).toBe('{"videoPath":"a.mp4"}')
  })

  it('parses --input=value form', () => {
    expect(parseArgs(['get_video_info', '--input={"a":1}']).input).toBe('{"a":1}')
  })

  it('parses --input-file and --pretty', () => {
    const parsed = parseArgs(['analyze_video', '--input-file', 'args.json', '--pretty'])
    expect(parsed.inputFile).toBe('args.json')
    expect(parsed.pretty).toBe(true)
  })

  it('rejects a missing value', () => {
    expect(() => parseArgs(['analyze_video', '--input'])).toThrowError(/--input requires/)
    expect(() => parseArgs(['analyze_video', '--input-file'])).toThrowError(/--input-file requires/)
  })

  it('parses --version in both positions', () => {
    expect(parseArgs(['--version']).version).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
    expect(parseArgs(['list', '--version']).version).toBe(true)
    expect(parseArgs(['list']).version).toBe(false)
  })
})

describe('readStdinToEnd', () => {
  it('reads a piped payload to EOF', async () => {
    const stream = Readable.from([Buffer.from('{"videoPath":"a.mp4"}')])
    await expect(readStdinToEnd(stream)).resolves.toBe('{"videoPath":"a.mp4"}')
  })

  it('reads delayed chunks through EOF even after idle periods', async () => {
    const stream = new PassThrough()
    const result = readStdinToEnd(stream)
    await new Promise((resolve) => setTimeout(resolve, 550))
    stream.write('{"videoPath":')
    await new Promise((resolve) => setTimeout(resolve, 550))
    stream.end('"a.mp4"}')
    await expect(result).resolves.toBe('{"videoPath":"a.mp4"}')
  })

  it('returns undefined for whitespace-only input', async () => {
    const stream = Readable.from([Buffer.from('  \n ')])
    await expect(readStdinToEnd(stream)).resolves.toBeUndefined()
  })

  it('reports a stream error instead of returning partial data', async () => {
    const stream = new PassThrough()
    const result = readStdinToEnd(stream)
    const assertion = expect(result).rejects.toMatchObject({
      code: 'INPUT_NOT_FOUND',
      message: 'Could not read standard input.',
    })
    stream.write('{"partial":')
    stream.destroy(new Error('broken pipe'))
    await assertion
  })
})

describe('runCli', () => {
  it('lists operations as JSON', async () => {
    const { io, stdoutText } = capture()
    const code = await runCli(['list'], io, {})

    expect(code).toBe(0)
    const payload = JSON.parse(stdoutText()) as { ok: boolean; operations: Array<{ name: string }> }
    expect(payload.ok).toBe(true)
    expect(payload.operations.map((operation) => operation.name)).toEqual([
      'analyze_video',
      'summarize_video',
      'search_timestamp',
      'transcribe_video',
      'get_video_info',
      'extract_frames',
    ])
  })

  it('prints usage for help', async () => {
    const { io, stdoutText } = capture()
    const code = await runCli(['help'], io, {})
    expect(code).toBe(0)
    expect(stdoutText()).toContain('Usage:')
    expect(stdoutText()).toContain('analyze_video')
  })

  it('reports the package version from a single source', async () => {
    const { io, stdoutText } = capture()
    const code = await runCli(['--version'], io, {})
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string }

    expect(code).toBe(0)
    expect(stdoutText().trim()).toBe(VERSION)
    expect(VERSION).toBe(manifest.version)
  })

  it('prints an operation schema for help <operation>', async () => {
    const { io, stdoutText } = capture()
    const code = await runCli(['help', 'get_video_info'], io, {})
    expect(code).toBe(0)
    expect(stdoutText()).toContain('videoPath')
  })

  it('returns a machine-readable error for unknown operations', async () => {
    const { io, stdoutText, stderrText } = capture()
    const code = await runCli(['does_not_exist'], io, {})

    expect(code).toBe(1)
    const payload = JSON.parse(stdoutText()) as { ok: boolean; error: { code: string } }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('INVALID_INPUT')
    expect(stderrText()).toContain('Available operations')
  })

  it('requires an input payload', async () => {
    const { io, stdoutText } = capture()
    const code = await runCli(['get_video_info'], io, {})

    expect(code).toBe(1)
    const payload = JSON.parse(stdoutText()) as { error: { code: string; hint?: string } }
    expect(payload.error.code).toBe('INVALID_INPUT')
    expect(payload.error.hint).toContain('--input')
  })

  it('rejects malformed JSON', async () => {
    const { io, stdoutText } = capture()
    const code = await runCli(['get_video_info', '--input', '{oops}'], io, {})

    expect(code).toBe(1)
    expect((JSON.parse(stdoutText()) as { error: { message: string } }).error.message).toContain(
      'valid JSON',
    )
  })

  it('reports a missing --input-file as INPUT_NOT_FOUND, not an internal error', async () => {
    const { io, stdoutText, stderrText } = capture()
    const code = await runCli(
      ['get_video_info', '--input-file', 'definitely-missing-args.json'],
      io,
      {},
    )

    expect(code).toBe(1)
    const payload = JSON.parse(stdoutText()) as {
      error: { code: string; message: string; hint?: string }
    }
    expect(payload.error.code).toBe('INPUT_NOT_FOUND')
    expect(payload.error.message).toContain('definitely-missing-args.json')
    expect(payload.error.hint).toContain('--input')
    expect(stderrText()).toContain('INPUT_NOT_FOUND')
  })

  it('reports schema violations with field paths', async () => {
    const { io, stdoutText } = capture()
    const code = await runCli(['analyze_video', '--input', '{"videoPath":"a.mp4"}'], io, {})

    expect(code).toBe(1)
    const message = (JSON.parse(stdoutText()) as { error: { message: string } }).error.message
    expect(message).toContain('question')
  })

  it('surfaces configuration errors before running', async () => {
    const { io, stdoutText } = capture()
    const code = await runCli(['get_video_info', '--input', '{"videoPath":"a.mp4"}'], io, {
      VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: 'not-a-number',
    })

    expect(code).toBe(1)
    expect((JSON.parse(stdoutText()) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT',
    )
  })

  /**
   * `help <operation>` is the documented way out of a rejected request, so a bad
   * setting must not disable it — otherwise the only remaining advice is the one
   * that no longer works.
   */
  it('keeps version, help, and list working when a setting is malformed', async () => {
    const badEnv = { VIDEO_ANALYZER_REQUEST_TIMEOUT_MS: 'not-a-number' }

    const version = capture()
    expect(await runCli(['--version'], version.io, badEnv)).toBe(0)
    expect(version.stdoutText().trim()).toBe(VERSION)

    const help = capture()
    expect(await runCli(['help', 'get_video_info'], help.io, badEnv)).toBe(0)
    expect(help.stdoutText()).toContain('videoPath')

    const list = capture()
    expect(await runCli(['list'], list.io, badEnv)).toBe(0)
    expect(list.stdoutText()).toContain('analyze_video')
  })

  it('installs Ctrl-C cancellation around the operation and removes it afterwards', async () => {
    const { io } = capture()
    let installed: (() => void) | undefined
    let disposed = false

    const code = await runCli(
      ['get_video_info', '--input', '{"videoPath":"a.mp4"}'],
      {
        ...io,
        onCancel: (handler) => {
          installed = handler
          return () => {
            disposed = true
          }
        },
      },
      {},
    )

    expect(code).toBe(1)
    expect(installed).toBeTypeOf('function')
    expect(disposed).toBe(true)
  })

  it('backs the cancellation hook with a SIGINT listener in the default io', () => {
    const before = process.listeners('SIGINT').length
    const dispose = defaultCliIO.onCancel?.(() => undefined)

    expect(process.listeners('SIGINT').length).toBe(before + 1)
    dispose?.()
    expect(process.listeners('SIGINT').length).toBe(before)
  })
})
