import { mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const TEMP_PREFIX = 'video-analyzer-'

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
 * Best-effort cleanup of temp directories left behind by a process that was
 * killed mid-operation.
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
          if (info.isDirectory() && info.mtimeMs < cutoff) await removeDir(full)
        } catch {
          // Ignore races with other processes.
        }
      }),
  )
}

/** Create a directory (recursively) if it does not exist yet. */
export async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
}

/** Windows filesystems are case-insensitive, so fold case there. */
function foldForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
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
 * differences; the device/inode pair catches hard links when both exist.
 */
export async function isSameFile(first: string, second: string): Promise<boolean> {
  const [canonicalFirst, canonicalSecond] = await Promise.all([
    canonicalPath(first),
    canonicalPath(second),
  ])
  if (foldForCompare(canonicalFirst) === foldForCompare(canonicalSecond)) return true

  const [infoFirst, infoSecond] = await Promise.all([statOrNull(first), statOrNull(second)])
  if (!infoFirst || !infoSecond) return false
  return infoFirst.dev === infoSecond.dev && infoFirst.ino !== 0 && infoFirst.ino === infoSecond.ino
}
