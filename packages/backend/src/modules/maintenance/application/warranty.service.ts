import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { staleVersion } from '../../../shared/http/etag';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { Caller } from './maintenance.service';
import { maintenanceNotFound, maintenanceVehicleMissing } from '../domain/maintenance';
import type { FailureComponent } from '../domain/failure';
import {
  CLAIM_STATUSES,
  CLAIM_TRANSITIONS,
  WARRANTY_EVENTS,
  claimAmountNotApproved,
  claimAmountRequired,
  claimTransitionNotAllowed,
  coveringWarranty,
  daysFrom,
  notClaimable,
  claimOdometerRecorded,
  claimOdometerRequired,
  claimOverKmLimit,
  operatingDay,
  recallCodeTaken,
  recallCompletedFinal,
  recallCompletedInFuture,
  recallFleetWideOnly,
  recallMatches,
  recallNotFound,
  recallRecordNotFound,
  recallScheduleNeedsRecord,
  recallVehicleNotFound,
  recallYearsReversed,
  warrantyEndRequired,
  warrantyEndsBeforeStart,
  warrantyNotFound,
  warrantyStatus,
  warrantyVehicleNotFound,
  type ClaimStatus,
  type RecallVehicleStatus,
  type RecallVehicleView,
  type RecallView,
  type WarrantyClaimView,
  type WarrantyView,
} from '../domain/warranty';
import type {
  RecallRow,
  RecallVehicleRow,
  RecallVehicleWrite,
  RecallWrite,
  WarrantyRepository,
  WarrantyRow,
  WarrantyWrite,
} from '../infrastructure/warranty.repository';

/** A vehicle as recall matching sees it (fleet's `recallRefs`). Internal ids. */
interface RecallVehicle {
  id: string;
  publicId: string;
  depotId: string;
  make: string;
  model: string;
  modelYear: number | null;
}

export interface WarrantyServiceDeps {
  repo: Omit<WarrantyRepository, 'db' | 'transaction' | 'mutate'>;
  vehicles: {
    findInScope(db: Queryable, by: { publicId: string } | { id: string }, scope: Scope): Promise<{ id: string; publicId: string } | null>;
    refsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; registrationNumber: string }>>;
    idsInScope(db: Queryable, scope: Scope): Promise<string[] | null>;
    /** The vehicles in service of a make and model, or of ids, with their model year (fleet's `recallRefs`). */
    forRecall(db: Queryable, filter: { ids?: readonly string[] | null; make?: string; model?: string }): Promise<RecallVehicle[]>;
    /** Each vehicle's odometer now (in service only). */
    odometers(db: Queryable, ids: readonly string[]): Promise<Map<string, number>>;
  };
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string }[]> };
  events: EventBus;
  /** Within this many days of its end a warranty is expiring: the expiry_warning_days setting (FMS-80). */
  warningDays: () => Promise<number>;
  now?: () => Date;
}

export interface WarrantyInput {
  vehicle_id: string;
  component?: FailureComponent | null;
  provider: string;
  coverage?: string | null;
  starts_on: string;
  ends_on?: string | null;
  ends_km?: number | null;
  terms?: string | null;
}

export type WarrantyUpdate = Partial<Omit<WarrantyInput, 'vehicle_id'>> & { is_active?: boolean };

export interface WarrantyListQuery {
  page: number;
  page_size: number;
  vehicle_id?: string;
  include_void: boolean;
}

export interface ClaimInput {
  status: Exclude<ClaimStatus, 'claimable'>;
  amount_cents?: number | null;
  reference?: string | null;
  /** The odometer at the repair, when it has none and its warranty ends at a reading: recorded on the repair first. */
  odometer_km?: number;
}

export interface RecallInput {
  campaign_code: string;
  make: string;
  model: string;
  year_from: number;
  year_to: number;
  description: string;
  remedy?: string | null;
  issued_on?: string | null;
}

export type RecallUpdate = Partial<RecallInput>;

export interface RecallVehicleQuery {
  page: number;
  page_size: number;
  status?: readonly RecallVehicleStatus[];
}

export interface RecallVehicleUpdate {
  status?: RecallVehicleStatus;
  maintenance_record_id?: string | null;
  completed_at?: string;
  notes?: string | null;
}

/** A completion a few minutes "in the future" is clock skew between devices, not a mistake. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Warranties, warranty claims and manufacturer recalls (FMS-133, docs/warranties-recalls.md).
 *
 * - A repair that found a failure a warranty of its vehicle covered on its work day (and within its end
 *   odometer) is claimable. That is judged again whenever the repair, its failures or the vehicle's
 *   warranties change, on the writer's transaction, until the claim is submitted; from then on it is the
 *   clerk's (submitted, approved with the amount recovered, rejected).
 * - A recall lists every vehicle in service of its make, model and model years as open: when it is issued,
 *   when it is edited, and when a vehicle is registered or changed. Its work is scheduled by linking a work
 *   order, and completed with it (or by hand).
 */
export class WarrantyService {
  constructor(private readonly deps: WarrantyServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // Warranties

  async listWarranties(caller: Caller, query: WarrantyListQuery): Promise<{ items: WarrantyView[]; total: number }> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      let vehicleId: string | undefined;
      if (query.vehicle_id) {
        const vehicle = await vehicles.findInScope(client, { publicId: query.vehicle_id }, scope);
        if (!vehicle) return { items: [], total: 0 };
        vehicleId = vehicle.id;
      }
      const { rows, total } = await repo.listWarranties(client, {
        page: query.page,
        page_size: query.page_size,
        vehicleIds: vehicleId ? null : await vehicles.idsInScope(client, scope),
        vehicleId,
        includeVoid: query.include_void,
      });
      return { items: await this.warrantyViews(client, rows), total };
    });
  }

  async getWarranty(caller: Caller, warrantyId: string): Promise<WarrantyView> {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const row = await this.visibleWarranty(client, caller, warrantyId, false);
      return (await this.warrantyViews(client, [row]))[0];
    });
  }

  /** POST /warranties: the warranty, then the vehicle's repairs not yet claimed judged against it. */
  async createWarranty(caller: Caller, input: WarrantyInput): Promise<WarrantyView> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const vehicle = await vehicles.findInScope(client, { publicId: input.vehicle_id }, depotScope(caller.user));
      if (!vehicle) throw warrantyVehicleNotFound();
      const data: WarrantyWrite = {
        vehicle_id: vehicle.id,
        component: input.component ?? null,
        provider: input.provider,
        coverage: input.coverage ?? null,
        starts_on: input.starts_on,
        ends_on: input.ends_on ?? null,
        ends_km: input.ends_km ?? null,
        terms: input.terms ?? null,
        created_by: caller.user.id,
      };
      checkEnd(data.starts_on!, data.ends_on ?? null, data.ends_km ?? null);
      const inserted = await repo.insertWarranty(ctxOf(caller), data, client);
      await this.refreshClaims(client, ctxOf(caller), vehicle.id, null);
      return (await this.warrantyViews(client, [await repo.warrantyById(client, inserted.id as string)]))[0];
    });
  }

  /** PATCH /warranties/{id}: the fields sent; `is_active: false` voids it. Claims not yet sent are judged again. */
  async updateWarranty(caller: Caller, warrantyId: string, patch: WarrantyUpdate, expectedVersion: number | null): Promise<WarrantyView> {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const row = await this.visibleWarranty(client, caller, warrantyId, true);
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      const data: WarrantyWrite = {};
      for (const key of ['component', 'provider', 'coverage', 'starts_on', 'ends_on', 'ends_km', 'terms', 'is_active'] as const) {
        if (patch[key] !== undefined) (data as Record<string, unknown>)[key] = patch[key];
      }
      checkEnd(
        data.starts_on ?? row.startsOn,
        data.ends_on !== undefined ? data.ends_on : row.endsOn,
        data.ends_km !== undefined ? data.ends_km : row.endsKm,
      );
      if (Object.keys(data).length > 0) {
        await repo.updateWarranty(ctxOf(caller), row.id, data, client);
        await this.refreshClaims(client, ctxOf(caller), row.vehicleId, null);
      }
      return (await this.warrantyViews(client, [await repo.warrantyById(client, row.id)]))[0];
    });
  }

  /** For the expiry job (FMS-26, fleet): live warranties with an end date in the window. */
  async endingWithin(db: Queryable, today: string, window: number) {
    const rows = await this.deps.repo.endingWithin(db, today, window);
    return rows.map((w) => ({
      id: w.id,
      publicId: w.publicId,
      vehicleId: w.vehicleId,
      provider: w.provider,
      component: w.component,
      endsOn: w.endsOn!,
      daysLeft: w.daysLeft,
    }));
  }

  // Claims

  /**
   * Judges the vehicle's repairs whose claim is not yet sent (all, or `recordIds`): claimable under the
   * warranty that covered it, or not. On the writer's transaction; only a change is written (and audited).
   */
  async refreshClaims(client: PoolClient, ctx: MutationContext, vehicleId: string, recordIds: readonly string[] | null): Promise<void> {
    const { repo } = this.deps;
    const repairs = await repo.repairsToJudge(client, vehicleId, recordIds);
    if (repairs.length === 0) return;
    const warranties = await repo.warrantiesOf(client, vehicleId);
    for (const r of repairs) {
      const covering =
        r.status === 'cancelled'
          ? null
          : coveringWarranty(warranties, { workDay: operatingDay(r.workAt), odometerKm: r.odometerKm, components: r.components });
      const warrantyId = covering?.id ?? null;
      if (warrantyId === r.warrantyId) continue;
      await repo.setClaim(ctx, client, r.id, {
        warranty_id: warrantyId,
        claim_status: warrantyId ? 'claimable' : null,
      });
    }
  }

  /** The claims of repairs, for their views, by internal record id. */
  async claimViews(db: Queryable, recordIds: readonly string[]): Promise<Map<string, WarrantyClaimView>> {
    const rows = await this.deps.repo.claims(db, recordIds);
    const users = await this.deps.users.findByIds(db, [...new Set(rows.flatMap((r) => (r.updatedBy ? [r.updatedBy] : [])))]);
    const userIds = new Map(users.map((u) => [u.id, u.publicId]));
    return new Map(
      rows.map((r) => [
        r.recordId,
        {
          warranty_id: r.warrantyPublicId,
          provider: r.provider,
          component: r.component,
          status: r.status,
          amount_cents: r.amountCents,
          reference: r.reference,
          ends_km: r.endsKm,
          km_checked: r.endsKm === null || r.odometerKm !== null,
          updated_at: r.updatedAt,
          updated_by: r.updatedBy ? (userIds.get(r.updatedBy) ?? null) : null,
        },
      ]),
    );
  }

  /**
   * PATCH /maintenance-records/{id}/warranty-claim: claimable to submitted, submitted to approved (with the
   * amount recovered) or rejected, rejected to submitted again.
   */
  async updateClaim(caller: Caller, recordPublicId: string, input: ClaimInput): Promise<WarrantyClaimView> {
    const { repo, vehicles } = this.deps;
    const lock = async (client: PoolClient) => {
      const row = await repo.lockClaim(client, recordPublicId);
      if (!row || !(await vehicles.findInScope(client, { id: row.vehicleId }, depotScope(caller.user)))) throw maintenanceNotFound();
      return row;
    };
    // The reading the repair was missing is recorded, and the repair judged again, on its own transaction: it is
    // kept even when it shows the repair past the warranty's limit, so the repair stops showing as claimable.
    if (input.odometer_km !== undefined) {
      const odometerKm = input.odometer_km;
      await repo.inTransaction(async (client) => {
        const row = await lock(client);
        if (!row.warrantyId || !row.claimStatus) throw notClaimable();
        if (row.odometerKm !== null) throw claimOdometerRecorded();
        await repo.setRepairOdometer(ctxOf(caller), client, row.id, odometerKm);
        await this.refreshClaims(client, ctxOf(caller), row.vehicleId, [row.id]);
      });
    }
    return repo.inTransaction(async (client) => {
      const row = await lock(client);
      if (!row.warrantyId || !row.claimStatus) throw input.odometer_km !== undefined ? claimOverKmLimit() : notClaimable();
      if (!CLAIM_TRANSITIONS[row.claimStatus].includes(input.status)) throw claimTransitionNotAllowed(row.claimStatus);
      // A claim goes to the provider only once the distance is known to be within the warranty's limit.
      if (input.status === 'submitted' && row.endsKm !== null) {
        if (row.odometerKm === null) throw claimOdometerRequired(row.endsKm);
        if (row.odometerKm > row.endsKm) throw claimOverKmLimit();
      }
      if (input.status === 'approved' && (input.amount_cents === undefined || input.amount_cents === null)) throw claimAmountRequired();
      if (input.status !== 'approved' && input.amount_cents !== undefined && input.amount_cents !== null) throw claimAmountNotApproved();
      await repo.setClaim(ctxOf(caller), client, row.id, {
        claim_status: input.status,
        claim_amount_cents: input.status === 'approved' ? input.amount_cents! : null,
        ...(input.reference !== undefined ? { claim_reference: input.reference } : {}),
        claim_updated_at: this.now().toISOString(),
        claim_updated_by: caller.user.id,
      });
      return (await this.claimViews(client, [row.id])).get(row.id)!;
    });
  }

  // Recalls

  async listRecalls(caller: Caller, page: { page: number; page_size: number }): Promise<{ items: RecallView[]; total: number }> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const { rows, total } = await repo.listRecalls(client, page);
      return { items: await this.recallViews(client, rows, await vehicles.idsInScope(client, depotScope(caller.user))), total };
    });
  }

  async getRecall(caller: Caller, recallId: string): Promise<RecallView> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const row = await repo.findRecall(client, recallId);
      if (!row) throw recallNotFound();
      return (await this.recallViews(client, [row], await vehicles.idsInScope(client, depotScope(caller.user))))[0];
    });
  }

  /** POST /recalls: the campaign, and every vehicle in service it applies to listed as open. */
  async createRecall(caller: Caller, input: RecallInput): Promise<RecallView> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      if (scope.kind !== 'all') throw recallFleetWideOnly();
      if (input.year_to < input.year_from) throw recallYearsReversed();
      if (await repo.codeTaken(client, input.campaign_code, null)) throw recallCodeTaken();
      const data: RecallWrite = {
        campaign_code: input.campaign_code,
        make: input.make,
        model: input.model,
        year_from: input.year_from,
        year_to: input.year_to,
        description: input.description,
        remedy: input.remedy ?? null,
        issued_on: input.issued_on ?? null,
        created_by: caller.user.id,
      };
      const inserted = await repo.insertRecall(ctxOf(caller), data, client);
      const recall = await repo.recallById(client, inserted.id as string);
      const matched = await this.rematch(client, ctxOf(caller), this.eventContext(caller), recall);
      await this.deps.events.publish(client, [
        createEvent(
          WARRANTY_EVENTS.recallIssued,
          {
            recall_id: recall.publicId,
            campaign_code: recall.campaignCode,
            make: recall.make,
            model: recall.model,
            year_from: recall.yearFrom,
            year_to: recall.yearTo,
            vehicles: matched.length,
          },
          this.eventContext(caller),
          { aggregate: aggregateKey('recall', recall.publicId) },
        ),
        ...matched,
      ]);
      return (await this.recallViews(client, [recall], await vehicles.idsInScope(client, scope)))[0];
    });
  }

  /**
   * PATCH /recalls/{id}: the fields sent. A change of make, model or years lists the vehicles it now
   * applies to, and drops those it no longer does that are still open with no work order.
   */
  async updateRecall(caller: Caller, recallId: string, patch: RecallUpdate, expectedVersion: number | null): Promise<RecallView> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const scope = depotScope(caller.user);
      if (scope.kind !== 'all') throw recallFleetWideOnly();
      const row = await repo.lockRecall(client, recallId);
      if (!row) throw recallNotFound();
      if (expectedVersion !== null && expectedVersion !== row.version) throw staleVersion();
      const data: RecallWrite = {};
      for (const key of ['campaign_code', 'make', 'model', 'year_from', 'year_to', 'description', 'remedy', 'issued_on'] as const) {
        if (patch[key] !== undefined) (data as Record<string, unknown>)[key] = patch[key];
      }
      if ((data.year_to ?? row.yearTo) < (data.year_from ?? row.yearFrom)) throw recallYearsReversed();
      if (data.campaign_code !== undefined && (await repo.codeTaken(client, data.campaign_code, row.id))) throw recallCodeTaken();
      if (Object.keys(data).length > 0) {
        await repo.updateRecall(ctxOf(caller), row.id, data, client);
        const target = ['make', 'model', 'year_from', 'year_to'].some((k) => k in data);
        if (target) {
          const matched = await this.rematch(client, ctxOf(caller), this.eventContext(caller), await repo.recallById(client, row.id), true);
          await this.deps.events.publish(client, matched);
        }
      }
      return (await this.recallViews(client, [await repo.recallById(client, row.id)], await vehicles.idsInScope(client, scope)))[0];
    });
  }

  /** GET /recalls/{id}/vehicles: its vehicles in the caller's depots, open first. */
  async recallVehicles(caller: Caller, recallId: string, query: RecallVehicleQuery): Promise<{ items: RecallVehicleView[]; total: number }> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const recall = await repo.findRecall(client, recallId);
      if (!recall) throw recallNotFound();
      const { rows, total } = await repo.listRecallVehicles(client, {
        page: query.page,
        page_size: query.page_size,
        recallId: recall.id,
        vehicleIds: await vehicles.idsInScope(client, depotScope(caller.user)),
        statuses: query.status ?? null,
      });
      return { items: await this.recallVehicleViews(client, rows), total };
    });
  }

  /** GET /vehicles/{id}/recalls: every recall of the vehicle, open first. */
  async vehicleRecalls(caller: Caller, vehiclePublicId: string): Promise<RecallVehicleView[]> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const vehicle = await vehicles.findInScope(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw maintenanceVehicleMissing();
      return this.recallVehicleViews(client, await repo.recallsOf(client, vehicle.id));
    });
  }

  /**
   * PATCH /recalls/{id}/vehicles/{vehicle_id}: link the work order (scheduled; completed when that work is
   * already done), complete it by hand, or put it back to open (the work order unlinked). Completed is final.
   */
  async updateRecallVehicle(caller: Caller, recallId: string, vehiclePublicId: string, patch: RecallVehicleUpdate): Promise<RecallVehicleView> {
    const { repo, vehicles } = this.deps;
    return repo.inTransaction(async (client) => {
      const recall = await repo.findRecall(client, recallId);
      const vehicle = recall && (await vehicles.findInScope(client, { publicId: vehiclePublicId }, depotScope(caller.user)));
      const row = vehicle && (await repo.lockRecallVehicle(client, recall.id, vehicle.id));
      if (!recall) throw recallNotFound();
      if (!vehicle || !row) throw recallVehicleNotFound();
      if (row.status === 'completed') throw recallCompletedFinal();

      let recordId = row.recordId;
      let recordCompletedAt: Date | null = null;
      if (patch.maintenance_record_id !== undefined) {
        if (patch.maintenance_record_id === null) recordId = null;
        else {
          const record = await repo.recordOf(client, patch.maintenance_record_id);
          if (!record || record.vehicleId !== vehicle.id || record.status === 'cancelled') throw recallRecordNotFound();
          recordId = record.id;
          recordCompletedAt = record.status === 'completed' ? record.completedAt : null;
        }
      }
      let status: RecallVehicleStatus = patch.status ?? (recordCompletedAt ? 'completed' : recordId ? 'scheduled' : row.status);
      if (status === 'open') recordId = null;
      if (status === 'scheduled' && !recordId) throw recallScheduleNeedsRecord();
      const data: RecallVehicleWrite = { status, maintenance_record_id: recordId, updated_by: caller.user.id };
      if (patch.notes !== undefined) data.notes = patch.notes;
      if (status === 'completed') {
        const at = patch.completed_at ? new Date(patch.completed_at) : (recordCompletedAt ?? this.now());
        if (at.getTime() > this.now().getTime() + CLOCK_SKEW_MS) throw recallCompletedInFuture();
        data.completed_at = at.toISOString();
      }
      await repo.updateRecallVehicle(ctxOf(caller), client, row.id, data);
      const updated = await repo.recallVehicleById(client, row.id);
      status = updated.status;
      if (status === 'completed') await this.deps.events.publish(client, [this.completedEvent(this.eventContext(caller), updated, vehicle.publicId)]);
      return (await this.recallVehicleViews(client, [updated]))[0];
    });
  }

  /**
   * A work order completed or cancelled (MaintenanceService, on its transaction): the recall work it
   * carried out is completed with it, or, cancelled, back to open.
   */
  async repairClosed(client: PoolClient, caller: Caller, recordId: string, vehiclePublicId: string, outcome: { completedAt: Date } | 'cancelled'): Promise<void> {
    const { repo } = this.deps;
    const work = await repo.lockRecallWorkFor(client, recordId);
    const events: DomainEvent[] = [];
    for (const w of work) {
      if (outcome === 'cancelled') {
        await repo.updateRecallVehicle(ctxOf(caller), client, w.id, { status: 'open', maintenance_record_id: null, updated_by: caller.user.id });
        continue;
      }
      await repo.updateRecallVehicle(ctxOf(caller), client, w.id, { status: 'completed', completed_at: outcome.completedAt.toISOString(), updated_by: caller.user.id });
      events.push(this.completedEvent(this.eventContext(caller), await repo.recallVehicleById(client, w.id), vehiclePublicId));
    }
    await this.deps.events.publish(client, events);
  }

  /**
   * VehicleRegistered or VehicleUpdated (on that event's transaction): the recalls the vehicle now falls
   * under list it as open. Recalls it no longer matches keep it: its make, model or year was corrected,
   * and someone should look.
   */
  async vehicleChanged(client: PoolClient, vehiclePublicId: string, correlationId: string): Promise<number> {
    const { repo, vehicles } = this.deps;
    const vehicle = await vehicles.findInScope(client, { publicId: vehiclePublicId }, { kind: 'all' });
    if (!vehicle) return 0;
    const [candidate] = await vehicles.forRecall(client, { ids: [vehicle.id] });
    if (!candidate) return 0;
    const listed = await repo.recallIdsOf(client, vehicle.id);
    const ctx: MutationContext = { userId: null, correlationId };
    const events: DomainEvent[] = [];
    for (const recall of await repo.allRecalls(client)) {
      if (listed.has(recall.id) || !recallMatches(recall, candidate)) continue;
      await repo.insertMatch(ctx, client, recall.id, vehicle.id);
      events.push(this.openedEvent({ actor: null, correlationId }, recall, candidate.publicId));
    }
    await this.deps.events.publish(client, events);
    return events.length;
  }

  /** Lists the vehicles the recall applies to (and, `prune`, drops open unbooked ones it no longer does); the events to publish. */
  private async rematch(client: PoolClient, ctx: MutationContext, eventCtx: { actor: string | null; correlationId: string }, recall: RecallRow, prune = false): Promise<DomainEvent[]> {
    const { repo, vehicles } = this.deps;
    const candidates = (await vehicles.forRecall(client, { make: recall.make, model: recall.model })).filter((v) => recallMatches(recall, v));
    const existing = await repo.matchesOf(client, recall.id);
    const listed = new Set(existing.map((m) => m.vehicleId));
    const wanted = new Set(candidates.map((v) => v.id));
    if (prune) for (const m of existing) if (!wanted.has(m.vehicleId)) await repo.removeMatch(ctx, client, m.id);
    const events: DomainEvent[] = [];
    for (const v of candidates) {
      if (listed.has(v.id)) continue;
      await repo.insertMatch(ctx, client, recall.id, v.id);
      events.push(this.openedEvent(eventCtx, recall, v.publicId));
    }
    return events;
  }

  private openedEvent(ctx: { actor: string | null; correlationId: string }, recall: RecallRow, vehiclePublicId: string): DomainEvent {
    return createEvent(
      WARRANTY_EVENTS.vehicleRecalled,
      { recall_id: recall.publicId, campaign_code: recall.campaignCode, vehicle_id: vehiclePublicId, description: recall.description },
      ctx,
      { aggregate: aggregateKey('vehicle', vehiclePublicId) },
    );
  }

  private completedEvent(ctx: { actor: string | null; correlationId: string }, row: RecallVehicleRow, vehiclePublicId: string): DomainEvent {
    return createEvent(
      WARRANTY_EVENTS.recallCompleted,
      {
        recall_id: row.recallPublicId,
        campaign_code: row.campaignCode,
        vehicle_id: vehiclePublicId,
        maintenance_record_id: row.recordPublicId,
        completed_at: row.completedAt!.toISOString(),
      },
      ctx,
      { aggregate: aggregateKey('vehicle', vehiclePublicId) },
    );
  }

  private eventContext(caller: Caller) {
    return { actor: caller.user.publicId, correlationId: caller.correlationId };
  }

  private async visibleWarranty(client: PoolClient, caller: Caller, publicId: string, lock: boolean): Promise<WarrantyRow> {
    const row = lock ? await this.deps.repo.lockWarranty(client, publicId) : await this.deps.repo.findWarranty(client, publicId);
    if (!row || !(await this.deps.vehicles.findInScope(client, { id: row.vehicleId }, depotScope(caller.user)))) throw warrantyNotFound();
    return row;
  }

  private async warrantyViews(db: Queryable, rows: readonly WarrantyRow[]): Promise<WarrantyView[]> {
    if (rows.length === 0) return [];
    const vehicleIds = [...new Set(rows.map((r) => r.vehicleId))];
    const refs = await this.deps.vehicles.refsByIds(db, vehicleIds);
    const odometers = await this.deps.vehicles.odometers(db, vehicleIds);
    const counts = await this.deps.repo.claimCounts(db, rows.map((r) => r.id));
    const today = operatingDay(this.now());
    const expiringDays = await this.deps.warningDays();
    return rows.map((r) => {
      const odometer = odometers.get(r.vehicleId) ?? null;
      const claims = { claimable: 0, submitted: 0, approved: 0, rejected: 0, recovered_cents: 0 };
      for (const c of counts.get(r.id) ?? []) {
        if (CLAIM_STATUSES.includes(c.status)) claims[c.status] = c.n;
        if (c.status === 'approved') claims.recovered_cents = c.cents;
      }
      return {
        id: r.publicId,
        vehicle_id: refs.get(r.vehicleId)!.publicId,
        registration_number: refs.get(r.vehicleId)!.registrationNumber,
        component: r.component,
        provider: r.provider,
        coverage: r.coverage,
        starts_on: r.startsOn,
        ends_on: r.endsOn,
        ends_km: r.endsKm,
        terms: r.terms,
        is_active: r.isActive,
        status: warrantyStatus(r, today, odometer, expiringDays),
        days_left: r.endsOn === null ? null : daysFrom(today, r.endsOn),
        km_left: r.endsKm === null || odometer === null ? null : Math.round((r.endsKm - odometer) * 10) / 10,
        claims,
        version: r.version,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      };
    });
  }

  private async recallViews(db: Queryable, rows: readonly RecallRow[], vehicleIds: readonly string[] | null): Promise<RecallView[]> {
    if (rows.length === 0) return [];
    const counts = await this.deps.repo.recallCounts(db, rows.map((r) => r.id), vehicleIds);
    return rows.map((r) => {
      const c = counts.get(r.id) ?? { open: 0, scheduled: 0, completed: 0 };
      return {
        id: r.publicId,
        campaign_code: r.campaignCode,
        make: r.make,
        model: r.model,
        year_from: r.yearFrom,
        year_to: r.yearTo,
        description: r.description,
        remedy: r.remedy,
        issued_on: r.issuedOn,
        vehicles: { total: c.open + c.scheduled + c.completed, ...c },
        version: r.version,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      };
    });
  }

  private async recallVehicleViews(db: Queryable, rows: readonly RecallVehicleRow[]): Promise<RecallVehicleView[]> {
    if (rows.length === 0) return [];
    const refs = await this.deps.vehicles.refsByIds(db, [...new Set(rows.map((r) => r.vehicleId))]);
    return rows.map((r) => ({
      recall_id: r.recallPublicId,
      campaign_code: r.campaignCode,
      description: r.description,
      remedy: r.remedy,
      vehicle_id: refs.get(r.vehicleId)!.publicId,
      registration_number: refs.get(r.vehicleId)!.registrationNumber,
      status: r.status,
      maintenance_record_id: r.recordPublicId,
      completed_at: r.completedAt,
      notes: r.notes,
      matched_at: r.matchedAt,
      updated_at: r.updatedAt,
    }));
  }
}

/** A warranty ends on a date, at an odometer reading, or both, and not before it starts. */
function checkEnd(startsOn: string, endsOn: string | null, endsKm: number | null): void {
  if (endsOn === null && endsKm === null) throw warrantyEndRequired();
  if (endsOn !== null && endsOn < startsOn) throw warrantyEndsBeforeStart();
}

function ctxOf(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}
