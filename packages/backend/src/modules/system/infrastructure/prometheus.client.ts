// Prometheus' HTTP query API (FMS-163, docs/observability.md), or VictoriaMetrics', which speaks the same: the API
// reads the metrics history from it for the Resources tab and the capacity report. The browser never calls it.

export interface Series {
  labels: Record<string, string>;
  /** [unix seconds, value] */
  values: [number, number][];
}

export interface PrometheusClient {
  /** The latest value of each series. */
  instant(query: string): Promise<{ labels: Record<string, string>; value: number; at: number }[]>;
  range(query: string, startSeconds: number, endSeconds: number, stepSeconds: number): Promise<Series[]>;
}

export class PrometheusUnavailable extends Error {}

const TIMEOUT_MS = 5000;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** A client for `baseUrl` (no trailing slash). Each call times out after 5 s. */
export function prometheusClient(baseUrl: string, fetchImpl: typeof fetch = fetch): PrometheusClient {
  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${baseUrl}${path}?${new URLSearchParams(params)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    } catch {
      throw new PrometheusUnavailable('The metrics store could not be reached.');
    }
    if (!res.ok) throw new PrometheusUnavailable(`The metrics store answered ${res.status}.`);
    const body = (await res.json()) as { status?: string; data?: { resultType?: string; result?: unknown[] } };
    if (body.status !== 'success' || !body.data) throw new PrometheusUnavailable('The metrics store refused the query.');
    return body.data.result ?? [];
  }
  return {
    async instant(query) {
      const result = (await get('/api/v1/query', { query })) as { metric: Record<string, string>; value: [number, string] }[];
      return result.map((r) => ({ labels: r.metric, value: num(r.value[1]), at: Number(r.value[0]) }));
    },
    async range(query, start, end, step) {
      const result = (await get('/api/v1/query_range', { query, start: String(start), end: String(end), step: String(step) })) as { metric: Record<string, string>; values: [number, string][] }[];
      return result.map((r) => ({ labels: r.metric, values: r.values.map(([t, v]) => [Number(t), num(v)] as [number, number]).filter(([, v]) => !Number.isNaN(v)) }));
    },
  };
}
