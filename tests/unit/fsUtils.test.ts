import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalPath,
  isSameFile,
  removeDir,
  sweepStaleTempDirs,
} from '../../src/utils/fsUtils.js'
import { createLogger } from '../../src/utils/logger.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

describe('removeDir', () => {
  it('logs a failed cleanup without throwing or hiding the path', async () => {
    const warn = vi.fn()
    const logger = { ...createLogger('silent'), warn }
    const failure = Object.assign(new Error('access denied'), { code: 'EACCES' })
    vi.mocked(rm).mockRejectedValueOnce(failure)

    await expect(removeDir('temporary-media', logger)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('temporary-media'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('access denied'))
  })
})

async function tryLinkDir(target: string, linkPath: string): Promise<boolean> {
  try {
    // 'junction' avoids elevation on Windows and is ignored on POSIX.
    await symlink(target, linkPath, 'junction')
    return true
  } catch {
    return false
  }
}

describe('canonicalPath', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-fsutils-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('canonicalizes a path that does not exist yet', async () => {
    const direct = await canonicalPath(path.join(dir, 'missing.txt'))
    const dotted = await canonicalPath(path.join(dir, 'nested', '..', 'missing.txt'))

    expect(dotted).toBe(direct)
    expect(path.isAbsolute(direct)).toBe(true)
  })

  it('resolves an existing ancestor through a directory link', async (context) => {
    const linkPath = path.join(dir, 'dir-link')
    if (!(await tryLinkDir(dir, linkPath))) {
      context.skip() // Directory links are unavailable on this platform.
      return
    }

    const canonicalDir = await canonicalPath(dir)
    expect(await canonicalPath(path.join(linkPath, 'missing.txt'))).toBe(
      path.join(canonicalDir, 'missing.txt'),
    )
  })
})

describe('isSameFile', () => {
  let dir: string
  let source: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'va-fsutils-'))
    source = path.join(dir, 'sample.mp4')
    await writeFile(source, 'bytes', 'utf8')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('matches the same path and separates different ones', async () => {
    const other = path.join(dir, 'other.txt')
    await writeFile(other, 'other', 'utf8')

    expect(await isSameFile(source, source)).toBe(true)
    expect(await isSameFile(source, other)).toBe(false)
    expect(await isSameFile(source, path.join(dir, 'missing.txt'))).toBe(false)
  })

  it('matches a hard link to the same file', async (context) => {
    const alias = path.join(dir, 'hardlink.mp4')
    try {
      await link(source, alias)
    } catch {
      context.skip() // Hard links are unavailable on some filesystems.
      return
    }

    expect(await isSameFile(source, alias)).toBe(true)
  })

  it('matches a path reached through a directory link', async (context) => {
    const linkPath = path.join(dir, 'dir-link')
    if (!(await tryLinkDir(dir, linkPath))) {
      context.skip() // Directory links are unavailable on this platform.
      return
    }

    expect(await isSameFile(source, path.join(linkPath, 'sample.mp4'))).toBe(true)
  })

  it('matches a spelling that differs only by case on case-insensitive volumes', async (context) => {
    const variant = path.join(dir.toUpperCase(), 'SAMPLE.MP4')
    if (
      !(await stat(variant).then(
        () => true,
        () => false,
      ))
    ) {
      context.skip() // Case-sensitive filesystem: the variant is a different path.
      return
    }

    expect(await isSameFile(source, variant)).toBe(true)
  })
})

/**
 * A killed Skill launcher leaves its staged JSON payload behind; that file holds
 * media paths and questions, so the sweep must not only look at directories.
 */
describe('sweepStaleTempDirs', () => {
  const base = tmpdir()
  const stamp = `${process.pid}-${randomUUID().slice(0, 8)}`
  const payload = path.join(base, `video-analyzer-input-${stamp}.json`)
  const staleDir = path.join(base, `video-analyzer-sweep-${stamp}`)
  const recentFile = path.join(base, `video-analyzer-input-${stamp}-recent.json`)

  afterEach(async () => {
    await rm(payload, { force: true })
    await rm(recentFile, { force: true })
    await rm(staleDir, { recursive: true, force: true })
  })

  it('removes stale payload files and directories but keeps recent ones', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    await writeFile(payload, '{}', 'utf8')
    await writeFile(recentFile, '{}', 'utf8')
    await mkdir(staleDir)
    await utimes(payload, hourAgo, hourAgo)
    await utimes(staleDir, hourAgo, hourAgo)

    await sweepStaleTempDirs(60 * 1000)

    await expect(stat(payload)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(staleDir)).rejects.toMatchObject({ code: 'ENOENT' })
    // A payload that may still belong to a running launcher is left alone.
    await expect(stat(recentFile)).resolves.toBeDefined()
  })
})
