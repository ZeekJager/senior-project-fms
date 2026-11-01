// Vehicle downtime (FMS-131, docs/downtime.md): each stretch a vehicle was out of service, and why. Derived from
// its status history and its breakdowns, so the projection and the rebuild compute the same periods.
import { AppError } from '../../../shared/errors/app-error';
import type { VehicleStatus } from './vehicle';

/** Enum values exactly as stored (fleet.downtime_reason). */
export const DOWNTIME_REASONS = ['planned_service', 'unplanned_repair', 'breakdown', 'accident', 'awaiting_parts', 'other'] as const;
export type DowntimeReason = (typeof DOWNTIME_REASONS)[number];

/** Downtime that counts as a failure for MTBF and MTTR. Waiting for parts and other downtime count against availability only. */
export const UNPLANNED_REASONS: readonly DowntimeReason[] = ['unplanned_repair', 'breakdown', 'accident'];
export const isUnplanned = (reason: DowntimeReason): boolean => UNPLANNED_REASONS.includes(reason);

/** A vehicle is down while in the workshop or out of service. Retired is not downtime: the vehicle has left the fleet. */
export const DOWN_STATUSES: readonly VehicleStatus[] = ['maintenance', 'inactive'];
const isDown = (status: VehicleStatus) => DOWN_STATUSES.includes(status);

/** Repair types that are planned work. A corrective repair is planned only when what it fixed was found at planned work. */
const PLANNED_TYPES = ['preventive', 'inspection', 'predictive'];

/** One row of fleet.vehicle_status_history. `id` and `maintenanceRecordId` are public ids. */
export interface StatusChange {
  id: string;
  from: VehicleStatus;
  to: VehicleStatus;
  changedAt: Date;
  maintenanceRecordId: string | null;
}

/** A maintenance record behind a period (public id), as the maintenance module reports it. */
export interface DowntimeRecord {
  id: string;
  type: string;
  status: string;
  completedAt: Date | null;
}

/** A failure on the vehicle (FMS-125, public ids), as the maintenance module reports it. */
export interface DowntimeFailure {
  id: string;
  recordId: string | null;
  occurredAt: Date;
  unplanned: boolean;
  detectedBy: string;
}

/** What the maintenance module knows about one vehicle's downtime: the records asked for and every failure. */
export interface DowntimeSources {
  records: ReadonlyMap<string, DowntimeRecord>;
  failures: readonly DowntimeFailure[];
}

/** A period as derived from the sources, before a staff member's reason. */
export interface DerivedPeriod {
  /** 'status:<status change id>', 'failure:<failure id>' or 'registered': the period's identity across rebuilds. */
  openedBy: string;
  startedAt: Date;
  endedAt: Date | null;
  reason: DowntimeReason;
  maintenanceRecordId: string | null;
  failureEventId: string | null;
}

interface Stretch {
  openedBy: string;
  rank: number;
  start: Date;
  end: Date | null;
  records: string[];
  failures: string[];
}

const after = (a: Date | null, b: Date | null): Date | null => (a === null || b === null ? null : a > b ? a : b);
const addUnique = (to: string[], ids: readonly string[]) => {
  for (const id of ids) if (!to.includes(id)) to.push(id);
};

/**
 * A vehicle's downtime periods, oldest first, from its status history (in order) and the maintenance module's
 * records and failures:
 * - down from each move into maintenance or out of service until it is back in service or retired; a vehicle
 *   registered out of service is down from its registration;
 * - down from a breakdown (an unplanned failure detected as one) until the repair it is recorded on is completed,
 *   or the vehicle is retired;
 * - overlapping or touching stretches are one period, known by the stretch that started it.
 * The reason comes from what the period's repairs and failures say: a breakdown; another unplanned failure, or a
 * corrective repair that names none, is an unplanned repair; preventive work, an inspection, or a corrective
 * repair of faults found at planned work is planned service; anything else (a status set by hand) is other.
 */
export function derivePeriods(
  vehicle: { registeredAt: Date; status: VehicleStatus },
  history: readonly StatusChange[],
  sources: DowntimeSources,
): DerivedPeriod[] {
  const stretches: Stretch[] = [];

  let open: Stretch | null = null;
  if (isDown(history[0]?.from ?? vehicle.status)) {
    open = { openedBy: 'registered', rank: 0, start: vehicle.registeredAt, end: null, records: [], failures: [] };
    stretches.push(open);
  }
  for (const change of history) {
    const record = change.maintenanceRecordId ? [change.maintenanceRecordId] : [];
    if (!isDown(change.from) && isDown(change.to)) {
      open = { openedBy: `status:${change.id}`, rank: 1, start: change.changedAt, end: null, records: record, failures: [] };
      stretches.push(open);
    } else if (open && isDown(change.from) && isDown(change.to)) {
      addUnique(open.records, record);
    } else if (open && isDown(change.from)) {
      open.end = change.changedAt;
      open = null;
    }
  }

  // Retirement ends everything: a breakdown whose repair was never completed stops counting there.
  const retiredAt = history.find((c) => c.to === 'retired')?.changedAt ?? null;
  for (const failure of sources.failures) {
    if (!failure.unplanned || failure.detectedBy !== 'breakdown' || !failure.recordId) continue;
    const record = sources.records.get(failure.recordId);
    if (!record || record.status === 'cancelled') continue;
    const start = failure.occurredAt > vehicle.registeredAt ? failure.occurredAt : vehicle.registeredAt;
    let end = record.status === 'completed' ? record.completedAt : null;
    if (retiredAt && (end === null || end > retiredAt)) end = retiredAt;
    stretches.push({ openedBy: `failure:${failure.id}`, rank: 2, start, end, records: [record.id], failures: [failure.id] });
  }

  const merged: Stretch[] = [];
  const ordered = stretches
    .filter((s) => s.end === null || s.end > s.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.rank - b.rank || a.openedBy.localeCompare(b.openedBy));
  for (const s of ordered) {
    const last = merged.at(-1);
    if (last && (last.end === null || s.start <= last.end)) {
      last.end = after(last.end, s.end);
      addUnique(last.records, s.records);
      addUnique(last.failures, s.failures);
    } else {
      merged.push({ ...s, records: [...s.records], failures: [...s.failures] });
    }
  }

  return merged.map((s) => {
    const { reason, failureEventId } = reasonOf(s, sources);
    return { openedBy: s.openedBy, startedAt: s.start, endedAt: s.end, reason, maintenanceRecordId: s.records[0] ?? null, failureEventId };
  });
}

/** Why a period happened, and the failure that says so. */
function reasonOf(s: Stretch, sources: DowntimeSources): { reason: DowntimeReason; failureEventId: string | null } {
  const failures = sources.failures
    .filter((f) => s.failures.includes(f.id) || (f.recordId !== null && s.records.includes(f.recordId)))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const breakdown = failures.find((f) => f.unplanned && f.detectedBy === 'breakdown');
  if (breakdown) return { reason: 'breakdown', failureEventId: breakdown.id };
  const unplanned = failures.find((f) => f.unplanned);
  if (unplanned) return { reason: 'unplanned_repair', failureEventId: unplanned.id };
  const records = s.records.map((id) => sources.records.get(id)).filter((r): r is DowntimeRecord => r !== undefined);
  if (records.some((r) => r.type === 'corrective' && !failures.some((f) => f.recordId === r.id))) return { reason: 'unplanned_repair', failureEventId: null };
  if (records.some((r) => r.type === 'corrective' || PLANNED_TYPES.includes(r.type))) return { reason: 'planned_service', failureEventId: null };
  return { reason: 'other', failureEventId: null };
}

/** What opened a period, as the API names it. */
export type DowntimeOpenedBy = 'status_change' | 'breakdown' | 'registration';
export const openedByKind = (openedBy: string): DowntimeOpenedBy =>
  openedBy.startsWith('failure:') ? 'breakdown' : openedBy.startsWith('status:') ? 'status_change' : 'registration';

/** A period as the API returns it (api-contract §6.4, `DowntimePeriod`). */
export interface DowntimePeriodView {
  id: string;
  vehicle_id: string;
  started_at: Date;
  /** null while the vehicle is still out of service. */
  ended_at: Date | null;
  /** To `ended_at`, or to now while it lasts; whole minutes. */
  duration_minutes: number;
  reason: DowntimeReason;
  /** Counted as a failure in MTBF and MTTR. */
  unplanned: boolean;
  /** What the repair or failure behind it says; `reason` differs when a staff member set one. */
  derived_reason: DowntimeReason;
  reason_note: string | null;
  reason_set_by: string | null;
  reason_set_at: Date | null;
  opened_by: DowntimeOpenedBy;
  maintenance_record_id: string | null;
  failure_event_id: string | null;
}

export const downtimeNotFound = () => new AppError(404, 'NOT_FOUND', 'Downtime period not found.');
