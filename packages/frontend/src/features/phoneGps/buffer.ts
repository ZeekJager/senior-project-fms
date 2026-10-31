import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

/**
 * The phone's positions waiting to be sent (FMS-57), in IndexedDB so a closed app or a dead zone loses none.
 * Apart from the offline queue (FMS-81) on purpose: that one holds a driver's forms, at most 50, and six
 * position batches a minute would fill it and block the next fuel log. Positions are kept per driver, so
 * another driver signing in on the phone never sends them.
 */

export const DB_NAME = 'fms-phone-gps'

/** At most this many positions wait on the phone: about 55 hours at one every 10 s. Beyond it the oldest go. */
export const MAX_BUFFERED = 20_000

/** One position as POST /tracking/gps-pings takes it (api-contract §11.1). No vehicle: the server knows it from the trip. */
export interface PhonePing {
  recorded_at: string
  lat: number
  lng: number
  speed_kmh: number
  heading: number | null
  accuracy_m: number | null
  altitude_m: number | null
}

export interface BufferedPing {
  seq: number
  ownerId: string
  ping: PhonePing
}

interface BufferSchema extends DBSchema {
  pings: { key: number; value: BufferedPing; indexes: { owner: string } }
}

let factory: IDBFactory | undefined
let connection: Promise<IDBPDatabase<BufferSchema>> | undefined

/** One connection per context; a new one when the factory changes (each test) or the browser closed it. */
function db(): Promise<IDBPDatabase<BufferSchema>> {
  if (!connection || factory !== indexedDB) {
    factory = indexedDB
    connection = openDB<BufferSchema>(DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore('pings', { keyPath: 'seq', autoIncrement: true }).createIndex('owner', 'ownerId')
      },
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

/** Keeps a position; when the driver already has MAX_BUFFERED waiting, their oldest goes to make room. */
export async function bufferPing(ownerId: string, ping: PhonePing): Promise<void> {
  const tx = (await db()).transaction('pings', 'readwrite')
  const owner = tx.store.index('owner')
  if ((await owner.count(ownerId)) >= MAX_BUFFERED) {
    const oldest = await owner.openCursor(ownerId)
    if (oldest) await oldest.delete()
  }
  await tx.store.add({ ownerId, ping } as BufferedPing)
  await tx.done
}

/** The driver's oldest positions, up to `limit`: the next batch. */
export async function oldestPings(ownerId: string, limit: number): Promise<BufferedPing[]> {
  return (await db()).getAllFromIndex('pings', 'owner', ownerId, limit)
}

export async function countPings(ownerId: string): Promise<number> {
  return (await db()).countFromIndex('pings', 'owner', ownerId)
}

/** Sent, or refused for good. */
export async function removePings(seqs: readonly number[]): Promise<void> {
  const tx = (await db()).transaction('pings', 'readwrite')
  await Promise.all(seqs.map((seq) => tx.store.delete(seq)))
  await tx.done
}
