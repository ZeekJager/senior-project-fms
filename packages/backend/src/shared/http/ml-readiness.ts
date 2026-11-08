import type { DependencyState } from '../cache/cache';
import type { OptionalDependency } from './health';

/** How long one answer of the AI service stands: a load balancer polls readiness often, and the AI service is not its business to hammer. */
export const ML_READINESS_TTL_MS = 5_000;
const ML_TIMEOUT_MS = 1_500;

export interface MlReadinessOptions {
  /** The AI service's base URL; null when it is not configured (ML_SERVICE_URL). */
  url: string | null;
  fetcher?: typeof fetch;
  now?: () => number;
}

/**
 * The AI service in /health/ready (FMS-75): its own `GET /health`, kept for a few seconds. Not configured, it is `disabled`.
 * Whether it being down is a reason for 503 or only `degraded` is decided where it is mounted (READINESS_ML_CRITICAL).
 */
export function mlReadiness(options: MlReadinessOptions): OptionalDependency {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let last: { at: number; error: Error | null } | null = null;

  return {
    state: (): DependencyState => (options.url ? 'ok' : 'disabled'),
    async ping() {
      if (!options.url) return;
      if (!last || now() - last.at > ML_READINESS_TTL_MS) {
        let error: Error | null = null;
        try {
          const res = await fetcher(`${options.url}/health`, { signal: AbortSignal.timeout(ML_TIMEOUT_MS) });
          if (!res.ok) error = new Error(`the AI service answered ${res.status}`);
        } catch (err) {
          error = err instanceof Error ? err : new Error(String(err));
        }
        last = { at: now(), error };
      }
      if (last.error) throw last.error;
    },
  };
}
