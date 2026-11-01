import { describe, expect, test } from 'vitest';
import { derivePeriods, type DowntimeFailure, type DowntimeRecord, type StatusChange } from './downtime';

const at = (iso: string) => new Date(`${iso}Z`);
const vehicle = { registeredAt: at('2026-01-01T00:00:00'), status: 'active' as const };

let seq = 0;
function change(from: StatusChange['from'], to: StatusChange['to'], when: string, recordId: string | null = null): StatusChange {
  seq += 1;
  return { id: `h${seq}`, from, to, changedAt: at(when), maintenanceRecordId: recordId };
}
const record = (id: string, type: string, status = 'completed', completedAt: string | null = null): DowntimeRecord => ({
  id,
  type,
  status,
  completedAt: completedAt ? at(completedAt) : null,
});
const failure = (id: string, recordId: string, when: string, unplanned = true, detectedBy = 'technician'): DowntimeFailure => ({
  id,
  recordId,
  occurredAt: at(when),
  unplanned,
  detectedBy,
});
const sources = (records: DowntimeRecord[] = [], failures: DowntimeFailure[] = []) => ({ records: new Map(records.map((r) => [r.id, r])), failures });

describe('derivePeriods (FMS-131)', () => {
  test('two days in the workshop for preventive work is one two-day period of planned service', () => {
    const into = change('active', 'maintenance', '2026-03-02T08:00:00', 'r1');
    const periods = derivePeriods(vehicle, [into, change('maintenance', 'active', '2026-03-04T08:00:00', 'r1')], sources([record('r1', 'preventive')]));
    expect(periods).toEqual([
      {
        openedBy: `status:${into.id}`,
        startedAt: at('2026-03-02T08:00:00'),
        endedAt: at('2026-03-04T08:00:00'),
        reason: 'planned_service',
        maintenanceRecordId: 'r1',
        failureEventId: null,
      },
    ]);
  });

  test('workshop then out of service is one period; still out of service, it is open', () => {
    const into = change('active', 'maintenance', '2026-03-02T08:00:00');
    const periods = derivePeriods(vehicle, [into, change('maintenance', 'inactive', '2026-03-03T08:00:00')], sources());
    expect(periods).toMatchObject([{ openedBy: `status:${into.id}`, endedAt: null, reason: 'other' }]);
  });

  test('a breakdown is downtime from when it happened until its repair is completed, merged with the workshop stay', () => {
    const into = change('active', 'maintenance', '2026-03-02T10:00:00', 'r1');
    const out = change('maintenance', 'active', '2026-03-02T18:00:00', 'r1');
    const periods = derivePeriods(
      vehicle,
      [into, out],
      sources([record('r1', 'corrective', 'completed', '2026-03-03T09:00:00')], [failure('f1', 'r1', '2026-03-02T07:00:00', true, 'breakdown')]),
    );
    expect(periods).toEqual([
      {
        openedBy: 'failure:f1',
        startedAt: at('2026-03-02T07:00:00'),
        endedAt: at('2026-03-03T09:00:00'),
        reason: 'breakdown',
        maintenanceRecordId: 'r1',
        failureEventId: 'f1',
      },
    ]);
  });

  test('an unplanned fault found in service is an unplanned repair; a corrective repair of a fault found at planned work is planned', () => {
    const a = change('active', 'maintenance', '2026-03-02T08:00:00', 'r1');
    const b = change('maintenance', 'active', '2026-03-02T12:00:00', 'r1');
    const c = change('active', 'maintenance', '2026-03-05T08:00:00', 'r2');
    const d = change('maintenance', 'active', '2026-03-05T12:00:00', 'r2');
    const periods = derivePeriods(
      vehicle,
      [a, b, c, d],
      sources([record('r1', 'corrective'), record('r2', 'corrective')], [failure('f1', 'r1', '2026-03-02T07:00:00', true, 'driver_report'), failure('f2', 'r2', '2026-03-05T07:00:00', false)]),
    );
    expect(periods.map((p) => [p.reason, p.failureEventId])).toEqual([
      ['unplanned_repair', 'f1'],
      ['planned_service', null],
    ]);
  });

  test('an open corrective repair that names no failure is an unplanned repair', () => {
    const into = change('active', 'maintenance', '2026-03-02T08:00:00', 'r1');
    expect(derivePeriods(vehicle, [into], sources([record('r1', 'corrective', 'in_progress')]))[0]).toMatchObject({ endedAt: null, reason: 'unplanned_repair' });
  });

  test('a breakdown whose repair is still open lasts until the vehicle is retired; a cancelled repair adds nothing', () => {
    const retire = change('active', 'retired', '2026-03-10T00:00:00');
    const periods = derivePeriods(
      vehicle,
      [retire],
      sources(
        [record('r1', 'corrective', 'open'), record('r2', 'corrective', 'cancelled')],
        [failure('f1', 'r1', '2026-03-08T00:00:00', true, 'breakdown'), failure('f2', 'r2', '2026-03-01T00:00:00', true, 'breakdown')],
      ),
    );
    expect(periods).toMatchObject([{ openedBy: 'failure:f1', startedAt: at('2026-03-08T00:00:00'), endedAt: at('2026-03-10T00:00:00') }]);
  });

  test('a vehicle registered out of service is down from its registration', () => {
    const back = change('inactive', 'active', '2026-01-03T00:00:00');
    expect(derivePeriods(vehicle, [back], sources())).toEqual([
      { openedBy: 'registered', startedAt: vehicle.registeredAt, endedAt: at('2026-01-03T00:00:00'), reason: 'other', maintenanceRecordId: null, failureEventId: null },
    ]);
    expect(derivePeriods({ ...vehicle, status: 'maintenance' }, [], sources())).toMatchObject([{ openedBy: 'registered', endedAt: null }]);
  });

  test('in and out of service at the same instant is no downtime', () => {
    expect(derivePeriods(vehicle, [change('active', 'inactive', '2026-03-02T08:00:00'), change('inactive', 'active', '2026-03-02T08:00:00')], sources())).toEqual([]);
  });
});
