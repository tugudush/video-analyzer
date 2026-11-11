import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { link, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalPath,
  createTempDir,
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

describe('sweepStaleTempDirs', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'va-sweep-test-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('removes only old marked directories whose owner has exited', async () => {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true })
    const pid = child.pid
    await once(child, 'exit')
    if (pid === undefined) throw new Error('Child process did not start.')

    const stale = await createTempDir(base)
    const active = await createTempDir(base)
    const recent = await createTempDir(base)
    const unrelated = path.join(base, 'video-analyzer-owned-unrelated')
    await mkdir(unrelated)
    await writeFile(path.join(unrelated, 'important.txt'), 'keep')
    await writeFile(
      path.join(stale, '.video-analyzer-owner.json'),
      JSON.stringify({ version: 1, pid }),
    )
    await writeFile(
      path.join(recent, '.video-analyzer-owner.json'),
      JSON.stringify({ version: 1, pid }),
    )
    await writeFile(path.join(stale, 'input.json'), 'private payload')
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    await Promise.all([stale, active, unrelated].map((dir) => utimes(dir, hourAgo, hourAgo)))

    await sweepStaleTempDirs({ maxAgeMs: 60 * 1000, base })

    await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(active)).resolves.toBeDefined()
    await expect(stat(recent)).resolves.toBeDefined()
    await expect(stat(path.join(unrelated, 'important.txt'))).resolves.toBeDefined()
  })

  it('leaves unmarked and malformed legacy entries untouched', async () => {
    const legacy = path.join(base, 'video-analyzer-unrelated')
    const malformed = path.join(base, 'video-analyzer-owned-malformed')
    await mkdir(legacy)
    await mkdir(malformed)
    await writeFile(path.join(malformed, '.video-analyzer-owner.json'), '{}')
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    await Promise.all([legacy, malformed].map((dir) => utimes(dir, hourAgo, hourAgo)))

    await sweepStaleTempDirs({ maxAgeMs: 60 * 1000, base })

    await expect(stat(legacy)).resolves.toBeDefined()
    await expect(stat(malformed)).resolves.toBeDefined()
  })
})
