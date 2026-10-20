import { announce } from './channel'
import { nextPending, removeSubmission, updateSubmission, type Rejection, type Submission } from './store'

/** The Background Sync tag the page registers when it queues, and the worker answers. */
export const SYNC_TAG = 'fms-offline-queue'
/** Held while one context sends, so the page and the worker never send at once. */
const LOCK = 'fms-offline-queue'

/** What one attempt at sending a submission came to. */
export type Outcome =
  /** 2xx, or the stored answer replayed for its key: the server has it. */
  | { kind: 'delivered' }
  /** A 4xx the same request will always get: kept for the driver to see, the rest go on. */
  | { kind: 'rejected'; rejection: Rejection }
  /** No answer, 5xx, 408, 429, or the key still in progress: stop and try again later, in order. */
  | { kind: 'retry' }
  /** 401: nothing more can be sent until the driver signs in again. */
  | { kind: 'signed-out' }

export function outcomeOf(status: number, code = '', message = ''): Outcome {
  if (status >= 200 && status < 300) return { kind: 'delivered' }
  if (status === 401) return { kind: 'signed-out' }
  if (status === 408 || status === 429 || status >= 500 || status < 200) return { kind: 'retry' }
  // The first attempt with this key is still running on the server: its answer will be replayed.
  if (code === 'CONFLICT_IDEMPOTENCY_IN_PROGRESS') return { kind: 'retry' }
  return { kind: 'rejected', rejection: { status, code, message } }
}

/**
 * `done`: nothing of this driver's is pending. `retry`: something could not
 * go yet. `signed-out`: paused until the driver signs in. `busy`: another
 * page or the worker is sending right now.
 */
export type FlushResult = 'done' | 'retry' | 'signed-out' | 'busy'

let sendingHere = false

/** Runs `work` unless another context holds the lock (Web Locks), or this one is already sending. */
async function exclusively(work: () => Promise<FlushResult>): Promise<FlushResult> {
  if (sendingHere) return 'busy'
  sendingHere = true
  try {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    if (!locks) return await work()
    return await locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? work() : 'busy'))
  } finally {
    sendingHere = false
  }
}

/**
 * Sends a driver's pending submissions one at a time, oldest first, until
 * none is left or one cannot go yet. A submission leaves the queue only once
 * the server has answered 2xx; every attempt carries the same
 * Idempotency-Key, so one that reached the server before the answer was lost
 * is replayed, not recorded twice.
 */
export function flushQueue(ownerId: string, send: (submission: Submission) => Promise<Outcome>): Promise<FlushResult> {
  return exclusively(async () => {
    for (;;) {
      const next = await nextPending(ownerId)
      if (!next) return 'done'
      const outcome = await send(next).catch((): Outcome => ({ kind: 'retry' }))
      switch (outcome.kind) {
        case 'delivered':
          await removeSubmission(next.seq)
          announce({ type: 'changed' })
          continue
        case 'rejected':
          await updateSubmission(next.seq, (s) => ({ ...s, attempts: s.attempts + 1, state: 'rejected', rejection: outcome.rejection }))
          announce({ type: 'changed' })
          continue
        case 'retry':
          await updateSubmission(next.seq, (s) => ({ ...s, attempts: s.attempts + 1 }))
          return 'retry'
        case 'signed-out':
          return 'signed-out'
      }
    }
  })
}

/** Wait before the next try after `failures` in a row: 2 s, 4 s, 8 s, ... up to 30 s. */
export const backoffMs = (failures: number) => Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1))

/** The request the service worker sends: what the page's API client would send for the same submission. */
export function requestFor(submission: Submission, channel: 'web' | 'pwa'): { url: string; init: RequestInit } {
  return {
    url: `/api/v1${submission.path}`,
    init: {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': submission.key,
        'X-Client-Channel': channel,
      },
      body: JSON.stringify(submission.body),
    },
  }
}
