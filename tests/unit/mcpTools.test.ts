import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { createLogger } from '../../src/utils/logger.js'

const { executeOperation } = vi.hoisted(() => ({ executeOperation: vi.fn() }))

vi.mock('../../src/operations/execute.js', () => ({ executeOperation }))

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
})
