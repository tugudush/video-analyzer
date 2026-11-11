import { describe, expect, it } from 'vitest'
import { MAX_TIMER_MS, runWithBounds } from '../../src/utils/abort.js'

describe('runWithBounds', () => {
  it('does not fire a deadline Node cannot represent immediately', async () => {
    // Node clamps a delay above 2^31-1 ms to 1 ms, so this used to reject before
    // the work had any chance to finish; it must behave like a very long wait.
    await expect(
      runWithBounds(() => new Promise((resolve) => setTimeout(resolve, 20)), {
        timeoutMs: MAX_TIMER_MS + 1,
        onTimeout: () => new Error('deadline'),
        onCancel: () => new Error('cancel'),
      }),
    ).resolves.toBeUndefined()
  })
})
