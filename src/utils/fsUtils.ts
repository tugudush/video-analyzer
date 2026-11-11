import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createLogger, type Logger } from './logger.js'

const TEMP_PREFIX = 'video-analyzer-owned-'
const OWNER_FILE = '.video-analyzer-owner.json'

/** Create a per-request working directory under the OS temp directory. */
export async function createTempDir(base = tmpdir()): Promise<string> {
  const dir = await mkdtemp(path.join(base, TEMP_PREFIX))
  try {
    await writeFile(path.join(dir, OWNER_FILE), JSON.stringify({ version: 1, pid: process.pid }), {
      flag: 'wx',
      mode: 0o600,
    })
    return dir
  } catch (error) {
    await removeDir(dir)
    throw error
  }
}

/** Best-effort removal; report failures without masking the operation's error. */
export async function removeDir(
  dir: string | null | undefined,
  logger: Logger = createLogger('warn'),
): Promise<void> {
  if (!dir) return
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    logger.warn(
      `Could not remove temporary directory ${dir}: ${String(error)}. Delete it manually.`,
    )
  }
}

/**
 * Only marked directories owned by an exited process are candidates for cleanup.
 * PID reuse or an inaccessible process conservatively keeps the directory.
 */
export async function sweepStaleTempDirs(
  options: { maxAgeMs?: number; base?: string; logger?: Logger } = {},
): Promise<void> {
  const { maxAgeMs = 24 * 60 * 60 * 1000, base = tmpdir(), logger = createLogger('warn') } = options
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const cutoff = Date.now() - maxAgeMs
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(TEMP_PREFIX))
      .map(async (entry) => {
        const full = path.join(base, entry)
        try {
          const info = await lstat(full)
          if (!info.isDirectory() || info.mtimeMs >= cutoff) return
          if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return
          const marker = path.join(full, OWNER_FILE)
          const markerInfo = await lstat(marker)
          if (!markerInfo.isFile() || markerInfo.size > 1024) return
          const owner: unknown = JSON.parse(await readFile(marker, 'utf8'))
          if (
            typeof owner !== 'object' ||
            owner === null ||
            !('version' in owner) ||
            owner.version !== 1 ||
            !('pid' in owner) ||
            typeof owner.pid !== 'number' ||
            !Number.isSafeInteger(owner.pid) ||
            owner.pid <= 0
          )
            return
          try {
            process.kill(owner.pid, 0)
            return
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
          }
          await removeDir(full, logger)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
            return
          logger.warn(`Could not inspect temporary directory ${full}: ${String(error)}`)
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
