import { describe, expect, it } from 'vitest'
import { loadDotEnvInto, parseDotEnv } from '../../src/utils/dotenv.js'

describe('parseDotEnv', () => {
  it('parses simple key/value pairs', () => {
    expect(parseDotEnv('GEMINI_API_KEY=abc123')).toEqual({ GEMINI_API_KEY: 'abc123' })
  })

  it('ignores comments, blank lines, and the export prefix', () => {
    const source = [
      '# a comment',
      '',
      'export GEMINI_API_KEY=abc',
      '   ',
      '   # indented comment',
      'GEMINI_MODEL=gemini-3.8-flash',
    ].join('\n')

    expect(parseDotEnv(source)).toEqual({
      GEMINI_API_KEY: 'abc',
      GEMINI_MODEL: 'gemini-3.8-flash',
    })
  })

  it('handles CRLF line endings', () => {
    expect(parseDotEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' })
  })

  it('strips surrounding quotes, single or double', () => {
    expect(parseDotEnv('A="quoted value"\nB=\'single\'').A).toBe('quoted value')
    expect(parseDotEnv("B='single'").B).toBe('single')
  })

  it('keeps a # inside a quoted value', () => {
    expect(parseDotEnv('A="pass#word"').A).toBe('pass#word')
  })

  it('drops an unquoted trailing comment', () => {
    expect(parseDotEnv('A=value # trailing note').A).toBe('value')
  })

  it('drops a comment that follows a quoted value', () => {
    expect(parseDotEnv('A="quoted value" # trailing note').A).toBe('quoted value')
    expect(parseDotEnv("B='single' # note").B).toBe('single')
    expect(parseDotEnv('GEMINI_API_KEY="abc123" # aistudio').GEMINI_API_KEY).toBe('abc123')
  })

  it('keeps a # inside a quoted value that also has a comment', () => {
    expect(parseDotEnv('A="pass#word" # note').A).toBe('pass#word')
    expect(parseDotEnv('A="pass # word"').A).toBe('pass # word')
  })

  it('keeps empty values', () => {
    expect(parseDotEnv('A=').A).toBe('')
  })

  it('skips malformed lines', () => {
    expect(parseDotEnv('not a pair\nA=1\n=oops')).toEqual({ A: '1' })
  })

  it('returns an empty object for empty input', () => {
    expect(parseDotEnv('')).toEqual({})
  })
})

describe('loadDotEnvInto', () => {
  it('returns an empty list when the file is missing', () => {
    const target: NodeJS.ProcessEnv = {}
    expect(loadDotEnvInto(target, '/definitely/not/here/.env')).toEqual([])
    expect(target).toEqual({})
  })

  it('does not override variables that are already set', () => {
    const target: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'from-shell' }
    // A real file is required, so reuse this repo's example file layout.
    const applied = loadDotEnvInto(target, 'tests/fixtures/dotenv/sample.env')
    expect(target.GEMINI_API_KEY).toBe('from-shell')
    expect(applied).not.toContain('GEMINI_API_KEY')
  })

  it('fills in variables that are unset or blank', () => {
    const target: NodeJS.ProcessEnv = { BLANK: '' }
    loadDotEnvInto(target, 'tests/fixtures/dotenv/sample.env')
    expect(target.FRESH).toBe('filled')
    expect(target.BLANK).toBe('from-file')
  })

  it('only contributes allowlisted keys', () => {
    const target: NodeJS.ProcessEnv = {}
    const applied = loadDotEnvInto(target, 'tests/fixtures/dotenv/sample.env', {
      allowKeys: ['GEMINI_API_KEY', 'QUOTED'],
    })

    expect(applied).toEqual(['GEMINI_API_KEY', 'QUOTED'])
    expect(target).toEqual({ GEMINI_API_KEY: 'from-file', QUOTED: 'value with spaces' })
  })
})
