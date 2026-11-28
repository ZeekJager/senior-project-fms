import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { notFound } from '../../../shared/errors/app-error';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestSource } from '../../../shared/infrastructure/request-source';
import type { RequestUser } from '../../../types/express';
import { MAX_UNKNOWN_DEVICES_PER_PROVIDER } from '../domain/device';
import {
  codeOf,
  describe,
  DIAGNOSTIC_EVENTS,
  dictionaryKeyOf,
  severityOf,
  type DiagnosticCodeView,
  type DiagnosticEntry,
  type DiagnosticOutcome,
} from '../domain/diagnostics';
import { MAX_FUTURE_SKEW_MS } from '../domain/gps';
import type { DeviceRepository } from '../infrastructure/device.repository';
import type { DiagnosticRepository, DiagnosticRow } from '../infrastructure/diagnostic.repository';
import type { IngestVehicle } from './ingestion.service';

export interface DiagnosticsServiceDeps {
  db: Queryable;
  diagnostics: DiagnosticRepository;
  devices: DeviceRepository;
  refs: {
    vehicles: {
      byIds(db: Queryable, ids: readonly string[]): Promise<IngestVehicle[]>;
      byPublicIds(db: Queryable, publicIds: readonly string[], scope: Scope): Promise<IngestVehicle[]>;
    };
  };
  events: EventBus;
  now?: () => number;
}

export interface DiagnosticsResult {
  raised: number;
  repeated: number;
  cleared: number;
  ignored: number;
  unknown_devices: number;
}

/**
 * Diagnostic trouble codes from telematics (FMS-132, docs/diagnostic-codes.md). A delivery's codes, oldest first, on
 * the webhook consumer's transaction:
 * - active, and the vehicle has no active row for it: a row (first seen, last seen, one occurrence) and
 *   VehicleFaultDetected, which the alert engine makes one vehicle fault alert;
 * - active again: one more occurrence and a later last seen; no event, so no second alert;
 * - cleared: the row closes at its time and VehicleFaultCleared closes the alert.
 * Out of order: a clear older than the code's last report, or a report older than its last clear, is ignored, and
 * so is a code from the future or one at a time already counted (a provider sending the same report twice).
 */
export class DiagnosticsService {
  private readonly now: () => number;

  constructor(private readonly deps: DiagnosticsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async ingestDelivery(tx: PoolClient, provider: { id: string; code: string }, entries: readonly DiagnosticEntry[], correlationId: string): Promise<DiagnosticsResult> {
    const { devices, diagnostics, refs, events } = this.deps;
    const found = await devices.providerDevices(tx, provider.id, [...new Set(entries.map((e) => e.device_id))]);
    const vehicles = new Map((await refs.vehicles.byIds(tx, [...new Set([...found.values()].map((d) => d.vehicleId))])).map((v) => [v.id, v]));
    const dictionary = await diagnostics.dictionary(
      tx,
      entries.map((e) => ({ protocol: e.protocol, code: dictionaryKeyOf(e) })),
    );

    const result: DiagnosticsResult = { raised: 0, repeated: 0, cleared: 0, ignored: 0, unknown_devices: 0 };
    const unknown = new Map<string, number>();
    const published: DomainEvent[] = [];
    const changed: { id: string; outcome: DiagnosticOutcome }[] = [];
    const ordered = [...entries].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
    for (const entry of ordered) {
      const device = found.get(entry.device_id);
      const vehicle = device && vehicles.get(device.vehicleId);
      if (!device || !vehicle) {
        unknown.set(entry.device_id, (unknown.get(entry.device_id) ?? 0) + 1);
        result.unknown_devices++;
        continue;
      }
      const at = new Date(entry.observed_at);
      const code = codeOf(entry);
      if (at.getTime() > this.now() + MAX_FUTURE_SKEW_MS) {
        result.ignored++;
        continue;
      }
      const active = await diagnostics.lockActive(tx, vehicle.id, entry.protocol, code);
      if (entry.status === 'active') {
        if (active) {
          if (at.getTime() === active.lastSeenAt.getTime() || at.getTime() === active.firstSeenAt.getTime()) {
            result.ignored++;
            continue;
          }
          await diagnostics.repeat(tx, active.id, at);
          result.repeated++;
          continue;
        }
        const clearedAt = await diagnostics.lastCleared(tx, vehicle.id, entry.protocol, code);
        if (clearedAt && at <= clearedAt) {
          result.ignored++;
          continue;
        }
        const known = dictionary.get(`${entry.protocol}:${dictionaryKeyOf(entry)}`) ?? null;
        const row = {
          vehicleId: vehicle.id,
          providerId: provider.id,
          deviceId: device.id,
          protocol: entry.protocol,
          code,
          spn: entry.protocol === 'j1939' ? entry.spn : null,
          fmi: entry.protocol === 'j1939' ? entry.fmi : null,
          description: describe(entry, known?.description ?? null),
          severity: severityOf(entry, known?.severity ?? null),
          observedAt: at,
        };
        const inserted = await diagnostics.insert(tx, row);
        result.raised++;
        changed.push({ id: inserted.publicId, outcome: 'raised' });
        published.push(
          createEvent(
            DIAGNOSTIC_EVENTS.faultDetected,
            {
              source: 'telematics',
              diagnostic_code_id: inserted.publicId,
              vehicle_id: vehicle.publicId,
              depot_id: vehicle.depotPublicId,
              provider: provider.code,
              protocol: row.protocol,
              code: row.code,
              spn: row.spn,
              fmi: row.fmi,
              description: row.description,
              severity: row.severity,
              observed_at: entry.observed_at,
            },
            { actor: null, correlationId },
            { aggregate: aggregateKey('vehicle', vehicle.publicId) },
          ),
        );
        continue;
      }
      // Cleared: only an active code, and only by a clear no older than its last report.
      if (!active || at < active.lastSeenAt) {
        result.ignored++;
        continue;
      }
      await diagnostics.clear(tx, active.id, at);
      result.cleared++;
      changed.push({ id: active.publicId, outcome: 'cleared' });
      published.push(
        createEvent(
          DIAGNOSTIC_EVENTS.faultCleared,
          {
            source: 'telematics',
            diagnostic_code_id: active.publicId,
            vehicle_id: vehicle.publicId,
            depot_id: vehicle.depotPublicId,
            protocol: active.protocol,
            code: active.code,
            cleared_at: entry.observed_at,
          },
          { actor: null, correlationId },
          { aggregate: aggregateKey('vehicle', vehicle.publicId) },
        ),
      );
    }

    await devices.noteUnknown(tx, provider.id, unknown, new Date(this.now()), MAX_UNKNOWN_DEVICES_PER_PROVIDER);
    if (published.length > 0) await events.publish(tx, published);
    await recordAuditEntry(tx, {
      action: 'tracking.diagnostics_ingested',
      userId: null,
      entityType: 'tracking.diagnostic_codes',
      entityId: null,
      correlationId,
      source: { channel: 'webhook' } satisfies RequestSource,
      details: { provider: provider.code, received: entries.length, ...result, codes: changed },
    });
    return result;
  }

  /** GET /vehicles/{vehicle_id}/diagnostic-codes: a vehicle of the caller's depots, its active codes first. */
  async forVehicle(user: RequestUser, vehiclePublicId: string, query: { status: 'active' | 'cleared' | null; limit: number }): Promise<DiagnosticCodeView[]> {
    const { db, refs, diagnostics } = this.deps;
    const [vehicle] = await refs.vehicles.byPublicIds(db, [vehiclePublicId], depotScope(user));
    if (!vehicle) throw notFound('Vehicle not found.');
    const rows = await diagnostics.forVehicle(db, vehicle.id, query);
    return rows.map((r) => view(r, vehicle.publicId));
  }
}

function view(r: DiagnosticRow, vehiclePublicId: string): DiagnosticCodeView {
  return {
    id: r.publicId,
    vehicle_id: vehiclePublicId,
    protocol: r.protocol,
    code: r.code,
    spn: r.spn,
    fmi: r.fmi,
    description: r.description,
    severity: r.severity,
    status: r.clearedAt ? 'cleared' : 'active',
    first_seen_at: r.firstSeenAt.toISOString(),
    last_seen_at: r.lastSeenAt.toISOString(),
    occurrences: r.occurrences,
    cleared_at: r.clearedAt?.toISOString() ?? null,
    provider: r.providerCode,
  };
}
