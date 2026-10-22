import type { PoolClient } from 'pg';
import { DEPOT_UNSCOPED_ROLES, depotScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { limitOffset, pageMeta, type Page } from '../../../shared/http/pagination';
import type { RequestUser } from '../../../types/express';
import { ALERT_EVENTS, alertNotActive, alertNotFound, moreSevere, priorityOf, type AlertSeverity, type AlertStatus, type AlertView } from '../domain/alert';
import { ALERT_RULES, ESCALATION_TIERS, tiersOf, type AlertRule } from '../domain/rules';
import type { AlertRepository, AlertRow } from '../infrastructure/alert.repository';

/** What the alert engine needs from fleet, trip and auth (connected in alert/index.ts). */
export interface AlertRefs {
  vehicles: {
    subject(db: Queryable, publicId: string): Promise<{ id: string; publicId: string; registrationNumber: string; depotId: string | null } | null>;
    refsByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; registrationNumber: string }>>;
  };
  drivers: {
    subject(db: Queryable, publicId: string): Promise<{ id: string; publicId: string; depotId: string | null } | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  depots: {
    idOf(db: Queryable, publicId: string): Promise<string | null>;
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  trips: {
    idsByPublicIds(db: Queryable, publicIds: readonly string[]): Promise<Map<string, string>>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  users: {
    activeWithRoles(db: Queryable, roles: readonly string[], depotId: string | null, unscopedRoles: readonly string[]): Promise<string[]>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
}

export interface AlertServiceDeps {
  repo: AlertRepository;
  refs: AlertRefs;
  events: EventBus;
  /** A critical alert unacknowledged this long escalates to the next tier, and again after as long. */
  escalationMinutes: number;
}

export interface AlertQuery extends Page {
  status?: AlertStatus[];
  severity?: AlertSeverity[];
  type?: string[];
  vehicle_id?: string;
  depot_id?: string;
  sort: 'newest' | 'priority';
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The alert engine (FMS-92, §34). Events become alerts by their rule (domain/rules.ts): the alert is
 * written first, then its recipients are notified in the same transaction, then AlertCreated goes out.
 * A repeat of the same source within the rule's window updates that alert (one more occurrence, never a
 * lower severity) and notifies nobody again. People acknowledge and resolve alerts; a critical alert
 * nobody acknowledges escalates, tier by tier, every `escalationMinutes`.
 */
export class AlertService {
  constructor(private readonly deps: AlertServiceDeps) {}

  /** An event, turned into an alert or into one more occurrence of an active one. Runs in the consumer's transaction. */
  async raise(tx: PoolClient, event: DomainEvent): Promise<{ alertId: string; created: boolean } | null> {
    const rule = ALERT_RULES[event.type];
    if (!rule) return null;
    const { repo, refs } = this.deps;
    const payload = event.payload as Record<string, unknown>;
    if (rule.when && !rule.when(payload)) return null;
    const facts = rule.facts(payload);
    const ctx: MutationContext = { userId: null, correlationId: event.correlation_id };
    const occurredAt = new Date(event.occurred_at);

    const vehicle = facts.vehicleId ? await refs.vehicles.subject(tx, facts.vehicleId) : null;
    const driver = facts.driverId ? await refs.drivers.subject(tx, facts.driverId) : null;
    const tripId = facts.tripId ? ((await refs.trips.idsByPublicIds(tx, [facts.tripId])).get(facts.tripId) ?? null) : null;
    const depotId = vehicle?.depotId ?? driver?.depotId ?? (facts.depotId ? await refs.depots.idOf(tx, facts.depotId) : null);
    const names = { plate: vehicle?.registrationNumber ?? null };
    const title = rule.title(payload, names);
    const message = rule.message(payload, names);

    await repo.lockSource(tx, facts.dedupKey);
    const active = await repo.findActiveByDedup(tx, facts.dedupKey, new Date(occurredAt.getTime() - rule.windowMinutes * 60_000));
    if (active) {
      const severity = moreSevere(active.severity, facts.severity);
      const updated = await repo.update(tx, ctx, active.id, {
        occurrence_count: active.occurrenceCount + 1,
        last_occurred_at: occurredAt > active.lastOccurredAt ? occurredAt : active.lastOccurredAt,
        severity,
        title,
        description: message,
        source_event_id: event.id,
      });
      const [view] = await this.views(tx, [updated]);
      await this.publish(tx, ctx, ALERT_EVENTS.updated, view, {
        status: view.status,
        severity: view.severity,
        priority: view.priority,
        occurrence_count: view.occurrence_count,
        last_occurred_at: view.last_occurred_at,
      });
      return { alertId: updated.publicId, created: false };
    }

    const alert = await repo.insert(tx, ctx, {
      alert_type: rule.type(payload),
      severity: facts.severity,
      source_module: rule.module,
      source_event_type: event.type,
      source_event_id: event.id,
      title,
      description: message,
      depot_id: depotId,
      vehicle_id: vehicle?.id ?? null,
      driver_id: driver?.id ?? null,
      trip_id: tripId,
      entity_type: facts.entity?.type ?? null,
      entity_id: facts.entity?.id ?? null,
      dedup_key: facts.dedupKey,
      last_occurred_at: occurredAt,
      details: payload,
    });
    await this.notifyTier(tx, ctx, alert, rule.audience, 'alert');
    const [view] = await this.views(tx, [alert]);
    await this.publish(tx, ctx, ALERT_EVENTS.created, view, {
      alert_type: view.type,
      severity: view.severity,
      priority: view.priority,
      status: view.status,
      entity_type: view.entity_type,
      entity_id: view.entity_id,
      vehicle_id: view.vehicle_id,
      title: view.title,
      message: view.message,
      created_at: view.created_at,
    });
    return { alertId: alert.publicId, created: true };
  }

  async list(user: RequestUser, query: AlertQuery): Promise<{ items: AlertView[]; meta: ReturnType<typeof pageMeta> }> {
    const { repo, refs } = this.deps;
    const scope = depotScope(user);
    return repo.inTransaction(async (client) => {
      const empty = { items: [], meta: pageMeta(query, 0) };
      const depotId = query.depot_id ? await refs.depots.resolveInScope(client, query.depot_id, scope) : undefined;
      if (depotId === null) return empty;
      const vehicleId = query.vehicle_id ? ((await refs.vehicles.subject(client, query.vehicle_id))?.id ?? null) : undefined;
      if (vehicleId === null) return empty;
      const { limit, offset } = limitOffset(query);
      const { rows, total } = await repo.list(client, {
        scope,
        depotId,
        vehicleId,
        statuses: query.status,
        severities: query.severity,
        types: query.type,
        sort: query.sort,
        limit,
        offset,
      });
      return { items: await this.views(client, rows), meta: pageMeta(query, total) };
    });
  }

  async get(user: RequestUser, publicId: string): Promise<AlertView> {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const row = await repo.findInScope(client, publicId, depotScope(user));
      if (!row) throw alertNotFound();
      return (await this.views(client, [row]))[0];
    });
  }

  /** Someone has seen it and is on it: an open alert becomes acknowledged, with who and when. It no longer escalates. */
  acknowledge(user: RequestUser, publicId: string, comment: string | null, correlationId: string): Promise<AlertView> {
    return this.act(user, publicId, comment, correlationId, 'acknowledge');
  }

  /** Dealt with: an open or acknowledged alert is resolved, with who and when. A repeat of its source then opens a new one. */
  resolve(user: RequestUser, publicId: string, comment: string | null, correlationId: string): Promise<AlertView> {
    return this.act(user, publicId, comment, correlationId, 'resolve');
  }

  /**
   * The escalation job (every minute): each critical alert still open `escalationMinutes` after it was
   * raised, or after its last escalation, goes to the next tier (ESCALATION_TIERS), whose members are
   * notified unless they were already told. One transaction per alert.
   */
  async escalate(run: { now: Date; correlationId: string }): Promise<{ escalated: number; notified: number }> {
    const { repo, escalationMinutes } = this.deps;
    const ctx: MutationContext = { userId: null, correlationId: run.correlationId };
    let escalated = 0;
    let notified = 0;
    for (;;) {
      const done = await repo.inTransaction(async (client) => {
        const [due] = await repo.dueForEscalation(client, run.now, escalationMinutes, ESCALATION_TIERS.length, 1);
        if (!due) return false;
        const level = due.escalationLevel + 1;
        const rule: AlertRule | undefined = due.sourceEventType ? ALERT_RULES[due.sourceEventType] : undefined;
        const tier = (rule ? tiersOf(rule) : [[], ...ESCALATION_TIERS])[level] ?? [];
        const updated = await repo.update(client, ctx, due.id, { escalation_level: level, escalated_at: run.now });
        notified += await this.notifyTier(client, ctx, updated, tier, 'alert_escalated');
        const [view] = await this.views(client, [updated]);
        await this.publish(client, ctx, ALERT_EVENTS.escalated, view, {
          status: view.status,
          severity: view.severity,
          escalation_level: view.escalation_level,
          escalated_at: view.escalated_at,
        });
        escalated += 1;
        return true;
      });
      if (!done) break;
    }
    return { escalated, notified };
  }

  private act(user: RequestUser, publicId: string, comment: string | null, correlationId: string, action: 'acknowledge' | 'resolve'): Promise<AlertView> {
    const { repo } = this.deps;
    const ctx: MutationContext = { userId: user.id, correlationId };
    return repo.inTransaction(async (client) => {
      const row = await repo.findInScope(client, publicId, depotScope(user), true);
      if (!row) throw alertNotFound();
      const allowed: AlertStatus[] = action === 'acknowledge' ? ['open'] : ['open', 'acknowledged'];
      if (!allowed.includes(row.status)) throw alertNotActive(row.status, action);
      const now = new Date();
      const updated = await repo.update(
        client,
        ctx,
        row.id,
        action === 'acknowledge'
          ? { status: 'acknowledged', acknowledged_at: now, acknowledged_by: user.id }
          : { status: 'resolved', resolved_at: now, resolved_by: user.id },
      );
      await repo.recordAction(client, ctx, row.id, user.id!, action, comment);
      const [view] = await this.views(client, [updated]);
      await this.publish(
        client,
        ctx,
        action === 'acknowledge' ? ALERT_EVENTS.acknowledged : ALERT_EVENTS.resolved,
        view,
        action === 'acknowledge'
          ? { status: view.status, acknowledged_at: view.acknowledged_at, acknowledged_by: view.acknowledged_by }
          : { status: view.status, resolved_at: view.resolved_at, resolved_by: view.resolved_by },
        user.publicId ?? null,
      );
      return view;
    });
  }

  /** Tells the tier's members who see the alert's depot, except anyone already told about it. */
  private async notifyTier(client: PoolClient, ctx: MutationContext, alert: AlertRow, roles: readonly string[], type: 'alert' | 'alert_escalated'): Promise<number> {
    const { repo, refs } = this.deps;
    const users = await refs.users.activeWithRoles(client, roles, alert.depotId, DEPOT_UNSCOPED_ROLES);
    const already = await repo.notified(client, alert.id);
    const recipients = users.filter((id) => !already.has(id));
    const title = type === 'alert_escalated' ? `Escalated: ${alert.title}` : alert.title;
    const message =
      type === 'alert_escalated' ? `Nobody has acknowledged this ${alert.severity} alert yet. ${alert.description ?? ''}`.trim() : (alert.description ?? alert.title);
    return repo.notify(client, ctx, alert.id, recipients, { type, title, message });
  }

  private async publish(client: PoolClient, ctx: MutationContext, type: string, view: AlertView, fields: Record<string, unknown>, actor: string | null = null): Promise<void> {
    await this.deps.events.publish(client, [
      createEvent(type, { alert_id: view.id, depot_id: view.depot_id, ...fields }, { actor, correlationId: ctx.correlationId }, { aggregate: aggregateKey('alert', view.id) }),
    ]);
  }

  /** Alert rows as the API shows them: other modules' ids as public ids, with one query per kind. */
  private async views(db: Queryable, rows: readonly AlertRow[]): Promise<AlertView[]> {
    const { refs } = this.deps;
    const ids = <K extends keyof AlertRow>(key: K) => [...new Set(rows.map((r) => r[key]).filter((v): v is NonNullable<AlertRow[K]> => v !== null))] as string[];
    const vehicles = await refs.vehicles.refsByIds(db, ids('vehicleId'));
    const drivers = await refs.drivers.publicIds(db, ids('driverId'));
    const trips = await refs.trips.publicIds(db, ids('tripId'));
    const depots = await refs.depots.publicIds(db, ids('depotId'));
    const users = await refs.users.publicIds(db, [...ids('acknowledgedBy'), ...ids('resolvedBy')]);
    const pub = (map: Map<string, string>, id: string | null) => (id ? (map.get(id) ?? null) : null);
    return rows.map((r) => ({
      id: r.publicId,
      type: r.alertType,
      severity: r.severity,
      priority: priorityOf(r.severity),
      status: r.status,
      title: r.title,
      message: r.description,
      depot_id: pub(depots, r.depotId),
      vehicle_id: r.vehicleId ? (vehicles.get(r.vehicleId)?.publicId ?? null) : null,
      driver_id: pub(drivers, r.driverId),
      trip_id: pub(trips, r.tripId),
      entity_type: r.entityType,
      entity_id: r.entityId,
      source: { module: r.sourceModule, event_type: r.sourceEventType },
      occurrence_count: r.occurrenceCount,
      last_occurred_at: r.lastOccurredAt.toISOString(),
      escalation_level: r.escalationLevel,
      escalated_at: iso(r.escalatedAt),
      created_at: r.createdAt.toISOString(),
      acknowledged_at: iso(r.acknowledgedAt),
      acknowledged_by: pub(users, r.acknowledgedBy),
      resolved_at: iso(r.resolvedAt),
      resolved_by: pub(users, r.resolvedBy),
    }));
  }
}
