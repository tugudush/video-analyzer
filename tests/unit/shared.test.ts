import { describe, expect, it } from 'vitest'
import { extractJsonPayload, formatBytes, formatTimestamp } from '../../src/operations/shared.js'

describe('formatTimestamp', () => {
  it('renders HH:MM:SS.mmm', () => {
    expect(formatTimestamp(0)).toBe('00:00:00.000')
    expect(formatTimestamp(65.25)).toBe('00:01:05.250')
    expect(formatTimestamp(3725.5)).toBe('01:02:05.500')
  })

  it('handles invalid input', () => {
    expect(formatTimestamp(Number.NaN)).toBe('unknown')
    expect(formatTimestamp(-1)).toBe('unknown')
  })
})

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('extractJsonPayload', () => {
  it('parses a bare JSON array', () => {
    expect(extractJsonPayload('[{"a":1}]')).toEqual([{ a: 1 }])
  })

  it('parses a fenced JSON block', () => {
    const text = 'Here you go:\n```json\n[{"x":1}]\n```\nHope that helps.'
    expect(extractJsonPayload(text)).toEqual([{ x: 1 }])
  })

  it('recovers JSON surrounded by prose', () => {
    const text = 'Detected regions: [{"x":2,"y":3}] as requested.'
    expect(extractJsonPayload(text)).toEqual([{ x: 2, y: 3 }])
  })

  it('returns undefined when there is no JSON', () => {
    expect(extractJsonPayload('no payload here')).toBeUndefined()
    expect(extractJsonPayload('[broken')).toBeUndefined()
  })

  it('prefers an object when it starts first', () => {
    expect(extractJsonPayload('{"regions":[1,2]}')).toEqual({ regions: [1, 2] })
  })
})
