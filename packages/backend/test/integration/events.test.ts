import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { redis } from '../../src/shared/cache';
import { RedisEventBroadcaster, type EventBroadcaster } from '../../src/shared/events/broadcaster';
import { createEvent, deterministicEventId, envelopeOf, type DomainEvent } from '../../src/shared/events/domain-event';
import { eventBus, eventChannel } from '../../src/shared/events/event-bus';
import { appendToOutbox, outboxStore } from '../../src/shared/events/outbox';
import { outboxCleanupJob } from '../../src/shared/events/outbox-cleanup';
import { OutboxRelay, RELAY_LOCK_KEY, type OutboxRelayOptions } from '../../src/shared/events/outbox-relay';
import { SubscriberRegistry } from '../../src/shared/events/subscribers';
import { withTransaction } from '../../src/shared/infrastructure/transaction';
import { publishedEvents } from '../support/events';

// FMS-73: the outbox, the relay and idempotent consumers. Each test builds
// its own consumers (a fresh SubscriberRegistry) so the app's own are not
// involved; the events it publishes live in the test's transaction.

const ctx = () => ({ actor: null, correlationId: randomUUID() });
const event = (type: string, aggregate: string | null, payload: Record<string, unknown> = {}) => createEvent(type, payload, ctx(), { aggregate });
const publish = (...events: DomainEvent[]) => withTransaction(pool, (tx) => eventBus.publish(tx, events));
const relayFor = (subscribers: SubscriberRegistry, options: Partial<OutboxRelayOptions> = {}) =>
  new OutboxRelay({ db: pool, subscribers, broadcaster: null, ...options });

async function outboxRows() {
  const res = await pool.query<{ event_id: string; dispatched: boolean; published: boolean; attempts: number; dead: boolean; last_error: string | null }>(
    `SELECT event_id, dispatched_at IS NOT NULL AS dispatched, published_at IS NOT NULL AS published, attempts,
            dead_lettered_at IS NOT NULL AS dead, last_error
       FROM events.outbox ORDER BY id`,
  );
  return res.rows;
}

/** Makes every waiting retry due now, instead of waiting out the backoff. */
const retryNow = () => pool.query(`UPDATE events.outbox SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE next_attempt_at IS NOT NULL`);

describe('publishing into the outbox', () => {
  test('a rolled-back change publishes nothing; a committed one writes the envelope and its aggregate', async () => {
    await expect(
      withTransaction(pool, async (tx) => {
        await eventBus.publish(tx, [event('VehicleRetired', 'vehicle:a')]);
        throw new Error('the change is refused after the publish');
      }),
    ).rejects.toThrow('refused');
    expect(await publishedEvents()).toEqual([]);

    const committed = event('VehicleRetired', 'vehicle:a', { vehicle_id: 'a' });
    await publish(committed);
    expect(await publishedEvents()).toEqual([committed]);
  });

  test('a fact published twice under a deterministic id is one row', async () => {
    const id = deterministicEventId('DocumentExpiring:doc-1:2026-12-01:red');
    await publish(createEvent('DocumentExpiring', { level: 'red' }, ctx(), { id }));
    await publish(createEvent('DocumentExpiring', { level: 'red' }, ctx(), { id }));
    expect((await publishedEvents()).map((e) => e.id)).toEqual([id]);
  });
});

describe('the relay delivers to consumers', () => {
  test('each consumer handles an event once; a redelivered event is skipped', async () => {
    const handled: string[] = [];
    const consumers = new SubscriberRegistry();
    consumers.subscribe('VehicleRetired', 'test.first', (e) => void handled.push(`first:${e.payload.n}`));
    consumers.subscribe('VehicleRetired', 'test.second', async (e, tx) => {
      await tx.query('SELECT 1');
      handled.push(`second:${e.payload.n}`);
    });
    const e = event('VehicleRetired', 'vehicle:a', { n: 1 });
    await publish(e);

    expect(await relayFor(consumers).runOnce()).toMatchObject({ dispatched: 1, retrying: 0 });
    expect(handled).toEqual(['first:1', 'second:1']);
    expect(await outboxRows()).toEqual([expect.objectContaining({ dispatched: true, published: true })]);

    // The relay died after the consumers committed, before it marked the row:
    // the next relay delivers it again, and both consumers skip it.
    await pool.query('UPDATE events.outbox SET dispatched_at = NULL, published_at = NULL');
    expect(await relayFor(consumers).runOnce()).toMatchObject({ dispatched: 1 });
    expect(handled).toEqual(['first:1', 'second:1']);
    const processed = await pool.query('SELECT consumer FROM events.processed_events WHERE event_id = $1 ORDER BY consumer', [e.id]);
    expect(processed.rows.map((r) => r.consumer)).toEqual(['test.first', 'test.second']);
  });

  test('a failing consumer rolls back its own work and is retried; the consumers that succeeded are not run again', async () => {
    let steady = 0;
    let fail = true;
    const consumers = new SubscriberRegistry();
    consumers.subscribe('PartAdjusted', 'test.steady', () => void steady++);
    consumers.subscribe('PartAdjusted', 'test.flaky', async (e, tx) => {
      // Work on the consumer's transaction: it must not survive the failure.
      await tx.query(`INSERT INTO events.processed_events (consumer, event_id) VALUES ('test.flaky-work', $1)`, [e.id]);
      if (fail) throw new Error('downstream unavailable');
    });
    const e = event('PartAdjusted', 'part:p');
    await publish(e);

    const relay = relayFor(consumers);
    expect(await relay.runOnce()).toMatchObject({ dispatched: 0, retrying: 1 });
    expect(await outboxRows()).toEqual([expect.objectContaining({ dispatched: false, attempts: 1, last_error: expect.stringContaining('test.flaky: downstream unavailable') })]);
    const work = () => pool.query(`SELECT 1 FROM events.processed_events WHERE consumer = 'test.flaky-work' AND event_id = $1`, [e.id]);
    expect((await work()).rowCount).toBe(0);

    // Not due yet: the backoff holds it.
    expect(await relay.runOnce()).toMatchObject({ dispatched: 0, retrying: 0 });

    fail = false;
    await retryNow();
    expect(await relay.runOnce()).toMatchObject({ dispatched: 1 });
    expect(steady).toBe(1);
    expect((await work()).rowCount).toBe(1);
  });

  test("one aggregate's events stay in order: a failure holds back its own aggregate only", async () => {
    const handled: string[] = [];
    let failX1 = true;
    const consumers = new SubscriberRegistry();
    consumers.subscribe('VehicleUpdated', 'test.order', (e) => {
      if (e.aggregate === 'vehicle:x' && e.payload.n === 1 && failX1) throw new Error('not yet');
      handled.push(`${e.aggregate}#${e.payload.n}`);
    });
    await publish(event('VehicleUpdated', 'vehicle:x', { n: 1 }));
    await publish(event('VehicleUpdated', 'vehicle:y', { n: 1 }));
    await publish(event('VehicleUpdated', 'vehicle:x', { n: 2 }));
    await publish(event('VehicleUpdated', 'vehicle:y', { n: 2 }));

    const relay = relayFor(consumers);
    expect(await relay.runOnce()).toMatchObject({ dispatched: 2, retrying: 1 });
    expect(handled).toEqual(['vehicle:y#1', 'vehicle:y#2']);

    // x#2 waits behind x#1 for as long as x#1 waits for its retry.
    expect(await relay.runOnce()).toMatchObject({ dispatched: 0 });

    failX1 = false;
    await retryNow();
    expect(await relay.runOnce()).toMatchObject({ dispatched: 2 });
    expect(handled).toEqual(['vehicle:y#1', 'vehicle:y#2', 'vehicle:x#1', 'vehicle:x#2']);
  });

  test('after the last attempt an event is dead-lettered, its aggregate moves on, and /health/ready says so', async () => {
    const handled: number[] = [];
    const consumers = new SubscriberRegistry();
    consumers.subscribe('VehicleUpdated', 'test.broken', (e) => {
      if (e.payload.n === 1) throw new Error('bug in consumer');
      handled.push(Number(e.payload.n));
    });
    await publish(event('VehicleUpdated', 'vehicle:x', { n: 1 }));
    await publish(event('VehicleUpdated', 'vehicle:x', { n: 2 }));

    const relay = relayFor(consumers, { maxAttempts: 2, retryDelaySeconds: () => 0 });
    expect(await relay.runOnce()).toMatchObject({ retrying: 1, dispatched: 0 });
    expect(await relay.runOnce()).toMatchObject({ deadLettered: 1, dispatched: 1 });
    expect(handled).toEqual([2]);
    expect((await outboxRows()).map((r) => [r.dead, r.dispatched])).toEqual([
      [true, false],
      [false, true],
    ]);

    const lag = await outboxStore.lag(pool);
    expect(lag).toMatchObject({ dead_lettered: 1, undispatched: 0 });
    const health = await request(createApp()).get('/health/ready');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'degraded', checks: { outbox: 'degraded' }, metrics: { outbox: { dead_lettered: 1 } } });
  });

  test('a relay that stops resumes at the first row it had not finished, in order, handling none twice', async () => {
    const handled: number[] = [];
    const consumers = new SubscriberRegistry();
    consumers.subscribe('AttendanceRecorded', 'test.resume', (e) => void handled.push(Number(e.payload.n)));
    for (let n = 1; n <= 5; n++) await publish(event('AttendanceRecorded', null, { n }));

    expect(await relayFor(consumers, { batchSize: 2 }).runOnce()).toMatchObject({ dispatched: 2, more: true });
    // A new relay (a restarted instance) picks up from row 3.
    const next = relayFor(consumers, { batchSize: 2 });
    expect(await next.runOnce()).toMatchObject({ dispatched: 2, more: true });
    expect(await next.runOnce()).toMatchObject({ dispatched: 1, more: false });
    expect(handled).toEqual([1, 2, 3, 4, 5]);
  });

  test('one relay at a time: while another instance holds the relay lock, a pass does nothing', async () => {
    const other = new Pool(config.db);
    const holder = await other.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [RELAY_LOCK_KEY]);
      await publish(event('VehicleRetired', null));
      expect(await relayFor(new SubscriberRegistry()).runOnce()).toBeNull();
      await holder.query('SELECT pg_advisory_unlock($1)', [RELAY_LOCK_KEY]);
      expect(await relayFor(new SubscriberRegistry()).runOnce()).toMatchObject({ dispatched: 1 });
    } finally {
      holder.release();
      await other.end();
    }
  });
});

describe('retention', () => {
  test('the daily clean-up deletes week-old delivered events and their records; dead letters and recent events stay', async () => {
    const consumers = new SubscriberRegistry();
    consumers.subscribe('VehicleUpdated', 'test.keep', (e) => {
      if (e.payload.dead) throw new Error('always fails');
    });
    consumers.subscribe('VehicleUpdated', 'test.other', () => {});
    const old = event('VehicleUpdated', 'vehicle:old', {});
    const dead = event('VehicleUpdated', 'vehicle:dead', { dead: true });
    const recent = event('VehicleUpdated', 'vehicle:recent', {});
    await publish(old, dead, recent);
    await relayFor(consumers, { maxAttempts: 1 }).runOnce();
    // Delivered or given up on just now: a week on, `old` and `dead` are past retention. `recent` is written later.
    await pool.query(`UPDATE events.outbox SET created_at = created_at + interval '2 days' WHERE event_id = $1`, [recent.id]);
    const weekOn = new Date(Date.now() + 8 * 86_400_000);
    const ran = await outboxCleanupJob(pool).run({ now: weekOn, correlationId: randomUUID(), runKey: 'test' });
    expect(ran).toEqual({ events_deleted: 1, processed_deleted: 2 });
    expect((await publishedEvents()).map((e) => e.id)).toEqual([dead.id, recent.id]);
    // The dead letter keeps the record of the consumer that handled it: requeued, only test.keep runs again.
    const records = await pool.query('SELECT event_id, consumer FROM events.processed_events ORDER BY event_id, consumer');
    expect(records.rows).toEqual(
      expect.arrayContaining([
        { event_id: dead.id, consumer: 'test.other' },
        { event_id: recent.id, consumer: 'test.keep' },
      ]),
    );
    expect(records.rows.some((r) => r.event_id === old.id)).toBe(false);
  });
});

describe('broadcasting to Redis', () => {
  /** A broadcaster whose Redis can be switched off. */
  function switchable() {
    const sent: string[] = [];
    let up = false;
    const broadcaster: EventBroadcaster = {
      async publish(e) {
        if (!up) throw new Error('redis is not connected');
        sent.push(String(e.payload.n));
      },
    };
    return { broadcaster, sent, setUp: (value: boolean) => (up = value) };
  }

  test('a Redis outage does not hold up consumers; broadcasting resumes at the same row, in outbox order', async () => {
    const handled: number[] = [];
    const consumers = new SubscriberRegistry();
    consumers.subscribe('VehicleUpdated', 'test.during-outage', (e) => void handled.push(Number(e.payload.n)));
    const redisStub = switchable();
    for (let n = 1; n <= 3; n++) await publish(event('VehicleUpdated', `vehicle:${n}`, { n }));

    const relay = relayFor(consumers, { broadcaster: redisStub.broadcaster });
    expect(await relay.runOnce()).toMatchObject({ dispatched: 3, published: 0 });
    expect(handled).toEqual([1, 2, 3]);
    expect((await outboxRows()).map((r) => r.published)).toEqual([false, false, false]);
    expect((await outboxStore.lag(pool)).unpublished).toBe(3);

    redisStub.setUp(true);
    expect(await relay.runOnce()).toMatchObject({ published: 3, dispatched: 0 });
    expect(redisStub.sent).toEqual(['1', '2', '3']);
    expect(handled).toEqual([1, 2, 3]);
  });

  // Against a real Redis and data committed by another connection (CI runs
  // it; locally, set REDIS_HOST): the relay loop, as src/server.ts runs it.
  test.skipIf(!config.redis)('a committed change reaches Redis within a second; a rolled-back one never does', async () => {
    const instance = new Pool(config.db);
    const listener = redis!.duplicate();
    const relay = new OutboxRelay({ db: instance, subscribers: new SubscriberRegistry(), broadcaster: new RedisEventBroadcaster(redis!, eventChannel) });
    const received: { at: number; message: Record<string, unknown> }[] = [];
    const committed = createEvent('TestEventCommitted', { n: 1 }, ctx());
    const rolledBack = createEvent('TestEventCommitted', { n: 2 }, ctx());
    try {
      if (listener.status !== 'ready') await new Promise((resolve) => listener.once('ready', resolve));
      listener.on('message', (_channel: string, raw: string) => received.push({ at: Date.now(), message: JSON.parse(raw) }));
      await listener.subscribe(eventChannel('TestEventCommitted'));
      relay.start();

      const tx = await instance.connect();
      try {
        await tx.query('BEGIN');
        await appendToOutbox(tx, [rolledBack]);
        await tx.query('ROLLBACK');
      } finally {
        tx.release();
      }
      await withTransaction(instance, (client) => appendToOutbox(client, [committed]));
      const committedAt = Date.now();

      const deadline = committedAt + 1000;
      while (!received.some((r) => r.message.id === committed.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      const arrival = received.find((r) => r.message.id === committed.id);
      expect(arrival, 'the committed event on Redis within 1 s').toBeDefined();
      expect(arrival!.at - committedAt).toBeLessThan(1000);
      expect(arrival!.message).toEqual(envelopeOf(committed));

      await new Promise((r) => setTimeout(r, 400));
      expect(received.map((r) => r.message.id)).toEqual([committed.id]);
    } finally {
      await relay.stop();
      await instance.query('DELETE FROM events.outbox WHERE event_id = ANY($1::uuid[])', [[committed.id, rolledBack.id]]);
      await listener.quit().catch(() => listener.disconnect());
      await instance.end();
    }
  });
});
