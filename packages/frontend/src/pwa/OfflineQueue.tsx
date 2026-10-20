import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '@/context/AuthContext'
import type { ApiClient } from '@/lib/api/client'
import { ApiError } from '@/lib/api/errors'
import {
  announce,
  enqueue,
  getSubmission,
  listen,
  MAX_PENDING,
  outcomeOf,
  removeSubmission,
  submissionsOf,
  SYNC_TAG,
  type NewSubmission,
  type Outcome,
  type Rejection,
  type Submission,
} from '@/lib/offlineQueue'
import { createQueueRunner, type QueueRunner } from './queueRunner'
import { useConnectivity } from './useConnectivity'

/** What a form learns from `submit`. */
export type SubmitResult =
  /** The server has it; `data` is its answer when this page sent it. */
  | { status: 'sent'; data?: unknown }
  /** Kept on the phone, sent when the connection allows. */
  | { status: 'queued'; submission: Submission }
  /** The server turned it down (validation, permission): nothing was kept, the form shows why. */
  | { status: 'rejected'; rejection: Rejection }

export interface OfflineQueueValue {
  /** This driver's submissions on this phone, oldest first: waiting and refused. */
  items: Submission[]
  pending: number
  rejected: number
  /** A submission is on its way right now. */
  sending: boolean
  /** MAX_PENDING are waiting: `submit` would be refused. */
  full: boolean
  online: boolean
  /** This browser cannot keep anything (no IndexedDB, or it was refused). */
  unavailable: boolean
  /**
   * Queues it, then tries to send it at once. Throws QueueFullError when
   * MAX_PENDING are already waiting. Each submission gets its own
   * Idempotency-Key, so however often it is sent it is recorded once.
   */
  submit(input: Omit<NewSubmission, 'ownerId'>): Promise<SubmitResult>
  sendNow(): void
  /** Removes a refused submission once the driver has seen why. */
  remove(seq: number): Promise<void>
}

const OfflineQueueContext = createContext<OfflineQueueValue | null>(null)

/** Asks the service worker to send the queue when the connection is back, even with the app closed (Chrome's Background Sync). */
function requestBackgroundSync() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) return
  void navigator.serviceWorker.ready
    .then((registration) => (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register(SYNC_TAG))
    .catch(() => {})
}

/**
 * The offline queue for the signed-in driver (FMS-81), mounted by the driver
 * portal. Sends through the API client, which renews an expired session on
 * the way; the service worker sends too (Background Sync) when it can.
 * Signing out keeps the queue: the same driver's submissions go once they
 * sign in again, and another driver on the phone never sees or sends them.
 */
export function OfflineQueueProvider({ children }: { children: ReactNode }) {
  const { session, api } = useAuth()
  const ownerId = session?.user.id ?? null
  const online = useConnectivity(api)
  const [items, setItems] = useState<Submission[]>([])
  const [sending, setSending] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const runner = useRef<QueueRunner | null>(null)
  /** Answers for submissions a `submit` call is waiting on. */
  const answers = useRef(new Map<number, unknown>())

  const refresh = useCallback(() => {
    if (!ownerId) return
    submissionsOf(ownerId).then(
      (found) => {
        setItems(found)
        setUnavailable(false)
      },
      () => setUnavailable(true),
    )
  }, [ownerId])

  useEffect(() => {
    if (!ownerId) return
    const send = (submission: Submission) => sendFromPage(api, submission, answers.current)
    const current = createQueueRunner({ ownerId, send, onSending: setSending })
    runner.current = current
    refresh()
    void current.run()
    const stopListening = listen((message) => (message.type === 'changed' ? refresh() : void current.run()))
    return () => {
      current.stop()
      stopListening()
      runner.current = null
      setItems([])
    }
  }, [ownerId, api, refresh])

  // Back online (airplane mode off, or the server answering again): send now, not after the backoff.
  useEffect(() => {
    if (online) void runner.current?.wake()
  }, [online])

  const submit = useCallback(
    async (input: Omit<NewSubmission, 'ownerId'>): Promise<SubmitResult> => {
      if (!ownerId) throw new Error('Sign in to send.')
      const queued = await enqueue({ ...input, ownerId })
      announce({ type: 'changed' })
      requestBackgroundSync()
      answers.current.set(queued.seq, undefined)
      await runner.current?.run()
      const data = answers.current.get(queued.seq)
      answers.current.delete(queued.seq)
      const after = await getSubmission(queued.seq)
      if (!after) return { status: 'sent', data }
      if (after.state === 'rejected') {
        await removeSubmission(after.seq)
        announce({ type: 'changed' })
        return { status: 'rejected', rejection: after.rejection! }
      }
      return { status: 'queued', submission: after }
    },
    [ownerId],
  )

  const remove = useCallback(async (seq: number) => {
    await removeSubmission(seq)
    announce({ type: 'changed' })
  }, [])

  const sendNow = useCallback(() => void runner.current?.wake(), [])

  const value = useMemo((): OfflineQueueValue => {
    const pending = items.filter((s) => s.state === 'pending').length
    return {
      items,
      pending,
      rejected: items.length - pending,
      sending: sending && pending > 0,
      full: pending >= MAX_PENDING,
      online,
      unavailable,
      submit,
      sendNow,
      remove,
    }
  }, [items, sending, online, unavailable, submit, sendNow, remove])

  return <OfflineQueueContext.Provider value={value}>{children}</OfflineQueueContext.Provider>
}

async function sendFromPage(api: ApiClient, submission: Submission, answers: Map<number, unknown>): Promise<Outcome> {
  try {
    const { data } = await api.requestEnvelope(submission.path, { method: 'POST', json: submission.body, idempotencyKey: submission.key })
    if (answers.has(submission.seq)) answers.set(submission.seq, data)
    return { kind: 'delivered' }
  } catch (err) {
    // No answer at all (offline, the connection dropped): try again later.
    return err instanceof ApiError ? outcomeOf(err.status, err.code, err.message) : { kind: 'retry' }
  }
}

/** The driver's offline queue. Only inside the driver portal. */
export function useOfflineQueue(): OfflineQueueValue {
  const value = useContext(OfflineQueueContext)
  if (!value) throw new Error('useOfflineQueue must be used inside <OfflineQueueProvider>')
  return value
}
