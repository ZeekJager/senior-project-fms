import { depotScope, ownDriverScope, type Scope } from '../../../shared/authz/scope';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { anomalyClosed, anomalyNotFound, notesRequired, type AnomalyOutcome, type AnomalyStatus, type FuelAnomalyView } from '../domain/fuel-anomaly';
import type { FuelAnomalyRepository, FuelAnomalyRow } from '../infrastructure/fuel-anomaly.repository';
import type { Caller } from './fuel-log.service';

/** A vehicle as an anomaly names it (fleet's FuelVehicle). Internal ids. */
interface AnomalyVehicle {
  id: string;
  publicId: string;
  registrationNumber: string;
  depotPublicId: string;
  depotName: string;
}

export interface FuelAnomalyServiceDeps {
  /** Anomalies are read on the primary: the screen shows a resolution the moment it is saved (CONVENTIONS, Read replica). */
  db: Queryable;
  anomalies: Pick<FuelAnomalyRepository, 'inTransaction' | 'list' | 'find' | 'close'>;
  /** A scope's vehicles (fleet), and user accounts by internal id (auth): who closed an anomaly. */
  vehicles: { forReconciliation(db: Queryable, scope: Scope): Promise<AnomalyVehicle[]> };
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]> };
}

export interface FuelAnomalyQuery {
  vehicle_id?: string;
  status?: AnomalyStatus[];
  anomaly_type?: string;
  page: number;
  page_size: number;
}

/**
 * Fuel anomalies (api-contract §9.1, FMS-42): the findings of the reconciliation (FMS-41) and, later, of the per-fill-up
 * rules (FMS-82), for the caller's depots' vehicles; and closing one, which records who closed it, when and why.
 * A driver sees none: they hold neither permission.
 */
export class FuelAnomalyService {
  constructor(private readonly deps: FuelAnomalyServiceDeps) {}

  async list(caller: Caller, query: FuelAnomalyQuery): Promise<{ items: FuelAnomalyView[]; total: number }> {
    const { db, anomalies } = this.deps;
    const vehicles = await this.visibleVehicles(db, caller);
    const byPublicId = query.vehicle_id ? [...vehicles.values()].find((v) => v.publicId === query.vehicle_id) : undefined;
    if (query.vehicle_id && !byPublicId) return { items: [], total: 0 };
    const { rows, total } = await anomalies.list(db, {
      vehicleIds: [...vehicles.keys()],
      vehicleId: byPublicId?.id,
      statuses: query.status,
      anomalyType: query.anomaly_type,
      page: query.page,
      page_size: query.page_size,
    });
    return { items: await this.views(db, rows, vehicles), total };
  }

  async get(caller: Caller, publicId: string): Promise<FuelAnomalyView> {
    const { db, anomalies } = this.deps;
    const vehicles = await this.visibleVehicles(db, caller);
    const row = await anomalies.find(db, publicId, [...vehicles.keys()]);
    if (!row) throw anomalyNotFound();
    return (await this.views(db, [row], vehicles))[0];
  }

  /**
   * POST /fuel-anomalies/{id}/resolve: closes an open or reviewed anomaly as `resolved` (it was real and dealt with)
   * or `dismissed` (not a problem; a note saying why is required), recording who and when. One already closed is
   * `409`; the row is locked, so two people closing it at once cannot both succeed.
   */
  async close(caller: Caller, publicId: string, input: { outcome: AnomalyOutcome; notes?: string }): Promise<FuelAnomalyView> {
    const { anomalies } = this.deps;
    if (input.outcome === 'dismissed' && !input.notes) throw notesRequired();
    return anomalies.inTransaction(async (client) => {
      const vehicles = await this.visibleVehicles(client, caller);
      const row = await anomalies.find(client, publicId, [...vehicles.keys()], true);
      if (!row) throw anomalyNotFound();
      if (row.status === 'resolved' || row.status === 'dismissed') throw anomalyClosed(row.status);
      await anomalies.close({ userId: caller.user.id, correlationId: caller.correlationId }, row.id, input.outcome, input.notes ?? null, new Date(), client);
      const closed = await anomalies.find(client, publicId, null);
      return (await this.views(client, [closed!], vehicles))[0];
    });
  }

  /** The caller's depots' vehicles by internal id; none for a driver or a user placed nowhere. */
  private async visibleVehicles(db: Queryable, caller: Caller): Promise<Map<string, AnomalyVehicle>> {
    if (ownDriverScope(caller.user).kind !== 'all') return new Map();
    const scope = depotScope(caller.user);
    if (scope.kind === 'none') return new Map();
    return new Map((await this.deps.vehicles.forReconciliation(db, scope)).map((v) => [v.id, v]));
  }

  private async views(db: Queryable, rows: FuelAnomalyRow[], vehicles: Map<string, AnomalyVehicle>): Promise<FuelAnomalyView[]> {
    const reviewerIds = [...new Set(rows.flatMap((r) => (r.reviewedBy ? [r.reviewedBy] : [])))];
    const reviewers = new Map((reviewerIds.length ? await this.deps.users.findByIds(db, reviewerIds) : []).map((u) => [u.id, u]));
    return rows.map((r) => {
      const vehicle = vehicles.get(r.vehicleId)!;
      const reviewer = r.reviewedBy ? reviewers.get(r.reviewedBy) : undefined;
      return {
        id: r.publicId,
        vehicle_id: vehicle.publicId,
        registration_number: vehicle.registrationNumber,
        depot_id: vehicle.depotPublicId,
        depot_name: vehicle.depotName,
        fuel_log_id: r.fuelLogPublicId,
        anomaly_type: r.anomalyType,
        severity: r.severity,
        status: r.status,
        period_from: r.periodStart,
        period_to: r.periodEnd,
        distance_km: r.distanceKm,
        expected_ml: r.expectedMl,
        actual_ml: r.actualMl,
        deviation_pct: r.deviationPct === null ? null : Math.round(r.deviationPct),
        detected_at: r.detectedAt,
        reviewed_by: reviewer?.publicId ?? null,
        reviewed_by_name: reviewer?.fullName ?? null,
        reviewed_at: r.reviewedAt,
        notes: r.notes,
      };
    });
  }
}
