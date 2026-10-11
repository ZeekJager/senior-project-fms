import type { Pool } from 'pg';
import { createEvent, deterministicEventId, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import { operatingToday } from '../domain/attendance';
import { EXPIRY_EVENTS, EXPIRY_WINDOW_DAYS, expiryLevel, type ExpiryRunResult } from '../domain/expiry';
import type { ExpiryRepository } from '../infrastructure/expiry.repository';

export interface ExpiryServiceDeps {
  db: Pool;
  expiry: ExpiryRepository;
  /** Account public ids and home depots (auth module). */
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; depotId: string | null }[]> };
  depots: { publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> };
  events: EventBus;
}

/** Who runs a check: a scheduled job (its run's correlation id) or the upload that triggered it. */
export interface ExpiryCheck {
  now: Date;
  correlationId: string;
}

/**
 * Raises DocumentExpiring and LicenceExpiring (FMS-26): amber within 30
 * days of the expiry date, red within 7. A level is raised once per subject
 * and expiry date (fleet.expiry_notices), so re-running a check publishes
 * nothing new. Events are published after the notices commit, with actor
 * null (the system) and ids derived from the fact, so a consumer that sees
 * one twice can drop it.
 */
export class ExpiryService {
  constructor(private readonly deps: ExpiryServiceDeps) {}

  /** Every live document, or only `documentId` (the check on DocumentUploaded). */
  async checkDocuments(check: ExpiryCheck, documentId?: string): Promise<ExpiryRunResult> {
    const { db, expiry } = this.deps;
    const today = operatingToday(check.now);
    const { checked, events } = await withTransaction(db, async (client) => {
      const due = await expiry.documentsDue(client, today, EXPIRY_WINDOW_DAYS, documentId);
      const raised: DomainEvent[] = [];
      for (const doc of due) {
        const level = expiryLevel(doc.daysLeft)!;
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
            { id: deterministicEventId(`${EXPIRY_EVENTS.documentExpiring}:${doc.publicId}:${doc.expiresOn}:${level}`) },
          ),
        );
      }
      return { checked: due.length, events: raised };
    });
    await this.deps.events.publish(events);
    return { checked, raised: events.length };
  }

  /** Every active driver's licence. */
  async checkLicences(check: ExpiryCheck): Promise<ExpiryRunResult> {
    const { db, expiry, users, depots } = this.deps;
    const today = operatingToday(check.now);
    const { checked, events } = await withTransaction(db, async (client) => {
      const due = await expiry.licencesDue(client, today, EXPIRY_WINDOW_DAYS);
      const fresh: { licence: (typeof due)[number]; level: 'amber' | 'red' }[] = [];
      for (const licence of due) {
        const level = expiryLevel(licence.daysLeft)!;
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
          { id: deterministicEventId(`${EXPIRY_EVENTS.licenceExpiring}:${licence.publicId}:${licence.licenseExpiry}:${level}`) },
        );
      });
      return { checked: due.length, events: raised };
    });
    await this.deps.events.publish(events);
    return { checked, raised: events.length };
  }
}
