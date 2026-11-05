import { describe, expect, test } from 'vitest';
import type { Sample } from '../domain/health';
import type { HealthRepository, RequestMinute } from '../infrastructure/health.repository';
import { HealthSampler, RequestRecorder, type Probe } from './health-sampler';

const T0 = Date.parse('2026-11-04T08:00:00Z');

/** A repository whose writes fail while `down` is true, like a database that cannot be reached. */
function fakeRepo() {
  const written: { minute: Date; samples: Sample[] }[] = [];
  const requests: RequestMinute[] = [];
  const state = { down: false };
  const repo = {
    async insertSamples(_db: unknown, minute: Date, samples: Sample[]) {
      if (state.down) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      written.push({ minute, samples });
    },
    async addRequests(_db: unknown, minutes: RequestMinute[]) {
      if (state.down) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      requests.push(...minutes);
    },
  } as unknown as HealthRepository;
  return { repo, written, requests, state };
}

const probe = (component: string, check: Probe['check']): Probe => ({ component, label: component, check });

describe('HealthSampler', () => {
  test('ok, down with the error, disabled, and a check that hangs is down after the timeout', async () => {
    const { repo, written } = fakeRepo();
    const sampler = new HealthSampler({
      db: {} as never,
      repo,
      requests: new RequestRecorder(),
      timeoutMs: 50,
      probes: async () => [
        probe('database', async () => {}),
        probe('redis', async () => {
          throw new Error('Connection is closed.');
        }),
        probe('replica', async () => ({ disabled: true })),
        probe('ai_service', () => new Promise(() => {})),
        probe('provider:fuel', async () => ({ latencyMs: 120 })),
      ],
    });
    const samples = await sampler.sample(new Date(T0 + 1_500));
    await sampler.flush();
    expect(samples.map((s) => [s.component, s.status, s.error])).toEqual([
      ['database', 'ok', null],
      ['redis', 'down', 'Connection is closed.'],
      ['replica', 'disabled', null],
      ['ai_service', 'down', 'timed out after 50 ms'],
      ['provider:fuel', 'ok', null],
    ]);
    expect(samples.find((s) => s.component === 'provider:fuel')!.latencyMs).toBe(120);
    expect(written).toEqual([{ minute: new Date(T0), samples }]);
  });

  test('while the database cannot be written, samples and request counts wait, and are written once it can', async () => {
    const { repo, written, requests, state } = fakeRepo();
    const recorder = new RequestRecorder();
    const sampler = new HealthSampler({
      db: {} as never,
      repo,
      requests: recorder,
      probes: async () => [
        probe('database', async () => {
          if (state.down) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
        }),
      ],
    });
    state.down = true;
    for (const m of [0, 1, 2]) {
      recorder.record(200, 30, T0 + m * 60_000);
      await sampler.sample(new Date(T0 + m * 60_000));
      await sampler.flush();
    }
    expect(written).toEqual([]);
    state.down = false;
    recorder.record(500, 30, T0 + 2 * 60_000);
    await sampler.sample(new Date(T0 + 3 * 60_000));
    await sampler.flush();
    // The three minutes the database was down are recorded as such, in order.
    expect(written.map((w) => [w.minute.getTime() - T0, w.samples[0].status])).toEqual([
      [0, 'down'],
      [60_000, 'down'],
      [120_000, 'down'],
      [180_000, 'ok'],
    ]);
    expect(requests.map((r) => [r.minute.getTime() - T0, r.requests, r.errors5xx])).toEqual([
      [0, 1, 0],
      [60_000, 1, 0],
      [120_000, 2, 1],
    ]);
  });
});
