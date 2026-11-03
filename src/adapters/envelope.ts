import { readFile } from 'node:fs/promises'
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
  base64: string
  mimeType: string
  label?: string
}

/**
 * Read image artifacts into base64 for interfaces that inline binary content
 * instead of referencing files.
 */
export async function loadImages(result: OperationResult): Promise<LoadedImage[]> {
  if (!result.images || result.images.length === 0) return []

  return Promise.all(
    result.images.map(async (image) => {
      const buffer = await readFile(image.path)
      return {
        base64: buffer.toString('base64'),
        mimeType: image.mimeType || mimeTypeFromPath(image.path) || 'image/jpeg',
        ...(image.label ? { label: image.label } : {}),
      }
    }),
  )
}
