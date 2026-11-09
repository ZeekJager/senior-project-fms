import type { Pool, PoolClient } from 'pg';
import { aggregateKey, createEvent, deterministicEventId, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import { operatingToday } from '../domain/attendance';
import { EXPIRY_EVENTS, expiryLevel, type ExpiryRunResult, type WarrantyExpirySource } from '../domain/expiry';
import type { ExpiryRepository } from '../infrastructure/expiry.repository';

export interface ExpiryServiceDeps {
  db: Pool;
  expiry: ExpiryRepository;
  /** Account public ids and home depots (auth module). */
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; depotId: string | null }[]> };
  depots: { publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> };
  events: EventBus;
  /** Days ahead of an expiry the first (amber) warning comes: the expiry_warning_days setting (FMS-80). */
  warningDays: () => Promise<number>;
  /**
   * The warranties ending within the window (maintenance module, FMS-133), connected by
   * src/modules/index.ts; null until then, and no warranty is checked.
   */
  warranties: () => WarrantyExpirySource | null;
  /** Of the vehicles asked (internal ids), those not retired, with their public ids. */
  activeVehicles: (db: Queryable, ids: readonly string[]) => Promise<Map<string, string>>;
}

/** Who runs a check: a scheduled job (its run's correlation id) or the upload that triggered it. */
export interface ExpiryCheck {
  now: Date;
  correlationId: string;
}

/**
 * Raises DocumentExpiring, LicenceExpiring and WarrantyExpiring (FMS-26, FMS-133): amber within 30
 * days of the expiry date (the expiry_warning_days setting), red within 7. A level is raised once per subject
 * and expiry date (fleet.expiry_notices), so re-running a check publishes
 * nothing new. Events go into the outbox with the notices, with actor null
 * (the system) and ids derived from the fact, so a consumer that sees one
 * twice can drop it.
 */
export class ExpiryService {
  constructor(private readonly deps: ExpiryServiceDeps) {}

  /**
   * Every live document, or only `documentId` (the check on DocumentUploaded,
   * on that consumer's transaction `tx`).
   */
  async checkDocuments(check: ExpiryCheck, documentId?: string, tx?: PoolClient): Promise<ExpiryRunResult> {
    const { db, expiry } = this.deps;
    const today = operatingToday(check.now);
    const windowDays = await this.deps.warningDays();
    const run = <T>(fn: (client: PoolClient) => Promise<T>) => (tx ? fn(tx) : withTransaction(db, fn));
    return run(async (client) => {
      const due = await expiry.documentsDue(client, today, windowDays, documentId);
      const raised: DomainEvent[] = [];
      for (const doc of due) {
        const level = expiryLevel(doc.daysLeft, windowDays)!;
        const recorded = await expiry.recordNotice(client, {
          subject: 'document',
          subjectId: doc.id,
          expiresOn: doc.expiresOn,
          level,
          daysLeft: doc.daysLeft,
          correlationId: check.correlationId,
        });
        if (!recorded) continue;
        raised.push(
          createEvent(
            EXPIRY_EVENTS.documentExpiring,
            {
              document_id: doc.publicId,
              owner_type: doc.ownerType,
              owner_id: doc.ownerPublicId,
              document_type: doc.documentType,
              expires_on: doc.expiresOn,
              days_left: doc.daysLeft,
              level,
            },
            { actor: null, correlationId: check.correlationId },
            {
              id: deterministicEventId(`${EXPIRY_EVENTS.documentExpiring}:${doc.publicId}:${doc.expiresOn}:${level}`),
              aggregate: aggregateKey('document', doc.publicId),
            },
          ),
        );
      }
      await this.deps.events.publish(client, raised);
      return { checked: due.length, raised: raised.length };
    });
  }

  /** Every active driver's licence. */
  async checkLicences(check: ExpiryCheck): Promise<ExpiryRunResult> {
    const { db, expiry, users, depots } = this.deps;
    const today = operatingToday(check.now);
    const windowDays = await this.deps.warningDays();
    return withTransaction(db, async (client) => {
      const due = await expiry.licencesDue(client, today, windowDays);
      const fresh: { licence: (typeof due)[number]; level: 'amber' | 'red' }[] = [];
      for (const licence of due) {
        const level = expiryLevel(licence.daysLeft, windowDays)!;
        const recorded = await expiry.recordNotice(client, {
          subject: 'licence',
          subjectId: licence.id,
          expiresOn: licence.licenseExpiry,
          level,
          daysLeft: licence.daysLeft,
          correlationId: check.correlationId,
        });
        if (recorded) fresh.push({ licence, level });
      }
      const accounts = new Map((await users.findByIds(client, fresh.map((f) => f.licence.userId))).map((a) => [a.id, a]));
      const depotIds = [...new Set([...accounts.values()].map((a) => a.depotId).filter((d): d is string => d !== null))];
      const depotPublic = await depots.publicIds(client, depotIds);
      const raised = fresh.map(({ licence, level }) => {
        const account = accounts.get(licence.userId);
        return createEvent(
          EXPIRY_EVENTS.licenceExpiring,
          {
            driver_id: licence.publicId,
            user_id: account?.publicId ?? null,
            depot_id: account?.depotId ? (depotPublic.get(account.depotId) ?? null) : null,
            license_expiry: licence.licenseExpiry,
            days_left: licence.daysLeft,
            level,
          },
          { actor: null, correlationId: check.correlationId },
          {
            id: deterministicEventId(`${EXPIRY_EVENTS.licenceExpiring}:${licence.publicId}:${licence.licenseExpiry}:${level}`),
            aggregate: aggregateKey('driver', licence.publicId),
          },
        );
      });
      await this.deps.events.publish(client, raised);
      return { checked: due.length, raised: raised.length };
    });
  }

  /**
   * Every live warranty of a vehicle in service with an end date in the window (FMS-133): the same levels
   * and notices as a document's. A warranty that ends at an odometer reading only is not warned of: its
   * end comes with the kilometres, not a date.
   */
  async checkWarranties(check: ExpiryCheck): Promise<ExpiryRunResult> {
    const source = this.deps.warranties();
    if (!source) return { checked: 0, raised: 0 };
    const { db, expiry } = this.deps;
    const today = operatingToday(check.now);
    const windowDays = await this.deps.warningDays();
    return withTransaction(db, async (client) => {
      const ending = await source(client, today, windowDays);
      const vehicles = await this.deps.activeVehicles(client, [...new Set(ending.map((w) => w.vehicleId))]);
      const due = ending.filter((w) => vehicles.has(w.vehicleId));
      const raised: DomainEvent[] = [];
      for (const w of due) {
        const level = expiryLevel(w.daysLeft, windowDays)!;
        const recorded = await expiry.recordNotice(client, {
          subject: 'warranty',
          subjectId: w.id,
          expiresOn: w.endsOn,
          level,
          daysLeft: w.daysLeft,
          correlationId: check.correlationId,
        });
        if (!recorded) continue;
        const vehicleId = vehicles.get(w.vehicleId)!;
        raised.push(
          createEvent(
            EXPIRY_EVENTS.warrantyExpiring,
            {
              warranty_id: w.publicId,
              vehicle_id: vehicleId,
              provider: w.provider,
              component: w.component,
              ends_on: w.endsOn,
              days_left: w.daysLeft,
              level,
            },
            { actor: null, correlationId: check.correlationId },
            {
              id: deterministicEventId(`${EXPIRY_EVENTS.warrantyExpiring}:${w.publicId}:${w.endsOn}:${level}`),
              aggregate: aggregateKey('vehicle', vehicleId),
            },
          ),
        );
      }
      await this.deps.events.publish(client, raised);
      return { checked: due.length, raised: raised.length };
    });
  }
}
