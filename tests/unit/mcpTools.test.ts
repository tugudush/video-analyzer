import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { createLogger } from '../../src/utils/logger.js'

const { executeOperation } = vi.hoisted(() => ({ executeOperation: vi.fn() }))

vi.mock('../../src/operations/execute.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/operations/execute.js')>()),
  executeOperation,
}))

const { loadOperationsForMcp } = await import('../../src/adapters/mcpTools.js')

function tool(name: string) {
  const descriptor = loadOperationsForMcp(loadConfig({}), createLogger('silent')).find(
    (entry) => entry.name === name,
  )
  if (!descriptor) throw new Error(`missing tool ${name}`)
  return descriptor
}

describe('loadOperationsForMcp', () => {
  beforeEach(() => {
    executeOperation.mockReset()
    executeOperation.mockResolvedValue({ summary: 'ok' })
  })

  it('forwards MCP request cancellation to the operation context', async () => {
    const controller = new AbortController()

    const result = await tool('get_video_info').invoke(
      { videoPath: '/media/demo.mp4' },
      { signal: controller.signal },
    )

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(executeOperation).toHaveBeenCalledTimes(1)
    const options = executeOperation.mock.calls[0]?.[3] as { signal?: AbortSignal }
    expect(options.signal).toBe(controller.signal)
  })

  it('omits the signal when the client did not provide one', async () => {
    await tool('get_video_info').invoke({ videoPath: '/media/demo.mp4' })

    const options = executeOperation.mock.calls[0]?.[3] as { signal?: AbortSignal }
    expect(options.signal).toBeUndefined()
  })

  it('rejects invalid arguments before running the operation', async () => {
    await expect(tool('get_video_info').invoke({})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(executeOperation).not.toHaveBeenCalled()
  })

  /**
   * A frame page is the only result that can grow to megabytes. Frames beyond the
   * inline budget must still be reported, by path, so the caller can read them.
   */
  it('stops inlining frames at the budget and reports the rest by path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'va-mcp-images-'))
    try {
      const paths: string[] = []
      for (let index = 0; index < 3; index++) {
        const target = path.join(dir, `frame-${String(index).padStart(4, '0')}.jpg`)
        // ~1 MB each: one fits the 2 MB base64 budget, the second does not.
        await writeFile(target, Buffer.alloc(1_000_000, index + 1))
        paths.push(target)
      }

      executeOperation.mockResolvedValue({
        summary: 'frames',
        images: paths.map((framePath) => ({
          path: framePath,
          mimeType: 'image/jpeg',
          label: path.basename(framePath),
        })),
      })

      const result = await tool('extract_frames').invoke({ videoPath: '/media/demo.mp4' })

      const inlined = result.content.filter((part) => part.type === 'image')
      expect(inlined).toHaveLength(1)

      const text = result.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      expect(text).toContain('2 frame(s) were not inlined')
      expect(text).toContain(paths[1] as string)
      expect(text).toContain(paths[2] as string)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
