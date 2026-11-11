import { describe, expect, it } from 'vitest'
import { parseArgs, runCli } from '../../src/adapters/cli.js'

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
})
