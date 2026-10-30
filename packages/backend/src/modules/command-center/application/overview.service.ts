import { depotScope, type Scope } from '../../../shared/authz/scope';
import type { Cache } from '../../../shared/cache/cache';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  OVERVIEW_CACHE_TTL_SECONDS,
  OVERVIEW_LIST_LIMIT,
  addisDayOf,
  depotNotFound,
  forCaller,
  summarise,
  type CommandCenterOverview,
  type HealthBands,
  type OverviewAlert,
  type OverviewDriver,
  type OverviewIncident,
  type OverviewInput,
  type OverviewVehicle,
} from '../domain/overview';

/** What the overview reads from fleet, trip and alert (connected in command-center/index.ts). Internal ids. */
export interface OverviewRefs {
  depots: {
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  vehicles(db: Queryable, depotId: string | null): Promise<OverviewVehicle[]>;
  drivers(db: Queryable, depotId: string | null, day: string): Promise<OverviewDriver[]>;
  trips(db: Queryable, depotId: string | null, from: Date, to: Date, now: Date): Promise<OverviewInput['trips']>;
  /** Each in its own read transaction. */
  alerts(depotId: string | null, limit: number): Promise<{ items: OverviewAlert[]; counts: { status: string; severity: string; n: number }[] }>;
  incidents(depotId: string | null, limit: number): Promise<{ items: OverviewIncident[]; counts: { status: string; severity: string; n: number }[] }>;
}

export interface OverviewServiceDeps {
  db: Queryable;
  refs: OverviewRefs;
  cache: Cache;
  bands: HealthBands;
  now?: () => Date;
}

/**
 * The command center's overview (FMS-89): one depot or every depot in the caller's scope (a depot's staff see
 * theirs; `depot_id` narrows a fleet-wide user's). Cached for OVERVIEW_CACHE_TTL_SECONDS, one per depot shown and
 * one for "all", shared by everyone who sees it, and dropped by the events that change it (index.ts). The cache
 * holds every section; each caller gets the sections they may read.
 */
export class OverviewService {
  constructor(private readonly deps: OverviewServiceDeps) {}

  async overview(user: RequestUser, query: { depotId?: string }): Promise<CommandCenterOverview> {
    const { db, refs, cache } = this.deps;
    const scope = depotScope(user);
    // Someone who can be placed in no depot sees an empty overview, never another depot's.
    if (scope.kind === 'none') return forCaller(this.empty(), user.permissions);
    let depotId: string | null = null;
    let shown: string | null = null;
    if (query.depotId) {
      depotId = await refs.depots.resolveInScope(db, query.depotId, scope);
      if (!depotId) throw depotNotFound();
      shown = query.depotId;
    } else if (scope.kind === 'depot') {
      depotId = scope.depotId;
      shown = (await refs.depots.publicIds(db, [depotId])).get(depotId) ?? null;
      if (!shown) return forCaller(this.empty(), user.permissions);
    }
    const overview = await cache.getOrSet(cache.key('command-center', 'overview', shown ?? 'all'), OVERVIEW_CACHE_TTL_SECONDS, () =>
      this.load(depotId, shown),
    );
    return forCaller(overview, user.permissions);
  }

  /** Drops every cached overview: an alert, incident, trip or vehicle changed. */
  async invalidate(): Promise<void> {
    await this.deps.cache.invalidate('command-center:overview:*');
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** One depot's (internal id, already checked against the caller's scope), or every depot's. */
  private async load(depotId: string | null, shown: string | null): Promise<CommandCenterOverview> {
    const { db, refs, bands } = this.deps;
    const now = this.now();
    const { day, from, to } = addisDayOf(now);
    // One after another: a transaction's client (tests, a caller's own) runs one query at a time anyway.
    const vehicles = await refs.vehicles(db, depotId);
    const drivers = await refs.drivers(db, depotId, day);
    const trips = await refs.trips(db, depotId, from, to, now);
    const alerts = await refs.alerts(depotId, OVERVIEW_LIST_LIMIT);
    const incidents = await refs.incidents(depotId, OVERVIEW_LIST_LIMIT);
    return summarise({ depotId: shown, now, bands, vehicles, drivers, trips, alerts, incidents });
  }

  private empty(): CommandCenterOverview {
    const empty = { items: [], counts: [] };
    return summarise({ depotId: null, now: this.now(), bands: this.deps.bands, vehicles: [], drivers: [], trips: { today: [], underWay: [] }, alerts: empty, incidents: empty });
  }
}
