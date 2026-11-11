/**
 * Cancellation and deadline helpers.
 *
 * Remote calls need two independent bounds: the caller giving up (an
 * `AbortSignal`) and a deadline for the call itself. Both have to reach the
 * underlying request so the socket is actually closed, and both have to reject
 * the awaited promise even when the client library ignores the signal.
 */

/**
 * Largest delay Node honours for `setTimeout`, `AbortSignal.timeout`, and the
 * equivalent timer inside a client library.
 *
 * Node clamps anything above this to 1 ms and emits a `TimeoutOverflowWarning`,
 * so an "effectively unlimited" timeout would fire before the request even
 * starts instead of never firing.
 */
export const MAX_TIMER_MS = 2_147_483_647

/** Clamp a delay into the range Node's timers accept. */
export function clampTimerMs(ms: number): number {
  if (!Number.isFinite(ms)) return MAX_TIMER_MS
  return Math.min(Math.max(1, Math.floor(ms)), MAX_TIMER_MS)
}

export interface BoundOptions {
  /**
   * Milliseconds allowed for the call. Values `<= 0` disable the deadline and
   * only honour the caller signal.
   */
  timeoutMs: number
  /** Cancels the call when the caller gives up. */
  signal?: AbortSignal
  /** Error used when the deadline elapses. */
  onTimeout: () => Error
  /** Error used when the caller signal aborts. */
  onCancel: () => Error
}

/**
 * Run `work` under a deadline and a caller signal.
 *
 * `work` receives a signal that aborts when either bound fires, so the request
 * it issues is cancelled rather than abandoned. The returned promise settles as
 * soon as one bound fires, even if `work` never settles, which is what makes a
 * stalled client library recoverable.
 */
export async function runWithBounds<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: BoundOptions,
): Promise<T> {
  if (options.signal?.aborted) throw options.onCancel()

  const controller = new AbortController()
  const requestSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  const deadline = new Promise<never>((_, reject) => {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return
    timer = setTimeout(() => {
      controller.abort()
      reject(options.onTimeout())
    }, clampTimerMs(options.timeoutMs))
    // A pending deadline must not keep an otherwise finished process alive.
    timer.unref?.()
  })

  const cancelled = new Promise<never>((_, reject) => {
    if (!options.signal) return
    onAbort = () => {
      controller.abort()
      reject(options.onCancel())
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([work(requestSignal), deadline, cancelled])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort)
  }
}

/** True when a rejection came from an aborted or timed-out request. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error.name === 'APIUserAbortError')
  )
}
