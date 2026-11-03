import { describe, expect, it } from 'vitest'
import { parseTimestampMatches } from '../../src/operations/searchTimestamp.js'

describe('parseTimestampMatches', () => {
  it('parses start and end timestamps with a description', () => {
    const text = 'MATCH 42.5 47.0 — the speaker points at the pricing table'
    expect(parseTimestampMatches(text)).toEqual([
      {
        startSeconds: 42.5,
        endSeconds: 47,
        description: 'the speaker points at the pricing table',
      },
    ])
  })

  it('parses a single timestamp', () => {
    expect(parseTimestampMatches('MATCH 12 — login form appears')).toEqual([
      { startSeconds: 12, description: 'login form appears' },
    ])
  })

  it('parses multiple occurrences and bullet prefixes', () => {
    const text = [
      'Found two moments:',
      '- MATCH 10.0 12.0 — first mention',
      '* MATCH 90.25 95 — second mention',
    ].join('\n')

    const matches = parseTimestampMatches(text)
    expect(matches).toHaveLength(2)
    expect(matches[0]?.startSeconds).toBe(10)
    expect(matches[1]?.startSeconds).toBe(90.25)
    expect(matches[1]?.endSeconds).toBe(95)
  })

  it('accepts en dash and "to" separators', () => {
    expect(parseTimestampMatches('MATCH 5 – 9 — scene')[0]?.endSeconds).toBe(9)
    expect(parseTimestampMatches('MATCH 5 to 9 — scene')[0]?.endSeconds).toBe(9)
  })

  it('ignores prose that is not in the MATCH format', () => {
    expect(parseTimestampMatches('I could not find that in the video.')).toEqual([])
  })

  it('keeps a placeholder description when the line has none', () => {
    expect(parseTimestampMatches('MATCH 3')[0]?.description).toBe('No description provided.')
  })
})
