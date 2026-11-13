import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VideoAnalyzerError, operationCancelled } from '../utils/errors.js'
import { createTempDir, removeDir } from '../utils/fsUtils.js'
import type { Logger } from '../utils/logger.js'

/**
 * A point-in-time copy of a caller's media file.
 *
 * A mutable path cannot identify its contents, so an upload can only be reused
 * safely when the bytes handed to the provider are the bytes that were hashed.
 * The snapshot makes that true: the hash and the upload both read the copy, and
 * the caller's file is never touched.
 */
export interface LocalSnapshot {
  path: string
  sizeBytes: number
  sha256: string
  cleanup(): Promise<void>
  /** Keeps the snapshot alive while a shared upload still reads it. */
  retain(): () => Promise<void>
}

export interface SnapshotOptions {
  logger?: Logger
  signal?: AbortSignal
}

/**
 * Copy `sourcePath` into an owned temporary directory while hashing it.
 *
 * A file that changes during the copy is rejected rather than uploaded: the
 * hash would describe bytes that are only partly the caller's current file.
 */
export async function createLocalSnapshot(
  sourcePath: string,
  options: SnapshotOptions = {},
): Promise<LocalSnapshot> {
  const before = await stat(sourcePath).catch((error: unknown) => {
    throw new VideoAnalyzerError('INPUT_NOT_FOUND', `Could not read ${sourcePath}.`, {
      cause: error,
    })
  })

  const dir = await createTempDir()
  const destination = path.join(dir, `snapshot${path.extname(sourcePath)}`)

  try {
    const hash = createHash('sha256')
    let bytesWritten = 0

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.byteLength
        hash.update(chunk)
        callback(null, chunk)
      },
    })

    try {
      await pipeline(
        createReadStream(sourcePath),
        meter,
        createWriteStream(destination),
        options.signal ? { signal: options.signal } : {},
      )
    } catch (error) {
      if (options.signal?.aborted) throw operationCancelled({ cause: error })
      throw new VideoAnalyzerError('MEDIA_PROCESSING_FAILED', `Could not copy ${sourcePath}.`, {
        hint: 'Free disk space in the temporary directory, and check that the file is readable.',
        cause: error,
      })
    }

    const after = await stat(sourcePath)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new VideoAnalyzerError(
        'MEDIA_PROCESSING_FAILED',
        'The media file changed while it was being read.',
        {
          hint: 'Wait for the file to finish being written (an active download or export) and retry.',
          details: { sourcePath },
        },
      )
    }

    if (bytesWritten !== before.size) {
      throw new VideoAnalyzerError(
        'MEDIA_PROCESSING_FAILED',
        'The media file copy is incomplete.',
        { details: { expectedBytes: before.size, copiedBytes: bytesWritten } },
      )
    }

    let references = 1
    let cleaned = false
    const release = async () => {
      references -= 1
      if (references === 0) await removeDir(dir, options.logger)
    }

    return {
      path: destination,
      sizeBytes: bytesWritten,
      sha256: hash.digest('hex'),
      cleanup: async () => {
        if (cleaned) return
        cleaned = true
        await release()
      },
      retain: () => {
        if (cleaned) throw new Error('Cannot retain a cleaned-up snapshot.')
        references += 1
        let released = false
        return async () => {
          if (released) return
          released = true
          await release()
        }
      },
    }
  } catch (error) {
    await removeDir(dir, options.logger)
    throw error
  }
}
