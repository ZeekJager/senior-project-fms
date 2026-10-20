import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

/**
 * The driver app's offline queue (FMS-81): submissions (inspections, fuel,
 * incidents) kept in IndexedDB until the server has acknowledged them.
 * Shared by the page and the service worker, so it uses nothing a worker
 * lacks. What is kept is the request itself and the driver it belongs to,
 * never a token: the session stays in its HttpOnly cookies.
 */

export const DB_NAME = 'fms-offline-queue'
/** Pending submissions one driver may have waiting on this phone (CFG-3). */
export const MAX_PENDING = 50

/** Why the server turned a submission down for good (a 4xx other than 401). */
export interface Rejection {
  status: number
  code: string
  message: string
}

export interface Submission {
  /** Delivery order: IndexedDB's own counter, increasing across the page and the worker. */
  seq: number
  /** The Idempotency-Key, made once when queued and sent with every attempt (api-contract §19). */
  key: string
  /** The driver who submitted it: only their session ever sends it. */
  ownerId: string
  /** What it is, for the list: `dvir`, `fuel`, `incident`. */
  kind: string
  /** How the driver would name it: "Pre-trip inspection, AA 3-10001". */
  label: string
  /** The API path it is POSTed to, under /api/v1. */
  path: string
  body: unknown
  queuedAt: number
  attempts: number
  /** `pending` until delivered (then it is deleted), or `rejected` for the driver to see and remove. */
  state: 'pending' | 'rejected'
  rejection?: Rejection
}

export type NewSubmission = Pick<Submission, 'ownerId' | 'kind' | 'label' | 'path' | 'body'>

/** What the driver is told when the queue is full: by the refusal, and by forms that disable their submit button. */
export const QUEUE_FULL_MESSAGE = `${MAX_PENDING} submissions are already waiting to send. Get signal to send them before adding another.`

export class QueueFullError extends Error {
  readonly code = 'OFFLINE_QUEUE_FULL'
  constructor() {
    super(QUEUE_FULL_MESSAGE)
    this.name = 'QueueFullError'
  }
}

interface QueueSchema extends DBSchema {
  submissions: {
    key: number
    value: Submission
    indexes: { 'owner-state': [string, string]; owner: string }
  }
}

type QueueDb = IDBPDatabase<QueueSchema>

let factory: IDBFactory | undefined
let connection: Promise<QueueDb> | undefined

/** One connection per context; a new one when the factory changes (each test) or the browser closed it (site data cleared). */
function db(): Promise<QueueDb> {
  if (!connection || factory !== indexedDB) {
    factory = indexedDB
    connection = openDB<QueueSchema>(DB_NAME, 1, {
      upgrade(database) {
        const store = database.createObjectStore('submissions', { keyPath: 'seq', autoIncrement: true })
        store.createIndex('owner-state', ['ownerId', 'state'])
        store.createIndex('owner', 'ownerId')
      },
      // A newer version opened elsewhere (a new build): step aside, reopen next time.
      blocking() {
        void connection?.then((open) => open.close())
        connection = undefined
      },
      terminated() {
        connection = undefined
      },
    })
    connection.catch(() => (connection = undefined))
  }
  return connection
}

/**
 * Queues a submission with a fresh Idempotency-Key. Refused with
 * QueueFullError when the driver already has MAX_PENDING waiting; the count
 * and the add are one transaction, so two tabs cannot both take the last place.
 */
export async function enqueue(input: NewSubmission, now = Date.now()): Promise<Submission> {
  const tx = (await db()).transaction('submissions', 'readwrite')
  const pending = await tx.store.index('owner-state').count([input.ownerId, 'pending'])
  if (pending >= MAX_PENDING) {
    tx.abort()
    await tx.done.catch(() => {})
    throw new QueueFullError()
  }
  const draft: Omit<Submission, 'seq'> = { ...input, key: crypto.randomUUID(), queuedAt: now, attempts: 0, state: 'pending' }
  const seq = await tx.store.add(draft as Submission)
  await tx.done
  return { ...draft, seq }
}

/** A driver's submissions, oldest first, pending and rejected. */
export async function submissionsOf(ownerId: string): Promise<Submission[]> {
  return (await db()).getAllFromIndex('submissions', 'owner', ownerId)
}

/** The driver's oldest pending submission: the next to send. */
export async function nextPending(ownerId: string): Promise<Submission | undefined> {
  return (await db()).getFromIndex('submissions', 'owner-state', [ownerId, 'pending'])
}

export async function getSubmission(seq: number): Promise<Submission | undefined> {
  return (await db()).get('submissions', seq)
}

/** Delivered, or a rejected one the driver removed: the only ways out of the queue. */
export async function removeSubmission(seq: number): Promise<void> {
  await (await db()).delete('submissions', seq)
}

/** Changes a submission that is still there; one that was meanwhile delivered stays gone. */
export async function updateSubmission(seq: number, change: (s: Submission) => Submission): Promise<void> {
  const tx = (await db()).transaction('submissions', 'readwrite')
  const current = await tx.store.get(seq)
  if (current) await tx.store.put(change(current))
  await tx.done
}
