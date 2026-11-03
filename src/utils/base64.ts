import { readFile } from 'node:fs/promises'

export function bufferToBase64(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString('base64')
}

export async function fileToBase64(filePath: string): Promise<string> {
  return bufferToBase64(await readFile(filePath))
}
