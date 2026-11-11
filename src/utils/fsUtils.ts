import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const TEMP_PREFIX = 'video-analyzer-'

/**
 * Prefix of the payload files the Skill launcher stages for a Windows `.cmd`
 * shim. They hold media paths and questions, so a killed launcher must not leave
 * them behind indefinitely.
 */
const LAUNCHER_PAYLOAD_PREFIX = 'video-analyzer-input-'

/** Create a per-request working directory under the OS temp directory. */
export async function createTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), TEMP_PREFIX))
}

/** Remove a directory tree, ignoring "already gone" failures. */
export async function removeDir(dir: string | null | undefined): Promise<void> {
  if (!dir) return
  await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
}

/**
 * Best-effort cleanup of temp directories and launcher payload files left behind
 * by a process that was killed mid-operation.
 */
export async function sweepStaleTempDirs(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  const base = tmpdir()
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return
  }

  const cutoff = Date.now() - maxAgeMs
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(TEMP_PREFIX))
      .map(async (entry) => {
        const full = path.join(base, entry)
        try {
          const info = await stat(full)
          if (info.mtimeMs >= cutoff) return
          if (info.isDirectory()) {
            await removeDir(full)
          } else if (entry.startsWith(LAUNCHER_PAYLOAD_PREFIX) && entry.endsWith('.json')) {
            await rm(full, { force: true }).catch(() => undefined)
          }
        } catch {
          // Ignore races with other processes.
        }
      }),
  )
}

/** Create a directory (recursively) if it does not exist yet. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function statOrNull(target: string) {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

/**
 * Canonical absolute form of a path that may not exist yet.
 *
 * The deepest existing ancestor is resolved with `realpath`, so symlinked
 * directories, `..` segments, and platform-specific spellings collapse to one
 * value. Segments below that ancestor are appended unchanged.
 */
export async function canonicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target)
  const missing: string[] = []
  let current = absolute

  for (;;) {
    try {
      const resolved = await realpath(current)
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.toReversed())
    } catch {
      const parent = path.dirname(current)
      // Reached a root that cannot be resolved; fall back to the literal path.
      if (parent === current) return absolute
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Whether two paths refer to the same file.
 *
 * Canonical paths catch relative segments, symlinks, and case/spelling
 * differences (`realpath` returns the on-disk form, which also settles casing
 * on case-insensitive volumes); the device/inode pair catches hard links when
 * both exist.
 */
export async function isSameFile(first: string, second: string): Promise<boolean> {
  const [canonicalFirst, canonicalSecond] = await Promise.all([
    canonicalPath(first),
    canonicalPath(second),
  ])
  if (canonicalFirst === canonicalSecond) return true

  const [infoFirst, infoSecond] = await Promise.all([statOrNull(first), statOrNull(second)])
  if (!infoFirst || !infoSecond) return false
  return infoFirst.dev === infoSecond.dev && infoFirst.ino !== 0 && infoFirst.ino === infoSecond.ino
}
