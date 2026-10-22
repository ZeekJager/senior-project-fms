import { z } from 'zod';
import type { ProviderSecrets } from '../../../config/schema';
import type { AdapterContext, ProviderAdapter, ProviderType } from '../domain/adapter';
import type { CircuitView } from '../domain/provider';
import type { ProviderRow } from '../infrastructure/integration.repository';
import { DEFAULT_BREAKER, ProviderBreaker, type BreakerLog, type BreakerSettings } from './circuit-breaker';
import { DEFAULT_CLIENT, HttpProviderClient, type ClientSettings } from './http-client';

/**
 * Settings a provider row may carry in `configuration` (never secrets). Anything else in it is the
 * adapter's own (`ctx.provider.configuration`).
 */
const providerSettings = z.object({
  timeout_ms: z.number().int().min(10).max(60_000).optional(),
  max_retries: z.number().int().min(0).max(5).optional(),
  reset_timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
});

export interface ProviderSettings {
  client: ClientSettings;
  breaker: BreakerSettings;
}

export interface HealthResult {
  checked_at: Date;
  healthy: boolean;
  error: string | null;
}

/**
 * The providers this build can talk to (FMS-85): adapters registered in code, matched by `code` to
 * the rows of integration.external_providers, each with its own breaker and its secrets from the
 * environment. Breakers live in this process: each API instance trips on its own.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly byType = new Map<ProviderType, (code: string) => ProviderAdapter>();
  private readonly breakers = new Map<string, { settings: string; breaker: ProviderBreaker }>();
  private readonly health = new Map<string, HealthResult>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly secrets: Record<string, ProviderSecrets>,
    private readonly log: BreakerLog,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** Adds a provider integration. One adapter per code. */
  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.code)) throw new Error(`An adapter for provider '${adapter.code}' is already registered.`);
    this.adapters.set(adapter.code, adapter);
  }

  /** The adapter every provider of a type uses unless one is registered for its code (FMS-88: the FMS telematics format). */
  registerForType(type: ProviderType, make: (code: string) => ProviderAdapter): void {
    this.byType.set(type, make);
  }

  /** The provider's own adapter, else its type's, else none. */
  adapterFor(provider: Pick<ProviderRow, 'code' | 'providerType'>): ProviderAdapter | undefined {
    return this.adapters.get(provider.code) ?? this.byType.get(provider.providerType)?.(provider.code);
  }

  secretsFor(code: string): ProviderSecrets {
    return this.secrets[code] ?? {};
  }

  /** Defaults, overridden by the row's `configuration`; settings that are out of range are ignored, once logged. */
  settingsFor(provider: ProviderRow): ProviderSettings {
    const parsed = providerSettings.safeParse(provider.configuration);
    if (!parsed.success && !this.warned.has(provider.code)) {
      this.warned.add(provider.code);
      this.log.warn({ provider: provider.code, event: 'integration.invalid_settings' }, 'Provider settings out of range; using defaults');
    }
    const s = parsed.success ? parsed.data : {};
    return {
      client: { ...DEFAULT_CLIENT, timeoutMs: s.timeout_ms ?? DEFAULT_CLIENT.timeoutMs, maxRetries: s.max_retries ?? DEFAULT_CLIENT.maxRetries },
      breaker: { ...DEFAULT_BREAKER, resetTimeoutMs: s.reset_timeout_ms ?? DEFAULT_BREAKER.resetTimeoutMs },
    };
  }

  /** The provider's breaker, made on first use; a new one if its settings changed. */
  breakerFor(provider: ProviderRow): ProviderBreaker {
    const settings = this.settingsFor(provider).breaker;
    const key = JSON.stringify(settings);
    const current = this.breakers.get(provider.id);
    if (current?.settings === key) return current.breaker;
    current?.breaker.shutdown();
    const breaker = new ProviderBreaker(provider.code, settings, this.log);
    this.breakers.set(provider.id, { settings: key, breaker });
    return breaker;
  }

  /** The breaker's state, or null while this instance has not called the provider. */
  circuitOf(provider: ProviderRow): CircuitView | null {
    return this.breakers.get(provider.id)?.breaker.view() ?? null;
  }

  /** What an adapter gets for one operation: a client behind the provider's breaker, and its API key. */
  context(provider: ProviderRow, correlationId: string): AdapterContext {
    const client = new HttpProviderClient({
      code: provider.code,
      baseUrl: provider.baseUrl,
      settings: this.settingsFor(provider).client,
      breaker: this.breakerFor(provider),
      correlationId,
      fetch: this.fetchImpl,
    });
    return {
      client,
      provider: { code: provider.code, type: provider.providerType, baseUrl: provider.baseUrl, configuration: provider.configuration },
      apiKey: this.secretsFor(provider.code).apiKey,
      correlationId,
    };
  }

  recordHealth(provider: ProviderRow, result: HealthResult): void {
    this.health.set(provider.id, result);
  }

  healthOf(provider: ProviderRow): HealthResult | null {
    return this.health.get(provider.id) ?? null;
  }

  /** For /health/ready (counts only): providers called on this instance, and how many are open or half-open. */
  metrics(): Record<string, number> {
    const states = [...this.breakers.values()].map((b) => b.breaker.state);
    return {
      providers_called: states.length,
      circuits_open: states.filter((s) => s === 'open').length,
      circuits_half_open: states.filter((s) => s === 'half_open').length,
    };
  }

  /** Stops every breaker's timers (shutdown, tests). */
  shutdown(): void {
    for (const { breaker } of this.breakers.values()) breaker.shutdown();
    this.breakers.clear();
  }
}
