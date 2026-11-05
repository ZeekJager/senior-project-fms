import type { DependencyState } from '../../../shared/cache';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { CORE_COMPONENTS, providerComponent } from '../domain/health';
import type { Probe } from '../application/health-sampler';

/** A dependency the API can run without: `disabled` when it is not configured (Redis, the read replica). */
export interface OptionalCheck {
  state(): DependencyState;
  ping(): Promise<unknown>;
}

/** An active provider's circuit breaker on this instance (FMS-85). */
export interface ProviderCircuit {
  code: string;
  name: string;
  state: 'closed' | 'open' | 'half_open';
  /** The mean latency of the calls in its window; null with none. */
  latencyMeanMs: number | null;
}

export interface ProbeSources {
  database: Queryable;
  replica: OptionalCheck;
  redis: OptionalCheck;
  /** This instance's own `GET /health/live`, over HTTP; null to count the API up without a request (tests). */
  apiUrl: string | null;
  /** The AI service's base URL; null when ML_SERVICE_URL is not set. */
  aiServiceUrl: string | null;
  circuits: () => Promise<ProviderCircuit[]>;
  fetch?: typeof fetch;
}

const label = (component: (typeof CORE_COMPONENTS)[number]['component']) => CORE_COMPONENTS.find((c) => c.component === component)!.label;

/** "fetch failed: ECONNREFUSED" rather than undici's bare "fetch failed". */
function fetchError(err: unknown): Error {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return new Error(detail ? `${(err as Error).message}: ${detail}` : (err as Error).message);
}

async function get(fetcher: typeof fetch, url: string, what: string): Promise<void> {
  let res: Response;
  try {
    res = await fetcher(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw fetchError(err);
  }
  await res.body?.cancel();
  if (!res.ok) throw new Error(`${what} answered ${res.status}`);
}

function optional(component: 'replica' | 'redis', dep: OptionalCheck): Probe {
  return {
    component,
    label: label(component),
    async check() {
      if (dep.state() === 'disabled') return { disabled: true };
      await dep.ping();
      return {};
    },
  };
}

/**
 * The checks the sampler runs each minute (FMS-143): the API answering HTTP, the database, the read replica
 * (down when unreachable or too far behind), Redis, the AI service's `/health`, and each active provider's
 * circuit, down while it is open or half-open (opened, and no call has got through since).
 */
export function standardProbes(src: ProbeSources): () => Promise<Probe[]> {
  const fetcher = src.fetch ?? fetch;
  const fixed: Probe[] = [
    {
      component: 'api',
      label: label('api'),
      async check() {
        if (!src.apiUrl) return { latencyMs: null };
        await get(fetcher, src.apiUrl, 'The API');
        return {};
      },
    },
    {
      component: 'database',
      label: label('database'),
      async check() {
        await src.database.query('SELECT 1');
      },
    },
    optional('replica', src.replica),
    optional('redis', src.redis),
    {
      component: 'ai_service',
      label: label('ai_service'),
      async check() {
        if (!src.aiServiceUrl) return { disabled: true };
        await get(fetcher, `${src.aiServiceUrl}/health`, 'The AI service');
        return {};
      },
    },
  ];
  return async () => {
    const circuits = await src.circuits();
    return [
      ...fixed,
      ...circuits.map((c): Probe => ({
        component: providerComponent(c.code),
        label: c.name,
        async check() {
          if (c.state === 'open') throw new Error('Circuit open: calls are paused after repeated failures');
          if (c.state === 'half_open') throw new Error('Circuit half-open: no call has got through since it opened');
          return { latencyMs: c.latencyMeanMs };
        },
      })),
    ];
  };
}
