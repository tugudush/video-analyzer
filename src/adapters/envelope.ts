import { open } from 'node:fs/promises'
import { mimeTypeFromPath } from '../utils/mime.js'
import type { OperationResult } from '../operations/types.js'

/**
 * Interface-neutral conversion of an `OperationResult` into a JSON envelope.
 *
 * Both adapters reuse this shape so a CLI caller and an MCP client see the same
 * fields. Binary image data is only inlined when the caller asks for it.
 */
export interface ResultEnvelope {
  ok: true
  summary: string
  data?: unknown
  warnings: string[]
  images: Array<{ path: string; mimeType: string; label?: string }>
  artifacts: Array<{ path: string; kind: string; mimeType?: string; label?: string }>
}

export function toResultEnvelope(result: OperationResult): ResultEnvelope {
  return {
    ok: true,
    summary: result.summary,
    ...(result.data !== undefined ? { data: result.data } : {}),
    warnings: result.warnings ?? [],
    images: (result.images ?? []).map((image) => ({
      path: image.path,
      mimeType: image.mimeType,
      ...(image.label ? { label: image.label } : {}),
    })),
    artifacts: (result.artifacts ?? []).map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.label ? { label: artifact.label } : {}),
    })),
  }
}

export interface LoadedImage {
  path: string
  base64: string
  mimeType: string
  label?: string
}

export interface SkippedImage {
  path: string
  sizeBytes: number
  label?: string
}

export interface LoadedImages {
  images: LoadedImage[]
  /** Frames left on disk because inlining them would exceed the budget. */
  skipped: SkippedImage[]
}

/**
 * Base64 characters one MCP result may carry before frames are referenced by
 * path instead of inlined.
 *
 * MCP clients and stdio proxies cap message size, and a frame page is the only
 * result that can grow to megabytes: twenty 1280 px JPEGs at `-q:v 3` encode to
 * roughly 2–5 MB. Frames are never dropped — the caller can still read them from
 * disk — but a page over the budget would otherwise fail to deliver at all.
 */
export const INLINE_IMAGE_BUDGET_BYTES = 2 * 1024 * 1024

/** Length of the base64 encoding of `bytes`, without materialising the string. */
function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}

/**
 * Read image artifacts into base64 for interfaces that inline binary content
 * instead of referencing files.
 */
export async function loadImages(
  result: OperationResult,
  options: { maxBase64Bytes?: number } = {},
): Promise<LoadedImages> {
  const source = result.images ?? []
  if (source.length === 0) return { images: [], skipped: [] }

  const budget = Math.max(1, options.maxBase64Bytes ?? INLINE_IMAGE_BUDGET_BYTES)
  const images: LoadedImage[] = []
  const skipped: SkippedImage[] = []
  let remaining = budget

  for (const image of source) {
    const file = await open(image.path, 'r')
    try {
      const maxBytes = Math.floor(remaining / 4) * 3
      const info = await file.stat()
      if (info.size > maxBytes) {
        skipped.push({
          path: image.path,
          sizeBytes: info.size,
          ...(image.label ? { label: image.label } : {}),
        })
        continue
      }

      const chunks: Buffer[] = []
      let total = 0
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1))
      while (total <= maxBytes) {
        const { bytesRead } = await file.read(
          chunk,
          0,
          Math.min(chunk.length, maxBytes - total + 1),
          null,
        )
        if (bytesRead === 0) break
        total += bytesRead
        if (total <= maxBytes) chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      }

      if (total > maxBytes) {
        skipped.push({
          path: image.path,
          sizeBytes: Math.max(total, (await file.stat()).size),
          ...(image.label ? { label: image.label } : {}),
        })
        continue
      }
      const buffer = Buffer.concat(chunks, total)
      remaining -= base64Length(buffer.byteLength)
      images.push({
        path: image.path,
        base64: buffer.toString('base64'),
        mimeType: image.mimeType || mimeTypeFromPath(image.path) || 'image/jpeg',
        ...(image.label ? { label: image.label } : {}),
      })
    } finally {
      await file.close()
    }
  }

  return { images, skipped }
}
