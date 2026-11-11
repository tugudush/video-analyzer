import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import {
  parseTimestampMatches,
  searchTimestampOperation,
} from '../../src/operations/searchTimestamp.js'
import { GeminiMediaService, type GeminiApi } from '../../src/services/gemini.js'
import { createLogger } from '../../src/utils/logger.js'
import type { OperationContext } from '../../src/operations/types.js'

// The operation only needs a duration; the search rules are unrelated to ffprobe.
vi.mock('../../src/services/ffmpeg.js', () => ({
  getMediaMetadata: vi.fn(async () => ({
    durationSeconds: 20,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    sizeBytes: 4096,
    bitRate: 32000,
    hasVideo: true,
    hasAudio: true,
    video: undefined,
    audio: undefined,
  })),
}))

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

  /**
   * A description that starts with a number parses as the end of a range, which
   * must not be surfaced as an inverted span ("42 – 3") to the caller.
   */
  it('drops an end that is not after the start', () => {
    expect(parseTimestampMatches('MATCH 42 — 3 speakers appear on screen')).toEqual([
      { startSeconds: 42, description: 'speakers appear on screen' },
    ])
    expect(parseTimestampMatches('MATCH 10 to 5 — backwards range')[0]?.endSeconds).toBeUndefined()
    expect(parseTimestampMatches('MATCH 7 7 — zero length')[0]?.endSeconds).toBeUndefined()
  })
})

function createService(reply: string): GeminiMediaService {
  const handle = {
    name: 'files/abc',
    uri: 'https://generativelanguage.test/v1beta/files/abc',
    mimeType: 'video/mp4',
    state: 'ACTIVE',
  }
  const api = {
    uploadFile: vi.fn(async () => handle),
    getFile: vi.fn(async () => handle),
    generateContent: vi.fn(async () => reply),
  }
  return new GeminiMediaService({
    config: loadConfig({}),
    logger: createLogger('silent'),
    api: api as unknown as GeminiApi,
    sleep: async () => undefined,
  })
}

function createContext(service: GeminiMediaService): OperationContext {
  return { config: loadConfig({}), logger: createLogger('silent'), geminiService: service }
}

/** Every result carries the clip duration so a caller can sanity-check a match. */
describe('search_timestamp result shape', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-search-'))
    source = path.join(dir, 'sample.mp4')
    await writeFile(source, 'placeholder media bytes')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports the duration and the raw reply when nothing matches', async () => {
    const result = await searchTimestampOperation.run(
      { videoPath: source, query: 'a red car' },
      createContext(createService('NO_MATCH — no red car appears in the clip.')),
    )

    expect(result.data).toMatchObject({
      found: false,
      matches: [],
      durationSeconds: 20,
      raw: 'NO_MATCH — no red car appears in the clip.',
    })
  })

  it('warns when a reported timestamp is past the end of the clip', async () => {
    const result = await searchTimestampOperation.run(
      { videoPath: source, query: 'a red car' },
      createContext(createService('MATCH 999 1000 — a red car passes the camera')),
    )

    expect(result.data).toMatchObject({ found: true, durationSeconds: 20 })
    expect(result.warnings?.join(' ')).toContain('beyond the 00:00:20.000 clip')
  })

  /**
   * Only the range that closes inside the clip is usable, so an end past the
   * duration has to be flagged the same way an impossible start is.
   */
  it('warns when a range ends past the end of the clip', async () => {
    const result = await searchTimestampOperation.run(
      { videoPath: source, query: 'a red car' },
      createContext(createService('MATCH 5 30 — a red car passes the camera')),
    )

    expect(result.data).toMatchObject({ found: true, durationSeconds: 20 })
    expect(result.warnings?.join(' ')).toContain('beyond the 00:00:20.000 clip')
  })
})
