import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalSnapshot } from '../../src/services/localSnapshot.js'

describe('createLocalSnapshot', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-snapshot-'))
    source = path.join(dir, 'clip.mp4')
    await writeFile(source, 'AAAA', 'utf8')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('copies the bytes into an owned file and hashes them', async () => {
    const snapshot = await createLocalSnapshot(source)
    try {
      expect(snapshot.path).not.toBe(source)
      expect(await readFile(snapshot.path, 'utf8')).toBe('AAAA')
      expect(snapshot.sizeBytes).toBe(4)
      expect(snapshot.sha256).toBe(createHash('sha256').update('AAAA').digest('hex'))
    } finally {
      await snapshot.cleanup()
    }
  })

  it('gives different content a different hash even at the same size', async () => {
    const first = await createLocalSnapshot(source)
    const firstHash = first.sha256
    await first.cleanup()

    await writeFile(source, 'BBBB', 'utf8')
    const second = await createLocalSnapshot(source)
    try {
      expect(second.sizeBytes).toBe(first.sizeBytes)
      expect(second.sha256).not.toBe(firstHash)
    } finally {
      await second.cleanup()
    }
  })

  it('leaves the source file in place', async () => {
    const snapshot = await createLocalSnapshot(source)
    await snapshot.cleanup()

    await expect(stat(source)).resolves.toMatchObject({ size: 4 })
    expect(await readFile(source, 'utf8')).toBe('AAAA')
  })

  it('removes the temporary copy on cleanup', async () => {
    const snapshot = await createLocalSnapshot(source)
    const copyDir = path.dirname(snapshot.path)
    await snapshot.cleanup()
    await expect(stat(copyDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the copy alive until every retainer releases it', async () => {
    const snapshot = await createLocalSnapshot(source)
    const copyDir = path.dirname(snapshot.path)
    const release = snapshot.retain()

    await snapshot.cleanup()
    await expect(stat(copyDir)).resolves.toBeDefined()

    await release()
    await expect(stat(copyDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a missing source as INPUT_NOT_FOUND', async () => {
    await expect(createLocalSnapshot(path.join(dir, 'missing.mp4'))).rejects.toMatchObject({
      code: 'INPUT_NOT_FOUND',
    })
  })
})
