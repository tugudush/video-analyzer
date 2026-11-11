import { describe, expect, it } from 'vitest'
import { formatBytes, formatTimestamp } from '../../src/operations/shared.js'

describe('formatTimestamp', () => {
  it('renders HH:MM:SS.mmm', () => {
    expect(formatTimestamp(0)).toBe('00:00:00.000')
    expect(formatTimestamp(65.25)).toBe('00:01:05.250')
    expect(formatTimestamp(3725.5)).toBe('01:02:05.500')
  })

  it('carries rounded milliseconds into the seconds field', () => {
    expect(formatTimestamp(1.9996)).toBe('00:00:02.000')
    expect(formatTimestamp(5.9999)).toBe('00:00:06.000')
    expect(formatTimestamp(59.9999)).toBe('00:01:00.000')
    expect(formatTimestamp(1.9994)).toBe('00:00:01.999')
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
