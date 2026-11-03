import { describe, expect, it } from 'vitest'
import {
  normalizeDetectedRegions,
  normalizeManualRegions,
} from '../../src/operations/redactSensitive.js'

describe('normalizeDetectedRegions', () => {
  it('accepts a valid array and preserves labels', () => {
    const regions = normalizeDetectedRegions(
      [{ x: 10, y: 20, width: 100, height: 40, label: 'api key', confidence: 'high' }],
      640,
      480,
    )
    expect(regions).toEqual([
      { x: 10, y: 20, width: 100, height: 40, label: 'api key', confidence: 'high' },
    ])
  })

  it('clamps regions to the frame', () => {
    const regions = normalizeDetectedRegions(
      [{ x: 600, y: 460, width: 500, height: 500 }],
      640,
      480,
    )
    expect(regions[0]).toMatchObject({ x: 600, y: 460, width: 40, height: 20 })
  })

  it('drops degenerate and malformed entries', () => {
    const regions = normalizeDetectedRegions(
      [
        { x: 0, y: 0, width: 1, height: 10 },
        { x: 'nope', y: 0, width: 10, height: 10 },
        null,
        'string',
        { x: 5, y: 5, width: 20, height: 20 },
      ],
      640,
      480,
    )
    expect(regions).toHaveLength(1)
    expect(regions[0]?.width).toBe(20)
  })

  it('returns an empty array for non-array payloads', () => {
    expect(normalizeDetectedRegions(undefined, 100, 100)).toEqual([])
    expect(normalizeDetectedRegions({ x: 1 }, 100, 100)).toEqual([])
  })
})

describe('normalizeManualRegions', () => {
  it('rounds and clamps to the frame', () => {
    const regions = normalizeManualRegions(
      [{ x: 10.4, y: 20.6, width: 1000, height: 1000 }],
      320,
      240,
    )
    expect(regions[0]).toMatchObject({ x: 10, y: 21, width: 310, height: 219 })
  })

  it('rejects regions that start outside the frame', () => {
    expect(() =>
      normalizeManualRegions([{ x: 400, y: 10, width: 10, height: 10 }], 320, 240),
    ).toThrowError(/outside the 320x240 frame/)
  })

  it('rejects inverted time windows', () => {
    expect(() =>
      normalizeManualRegions(
        [{ x: 0, y: 0, width: 10, height: 10, startTime: 9, endTime: 3 }],
        320,
        240,
      ),
    ).toThrowError(/endTime must be greater than startTime/)
  })

  it('keeps the time window and label', () => {
    const [region] = normalizeManualRegions(
      [{ x: 0, y: 0, width: 10, height: 10, startTime: 1, endTime: 5, label: 'token' }],
      320,
      240,
    )
    expect(region).toMatchObject({ startTime: 1, endTime: 5, label: 'token' })
  })
})
