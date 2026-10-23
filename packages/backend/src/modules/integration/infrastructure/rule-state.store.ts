import type Redis from 'ioredis';
import { redisKey } from '../../../shared/cache';
import type { RuleState } from '../domain/telemetry-rules';

/**
 * A vehicle's rule state as stored: after the event that produced it, and as it was before that event. The
 * outbox delivers at least once: an event handled again (its transaction did not commit) starts from `before`.
 */
export interface StoredRuleState {
  eventId: string;
  before: RuleState | null;
  after: RuleState;
}

/** Where the telemetry rules keep each vehicle's counters between pings (FMS-46). */
export interface RuleStateStore {
  load(vehiclePublicId: string): Promise<StoredRuleState | null>;
  save(vehiclePublicId: string, state: StoredRuleState): Promise<void>;
}

/** Counters older than this are dropped: a vehicle silent this long starts again (its pings are not consecutive anyway). */
export const RULE_STATE_TTL_SECONDS = 24 * 3600;

/** In process: without Redis, and when Redis fails. Lost on restart. */
export class MemoryRuleStateStore implements RuleStateStore {
  private readonly states = new Map<string, StoredRuleState>();

  async load(vehiclePublicId: string): Promise<StoredRuleState | null> {
    return this.states.get(vehiclePublicId) ?? null;
  }

  async save(vehiclePublicId: string, state: StoredRuleState): Promise<void> {
    this.states.set(vehiclePublicId, state);
  }
}

/**
 * In Redis (`<prefix>:state:integration:telemetry:<vehicle public id>`), so a restart or another instance carries
 * on counting. Redis is not the system of record (CONVENTIONS.md, Redis): if it fails, the counters go on in
 * process (`fallback`) and the failure is reported, so pings are still checked.
 */
export class RedisRuleStateStore implements RuleStateStore {
  constructor(
    private readonly redis: Redis,
    private readonly fallback: RuleStateStore,
    private readonly onError: (err: unknown, op: 'load' | 'save') => void,
  ) {}

  private key(vehiclePublicId: string): string {
    return redisKey('state', 'integration', 'telemetry', vehiclePublicId);
  }

  /** The newer of Redis's copy and this process's: after an outage Redis may hold counters older than ours. */
  async load(vehiclePublicId: string): Promise<StoredRuleState | null> {
    const local = await this.fallback.load(vehiclePublicId);
    let shared: StoredRuleState | null = null;
    try {
      const raw = await this.redis.get(this.key(vehiclePublicId));
      shared = raw ? (JSON.parse(raw) as StoredRuleState) : null;
    } catch (err) {
      this.onError(err, 'load');
    }
    if (!shared || !local) return shared ?? local;
    return (local.after.lastAt ?? 0) > (shared.after.lastAt ?? 0) ? local : shared;
  }

  async save(vehiclePublicId: string, state: StoredRuleState): Promise<void> {
    await this.fallback.save(vehiclePublicId, state);
    try {
      await this.redis.set(this.key(vehiclePublicId), JSON.stringify(state), 'EX', RULE_STATE_TTL_SECONDS);
    } catch (err) {
      this.onError(err, 'save');
    }
  }
}
