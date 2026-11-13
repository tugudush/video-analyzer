import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createLogger, type Logger } from '../utils/logger.js'

/**
 * Persistent Gemini upload references.
 *
 * Only a file name, its MIME type, and an expiry are stored: no media, prompt,
 * answer, URL, or credential. The reference is never trusted on its own — the
 * caller re-reads the file from Gemini and reuses it only when it is ACTIVE.
 */

const SCHEMA_VERSION = 1
const MAX_FILE_BYTES = 1024 * 1024
const MAX_KEY_LENGTH = 200
const LOCK_TIMEOUT_MS = 2_000
const LOCK_STALE_MS = 10_000

export interface UploadReference {
  fileName: string
  mimeType: string
  expiresAtMs: number
  savedAtMs: number
}

export interface UploadReferenceInput {
  fileName: string
  mimeType: string
  expiresAtMs: number
}

export interface UploadReferenceStore {
  /** Resolves once the on-disk state has been read (never rejects). */
  readonly ready: Promise<void>
  get(key: string): UploadReference | undefined
  set(key: string, reference: UploadReferenceInput): void
  delete(key: string): void
  flush(): Promise<void>
}

export interface UploadStoreOptions {
  dir: string
  /** Credential fingerprint; partitions entries from different API keys. */
  scope: string
  maxEntries?: number
  logger?: Logger
  now?: () => number
}

/**
 * One-way fingerprint of an API key, used only to partition the cache.
 *
 * A key rotated for the same account simply misses; the key itself is never
 * written to disk.
 */
export function credentialScope(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

interface PersistedFile {
  version: number
  entries: Record<string, UploadReference>
}

type PendingOperation =
  { type: 'set'; key: string; reference: UploadReferenceInput } | { type: 'delete'; key: string }

function isReference(value: unknown): value is UploadReference {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['fileName'] === 'string' &&
    candidate['fileName'].length > 0 &&
    typeof candidate['mimeType'] === 'string' &&
    typeof candidate['expiresAtMs'] === 'number' &&
    Number.isFinite(candidate['expiresAtMs']) &&
    typeof candidate['savedAtMs'] === 'number' &&
    Number.isFinite(candidate['savedAtMs'])
  )
}

/**
 * Bounded, cross-process upload-reference store.
 *
 * Writes re-read the file under a lock before merging, so a second process
 * cannot lose entries it never touched. A race may still cause two uploads of
 * the same media; it must never publish a partial or mismatched entry.
 */
export class FileUploadReferenceStore implements UploadReferenceStore {
  readonly ready: Promise<void>

  private readonly dir: string
  private readonly file: string
  private readonly lockFile: string
  private readonly maxEntries: number
  private readonly logger: Logger
  private readonly now: () => number
  private readonly entries = new Map<string, UploadReference>()
  private pending: PendingOperation[] = []
  private flushChain: Promise<void> = Promise.resolve()
  private warned = false
  private clock = 0

  constructor(options: UploadStoreOptions) {
    this.dir = options.dir
    this.file = path.join(options.dir, `uploads-${options.scope}.json`)
    this.lockFile = `${this.file}.lock`
    this.maxEntries = options.maxEntries ?? 32
    this.logger = options.logger ?? createLogger('warn')
    this.now = options.now ?? (() => Date.now())
    this.ready = this.load()
  }

  get(key: string): UploadReference | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  set(key: string, reference: UploadReferenceInput): void {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) return
    this.entries.set(key, { ...reference, savedAtMs: this.nextSavedAt() })
    this.pending.push({ type: 'set', key, reference })
    this.scheduleFlush()
  }

  delete(key: string): void {
    if (!this.entries.delete(key)) return
    this.pending.push({ type: 'delete', key })
    this.scheduleFlush()
  }

  /** Serialized so overlapping writes never interleave their merge steps. */
  flush(): Promise<void> {
    this.flushChain = this.flushChain
      .then(() => this.writePending())
      .catch((error: unknown) => {
        this.warnOnce(`Could not persist the Gemini upload cache: ${String(error)}`)
      })
    return this.flushChain
  }

  /**
   * Insertion order for LRU eviction.
   *
   * Wall-clock milliseconds collide inside one burst of writes, and identical
   * timestamps make eviction depend on map order. Advancing by one keeps the
   * order deterministic in this process while still tracking real time across
   * processes.
   */
  private nextSavedAt(): number {
    this.clock = Math.max(this.now(), this.clock + 1)
    return this.clock
  }

  private scheduleFlush(): void {
    void this.flush()
  }

  private async load(): Promise<void> {
    // Started from the constructor, so a failure here must never surface as an
    // unhandled rejection; persistence is an optimization, not a requirement.
    try {
      const info = await stat(this.file)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        this.warnOnce(`Ignoring the upload cache at ${this.file}: unexpected size.`)
        return
      }
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!this.isPersistedFile(parsed)) {
        this.warnOnce(`Ignoring the upload cache at ${this.file}: unsupported format.`)
        return
      }
      const now = this.now()
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue
        if (!isReference(entry) || entry.expiresAtMs <= now) continue
        this.entries.set(key, entry)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warnOnce(`Could not read the upload cache at ${this.file}: ${String(error)}`)
      }
    }
  }

  private isPersistedFile(value: unknown): value is PersistedFile {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    if (candidate['version'] !== SCHEMA_VERSION) return false
    const entries = candidate['entries']
    return typeof entries === 'object' && entries !== null && !Array.isArray(entries)
  }

  private async writePending(): Promise<void> {
    if (this.pending.length === 0) return
    const operations = this.pending
    this.pending = []

    const release = await this.acquireLock()
    try {
      const merged = await this.readForMerge()
      const now = this.now()
      for (const operation of operations) {
        if (operation.type === 'delete') {
          merged.delete(operation.key)
        } else {
          merged.set(operation.key, { ...operation.reference, savedAtMs: this.nextSavedAt() })
        }
      }

      const kept = [...merged.entries()]
        .filter(([, entry]) => entry.expiresAtMs > now)
        .toSorted((a, b) => b[1].savedAtMs - a[1].savedAtMs)
        .slice(0, this.maxEntries)

      // Keep the in-memory view consistent with what was actually written.
      this.entries.clear()
      for (const [key, entry] of kept) this.entries.set(key, entry)

      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      const payload: PersistedFile = {
        version: SCHEMA_VERSION,
        entries: Object.fromEntries(kept),
      }
      const staging = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await writeFile(staging, JSON.stringify(payload), { mode: 0o600 })
        await rename(staging, this.file)
      } catch (error) {
        await rm(staging, { force: true }).catch(() => undefined)
        throw error
      }
    } finally {
      await release()
    }
  }

  private async readForMerge(): Promise<Map<string, UploadReference>> {
    const merged = new Map<string, UploadReference>()
    try {
      const info = await stat(this.file)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return merged
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!this.isPersistedFile(parsed)) return merged
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue
        if (isReference(entry)) merged.set(key, entry)
      }
    } catch {
      // A missing or unreadable file means "nothing to merge", not a failure.
    }
    return merged
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600)
        await handle.close()
        return async () => {
          await rm(this.lockFile, { force: true }).catch(() => undefined)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.warnOnce(`Could not lock the upload cache: ${String(error)}`)
          return async () => undefined
        }
        await this.dropStaleLock()
        if (Date.now() >= deadline) {
          this.warnOnce('The upload cache is locked by another process; skipping this write.')
          return async () => undefined
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }

  private async dropStaleLock(): Promise<void> {
    try {
      const info = await stat(this.lockFile)
      if (this.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(this.lockFile, { force: true })
      }
    } catch {
      // The holder released it between the failed create and this check.
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) return
    this.warned = true
    this.logger.warn(message)
  }
}
