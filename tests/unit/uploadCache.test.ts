import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileUploadReferenceStore, credentialScope } from '../../src/services/uploadCache.js'
import { createLogger } from '../../src/utils/logger.js'

const SCOPE = 'scope-a'
const NOW = 1_700_000_000_000

function reference(fileName: string, expiresAtMs = NOW + 60_000) {
  return { fileName, mimeType: 'video/mp4', expiresAtMs }
}

async function openStore(dir: string, now = () => NOW) {
  const store = new FileUploadReferenceStore({
    dir,
    scope: SCOPE,
    logger: createLogger('silent'),
    now,
  })
  await store.ready
  return store
}

describe('credentialScope', () => {
  it('is stable per key and different across keys', () => {
    expect(credentialScope('key-one')).toBe(credentialScope('key-one'))
    expect(credentialScope('key-one')).not.toBe(credentialScope('key-two'))
  })

  it('is undefined without a key', () => {
    expect(credentialScope(undefined)).toBeUndefined()
    expect(credentialScope('')).toBeUndefined()
  })
})

describe('FileUploadReferenceStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-upload-cache-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('survives a new process', async () => {
    const first = await openStore(dir)
    first.set('content:abcd', reference('files/abc'))
    await first.flush()

    const second = await openStore(dir)
    expect(second.get('content:abcd')).toMatchObject({
      fileName: 'files/abc',
      mimeType: 'video/mp4',
    })
  })

  it('stores no media, prompt, or credential material', async () => {
    const store = await openStore(dir)
    store.set('content:abcd', reference('files/abc'))
    await store.flush()

    const raw = await readFile(path.join(dir, `uploads-${SCOPE}.json`), 'utf8')
    expect(raw).not.toContain('files/abc/contents')
    expect(raw).not.toContain('apiKey')
    // Only the reference shape is persisted.
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      entries: { 'content:abcd': { fileName: 'files/abc', mimeType: 'video/mp4' } },
    })
  })

  it('does not serve an expired reference and prunes it on write', async () => {
    const store = await openStore(dir)
    store.set('content:old', reference('files/old', NOW - 1))
    store.set('content:new', reference('files/new'))
    await store.flush()

    const reloaded = await openStore(dir)
    expect(reloaded.get('content:old')).toBeUndefined()
    expect(reloaded.get('content:new')).toBeDefined()
  })

  it('keeps entries written by another process', async () => {
    const first = await openStore(dir)
    const second = await openStore(dir)

    first.set('content:one', reference('files/one'))
    await first.flush()
    second.set('content:two', reference('files/two'))
    await second.flush()

    const reloaded = await openStore(dir)
    expect(reloaded.get('content:one')).toBeDefined()
    expect(reloaded.get('content:two')).toBeDefined()
  })

  it('ignores a corrupt cache file', async () => {
    await writeFile(path.join(dir, `uploads-${SCOPE}.json`), 'not json', 'utf8')
    const store = await openStore(dir)
    expect(store.get('content:abcd')).toBeUndefined()

    store.set('content:abcd', reference('files/abc'))
    await store.flush()
    expect((await openStore(dir)).get('content:abcd')).toBeDefined()
  })

  it('caps the number of kept entries', async () => {
    const store = new FileUploadReferenceStore({
      dir,
      scope: SCOPE,
      maxEntries: 2,
      logger: createLogger('silent'),
      now: () => NOW,
    })
    await store.ready
    store.set('a', reference('files/a'))
    store.set('b', reference('files/b'))
    store.set('c', reference('files/c'))
    await store.flush()

    const reloaded = await openStore(dir)
    expect(reloaded.get('a')).toBeUndefined()
    expect(reloaded.get('b')).toBeDefined()
    expect(reloaded.get('c')).toBeDefined()
  })

  it('removes a deleted reference', async () => {
    const store = await openStore(dir)
    store.set('content:abcd', reference('files/abc'))
    await store.flush()
    store.delete('content:abcd')
    await store.flush()

    expect((await openStore(dir)).get('content:abcd')).toBeUndefined()
  })

  it('creates a missing cache directory before taking the lock', async () => {
    const nested = path.join(dir, 'nested', 'cache')
    const warnings: string[] = []
    const store = new FileUploadReferenceStore({
      dir: nested,
      scope: SCOPE,
      logger: createLogger('warn', (_level, message) => warnings.push(message)),
      now: () => NOW,
    })
    await store.ready
    store.set('content:abcd', reference('files/abc'))
    await store.flush()

    expect(warnings).toEqual([])
    const reloaded = await openStore(nested)
    expect(reloaded.get('content:abcd')).toBeDefined()
  })

  it('skips the write while a lock is held, then retries it', async () => {
    const lockFile = path.join(dir, `uploads-${SCOPE}.json.lock`)
    await writeFile(lockFile, '', 'utf8')

    const store = new FileUploadReferenceStore({
      dir,
      scope: SCOPE,
      logger: createLogger('silent'),
      now: () => NOW,
      lockTimeoutMs: 20,
    })
    await store.ready
    store.set('content:abcd', reference('files/abc'))
    await store.flush()

    // Nothing may be published without the lock.
    await expect(stat(path.join(dir, `uploads-${SCOPE}.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    await rm(lockFile, { force: true })
    await store.flush()
    expect((await openStore(dir)).get('content:abcd')).toBeDefined()
  })
})
