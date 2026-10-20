import { backoffMs, flushQueue, type FlushResult, type Outcome, type Submission } from '@/lib/offlineQueue'

/** Another page or the worker is sending: look again shortly. */
const BUSY_RETRY_MS = 2_000

export interface QueueRunner {
  /** Sends what is pending now; runs one after another, never two at once. */
  run(): Promise<FlushResult>
  /** The connection is back: forget the backoff and send at once. */
  wake(): Promise<FlushResult>
  stop(): void
}

/**
 * When the page sends a driver's queue (FMS-81): on demand, and again after
 * a failure with backoff (2 s doubling to 30 s) while the phone has a
 * network. Without one it waits for `wake()` (the `online` event). A 401
 * stops it: the driver signs in again, and a new runner starts.
 */
export function createQueueRunner(options: {
  ownerId: string
  send: (submission: Submission) => Promise<Outcome>
  onSending?: (sending: boolean) => void
}): QueueRunner {
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let chain: Promise<FlushResult> = Promise.resolve('done')

  function later(ms: number) {
    clearTimeout(timer)
    if (stopped || !navigator.onLine) return
    timer = setTimeout(() => void run(), ms)
  }

  function run(): Promise<FlushResult> {
    chain = chain.then(async (): Promise<FlushResult> => {
      if (stopped) return 'done'
      clearTimeout(timer)
      options.onSending?.(true)
      const result = await flushQueue(options.ownerId, options.send).catch((): FlushResult => 'retry')
      options.onSending?.(false)
      if (result === 'retry') later(backoffMs(++failures))
      else if (result === 'busy') later(BUSY_RETRY_MS)
      else failures = 0
      return result
    })
    return chain
  }

  return {
    run,
    wake() {
      failures = 0
      return run()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
