import { describe, expect, it } from 'vitest'
import {
  backoffMs,
  enqueue,
  flushQueue,
  MAX_PENDING,
  outcomeOf,
  QueueFullError,
  requestFor,
  submissionsOf,
  updateSubmission,
  type Outcome,
  type Submission,
} from '.'

const DRIVER = 'driver-1'

const inspection = (n: number, ownerId = DRIVER) => ({
  ownerId,
  kind: 'dvir',
  label: `Inspection ${n}`,
  path: '/dvir-reports',
  body: { n },
})

/**
 * A server that behaves like the idempotency middleware (FMS-87): the first
 * request with a key is recorded, a repeat with the same key is answered
 * from the record and adds nothing.
 */
function fakeServer() {
  const records: unknown[] = []
  const byKey = new Map<string, number>()
  const sent: { key: string; body: unknown }[] = []
  return {
    records,
    sent,
    receive(s: Submission) {
      sent.push({ key: s.key, body: s.body })
      if (!byKey.has(s.key)) byKey.set(s.key, records.push(s.body))
    },
  }
}

describe('offline queue: store (FMS-81)', () => {
  it('keeps submissions in the order they were made, each with its own Idempotency-Key, per driver', async () => {
    const a = await enqueue(inspection(1))
    const b = await enqueue(inspection(2))
    await enqueue(inspection(3, 'driver-2'))
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(a.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.key).not.toBe(b.key)
    const mine = await submissionsOf(DRIVER)
    expect(mine.map((s) => s.label)).toEqual(['Inspection 1', 'Inspection 2'])
    expect(mine.every((s) => s.state === 'pending' && s.attempts === 0)).toBe(true)
  })

  it(`refuses the ${MAX_PENDING + 1}st pending submission with a clear message; other drivers and refused ones do not count`, async () => {
    for (let n = 1; n <= MAX_PENDING; n++) await enqueue(inspection(n))
    const refused = await enqueue(inspection(51)).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(QueueFullError)
    expect((refused as Error).message).toBe('50 submissions are already waiting to send. Get signal to send them before adding another.')
    expect(await submissionsOf(DRIVER)).toHaveLength(MAX_PENDING)

    await expect(enqueue(inspection(1, 'driver-2'))).resolves.toBeTruthy()
    const [first] = await submissionsOf(DRIVER)
    await updateSubmission(first.seq, (s) => ({ ...s, state: 'rejected' }))
    await expect(enqueue(inspection(51))).resolves.toBeTruthy()
  })

  it('keeps no token or cookie: only the request and who made it', async () => {
    const queued = await enqueue(inspection(1))
    expect(Object.keys(queued).sort()).toEqual(['attempts', 'body', 'key', 'kind', 'label', 'ownerId', 'path', 'queuedAt', 'seq', 'state'])
  })
})

describe('offline queue: flush (FMS-81)', () => {
  it('sends in order, one at a time, and removes each only once the server has it', async () => {
    for (let n = 1; n <= 5; n++) await enqueue(inspection(n))
    const server = fakeServer()
    let inFlight = 0
    const result = await flushQueue(DRIVER, async (s) => {
      expect(++inFlight).toBe(1)
      expect(await submissionsOf(DRIVER)).toContainEqual(expect.objectContaining({ seq: s.seq }))
      server.receive(s)
      inFlight--
      return { kind: 'delivered' }
    })
    expect(result).toBe('done')
    expect(server.records).toEqual([1, 2, 3, 4, 5].map((n) => ({ n })))
    expect(await submissionsOf(DRIVER)).toEqual([])
  })

  it('stops at the first one that cannot go yet, keeping it and the rest in order for next time', async () => {
    for (let n = 1; n <= 3; n++) await enqueue(inspection(n))
    const server = fakeServer()
    let up = false
    const send = async (s: Submission): Promise<Outcome> => {
      if (!up && (s.body as { n: number }).n === 2) throw new TypeError('Failed to fetch')
      server.receive(s)
      return { kind: 'delivered' }
    }
    expect(await flushQueue(DRIVER, send)).toBe('retry')
    const left = await submissionsOf(DRIVER)
    expect(left.map((s) => s.label)).toEqual(['Inspection 2', 'Inspection 3'])
    expect(left[0].attempts).toBe(1)

    up = true
    expect(await flushQueue(DRIVER, send)).toBe('done')
    expect(server.records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('replaying a submission does not record it twice: every attempt carries the same key', async () => {
    await enqueue(inspection(1))
    const server = fakeServer()
    // The server records it, then the connection drops before the answer arrives.
    let dropAnswer = true
    const send = async (s: Submission): Promise<Outcome> => {
      server.receive(s)
      if (dropAnswer) {
        dropAnswer = false
        throw new TypeError('Failed to fetch')
      }
      return { kind: 'delivered' }
    }
    expect(await flushQueue(DRIVER, send)).toBe('retry')
    expect(await flushQueue(DRIVER, send)).toBe('done')
    expect(server.sent).toHaveLength(2)
    expect(server.sent[0].key).toBe(server.sent[1].key)
    expect(server.records).toHaveLength(1)
  })

  it('a refused submission is kept, marked with why, and the ones after it still go', async () => {
    for (let n = 1; n <= 3; n++) await enqueue(inspection(n))
    const server = fakeServer()
    const result = await flushQueue(DRIVER, async (s) => {
      if ((s.body as { n: number }).n === 2) return outcomeOf(422, 'VALIDATION_FAILED', 'Each item once.')
      server.receive(s)
      return { kind: 'delivered' }
    })
    expect(result).toBe('done')
    expect(server.records).toEqual([{ n: 1 }, { n: 3 }])
    const [refused] = await submissionsOf(DRIVER)
    expect(refused).toMatchObject({ label: 'Inspection 2', state: 'rejected', rejection: { status: 422, code: 'VALIDATION_FAILED', message: 'Each item once.' } })
  })

  it('pauses on 401 with everything kept, and goes on from there after signing in', async () => {
    for (let n = 1; n <= 2; n++) await enqueue(inspection(n))
    const server = fakeServer()
    expect(await flushQueue(DRIVER, async () => ({ kind: 'signed-out' }))).toBe('signed-out')
    expect(await submissionsOf(DRIVER)).toHaveLength(2)
    expect(
      await flushQueue(DRIVER, async (s) => {
        server.receive(s)
        return { kind: 'delivered' }
      }),
    ).toBe('done')
    expect(server.records).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("never sends another driver's submissions", async () => {
    await enqueue(inspection(1, 'driver-2'))
    const sent: Submission[] = []
    expect(await flushQueue(DRIVER, async (s) => (sent.push(s), { kind: 'delivered' }))).toBe('done')
    expect(sent).toEqual([])
    expect(await submissionsOf('driver-2')).toHaveLength(1)
  })

  it('one sender at a time: a second flush while one runs reports busy and sends nothing', async () => {
    await enqueue(inspection(1))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sent: number[] = []
    const first = flushQueue(DRIVER, async (s) => {
      sent.push(s.seq)
      await gate
      return { kind: 'delivered' }
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await flushQueue(DRIVER, async (s) => (sent.push(s.seq), { kind: 'delivered' }))).toBe('busy')
    release()
    expect(await first).toBe('done')
    expect(sent).toHaveLength(1)
  })
})

describe('offline queue: rules', () => {
  it.each([
    [201, '', 'delivered'],
    [200, '', 'delivered'],
    [401, 'AUTH_TOKEN_EXPIRED', 'signed-out'],
    [503, '', 'retry'],
    [500, '', 'retry'],
    [429, 'RATE_LIMITED', 'retry'],
    [408, '', 'retry'],
    [409, 'CONFLICT_IDEMPOTENCY_IN_PROGRESS', 'retry'],
    [409, 'CONFLICT_IDEMPOTENCY_KEY_REUSED', 'rejected'],
    [422, 'VALIDATION_FAILED', 'rejected'],
    [403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'rejected'],
    [404, 'RESOURCE_NOT_FOUND', 'rejected'],
  ])('%i %s: %s', (status, code, kind) => {
    expect(outcomeOf(status, code, 'm').kind).toBe(kind)
  })

  it('backs off 2 s, 4 s, 8 s ... up to 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })

  it("the worker's request: POST under /api/v1 with the key, cookies and JSON body", async () => {
    const queued = await enqueue(inspection(7))
    const { url, init } = requestFor(queued, 'pwa')
    expect(url).toBe('/api/v1/dvir-reports')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"n":7}' })
    expect(init.headers).toMatchObject({ 'Idempotency-Key': queued.key, 'Content-Type': 'application/json', 'X-Client-Channel': 'pwa' })
  })
})
