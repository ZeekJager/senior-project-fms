/**
 * Scenario 1 (FMS-61): vehicles reporting positions while dashboards watch the live map.
 *
 * Each vehicle posts a ping every interval through its own device token (POST /tracking/gps-pings, the production path
 * for trackers, docs/gps-ingestion.md), spread over the interval as real devices are. Each observer is a signed-in
 * fleet manager holding a Socket.IO connection, as the Fleet Command Center does. Every ping accepted becomes the
 * vehicle's position and is announced (`vehicle.location.updated`): an observer that does not receive one has had an
 * event dropped. Delivery latency runs from sending the ping to an observer receiving it, both on this process's clock.
 */
import { io, type Socket } from 'socket.io-client';
import { loopAround, step, type VehicleState } from '../../simulator/motion';
import type { Device } from '../fixtures';
import type { GpsWorkload } from '../profiles';
import type { Session } from '../session';
import { Recorder, summarize, type Summary } from '../stats';

export interface GpsResult {
  workload: GpsWorkload;
  seconds: number;
  requests: ReturnType<Recorder['table']>;
  errors: Record<string, Record<string, number>>;
  errorCount: number;
  events: { announced: number; expected: number; received: number; dropped: number; observerDisconnects: number; unmatched: number; sample: unknown };
  deliveryMs: Summary;
}

const SOCKET_PATH = '/api/v1/socket.io';
const key = (vehicleId: string, recordedAt: string) => `${vehicleId}|${Date.parse(recordedAt)}`;

interface Observer {
  socket: Socket;
  received: Map<string, number>;
  disconnects: number;
  /** Every position event, matched or not: one that matches no ping sent here points at a mismatch, not a drop. */
  all: number;
  last: unknown;
}

function observe(origin: string, session: Session): Promise<Observer> {
  return new Promise((resolve, reject) => {
    const socket = io(origin, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      extraHeaders: { cookie: session.cookieHeader() },
      reconnection: false,
    });
    const observer: Observer = { socket, received: new Map(), disconnects: 0, all: 0, last: null };
    socket.on('vehicle.location.updated', (e: { vehicle_id: string; recorded_at: string }) => {
      observer.all++;
      observer.last = e;
      observer.received.set(key(e.vehicle_id, e.recorded_at), performance.now());
    });
    const timer = setTimeout(() => reject(new Error('An observer socket did not connect within 15 s.')), 15_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.on('disconnect', () => observer.disconnects++);
      resolve(observer);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`An observer socket was refused: ${err.message}`));
    });
  });
}

export async function runGps(origin: string, api: string, devices: Device[], observers: Session[], w: GpsWorkload): Promise<GpsResult> {
  const watching = await Promise.all(observers.map((s) => observe(origin, s)));
  const recorder = new Recorder();
  /** Pings accepted: when each was sent, by vehicle and recorded time. */
  const sent = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  const states = new Map<string, VehicleState>(
    devices.map((d) => [d.vehicleId, { path: loopAround(d.centre), at: Math.random(), direction: 1, scenario: 'normal' as const }]),
  );

  const send = (device: Device) => {
    const { state, ping } = step(states.get(device.vehicleId)!, w.intervalS, Math.random);
    states.set(device.vehicleId, state);
    const recordedAt = new Date().toISOString();
    const body = JSON.stringify({ pings: [{ ...ping, recorded_at: recordedAt, accuracy_m: 5, ignition_on: true }] });
    const t0 = performance.now();
    const work = fetch(`${api}/tracking/gps-pings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${device.token}` },
      body,
    })
      .then(async (res) => {
        const text = await res.text();
        const ms = performance.now() - t0;
        if (res.status !== 202) return recorder.record('POST /tracking/gps-pings', ms, false, String(res.status));
        const { data } = JSON.parse(text) as { data: { accepted: number; duplicates: number; rejected: { reason: string }[] } };
        if (data.accepted !== 1) return recorder.record('POST /tracking/gps-pings', ms, false, `rejected:${data.rejected[0]?.reason ?? 'duplicate'}`);
        recorder.record('POST /tracking/gps-pings', ms, true, '202');
        sent.set(key(device.vehicleId, recordedAt), t0);
      })
      .catch(() => recorder.record('POST /tracking/gps-pings', performance.now() - t0, false, 'network'))
      .finally(() => inFlight.delete(work));
    inFlight.add(work);
  };

  const started = performance.now();
  const timers: NodeJS.Timeout[] = [];
  devices.forEach((device, i) => {
    const offset = (i / devices.length) * w.intervalS * 1000;
    timers.push(
      setTimeout(() => {
        send(device);
        timers.push(setInterval(() => send(device), w.intervalS * 1000));
      }, offset),
    );
  });
  await new Promise((r) => setTimeout(r, w.durationS * 1000));
  for (const t of timers) clearTimeout(t);
  await Promise.all(inFlight);
  const seconds = (performance.now() - started) / 1000;

  // Events are hints a socket gets within a second or so; give the last ones up to 15 s to arrive.
  const drainUntil = Date.now() + 15_000;
  const missing = () => watching.reduce((n, o) => n + [...sent.keys()].filter((k) => !o.received.has(k)).length, 0);
  while (missing() > 0 && Date.now() < drainUntil) await new Promise((r) => setTimeout(r, 250));

  const delivery: number[] = [];
  let received = 0;
  for (const o of watching) {
    for (const [k, sentAt] of sent) {
      const at = o.received.get(k);
      if (at === undefined) continue;
      received++;
      delivery.push(at - sentAt);
    }
  }
  const expected = sent.size * watching.length;
  const disconnects = watching.reduce((n, o) => n + o.disconnects, 0);
  for (const o of watching) o.socket.disconnect();

  return {
    workload: w,
    seconds: Math.round(seconds),
    requests: recorder.table(seconds),
    errors: recorder.errors(),
    errorCount: recorder.errorCount(),
    events: {
      announced: sent.size,
      expected,
      received,
      dropped: expected - received,
      observerDisconnects: disconnects,
      unmatched: watching.reduce((n, o) => n + o.all, 0) - received,
      sample: watching[0]?.last ?? null,
    },
    deliveryMs: summarize(delivery),
  };
}
