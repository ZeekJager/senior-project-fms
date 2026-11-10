/** Summaries and budget checks for the load suite (FMS-61). Pure, so they are unit-tested. */

export interface Summary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** The nearest-rank percentile of ascending samples: the smallest value with at least p% of samples at or below it. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(rank, 1)) - 1];
}

const round = (n: number) => Math.round(n * 10) / 10;

export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: round(sorted[0]),
    mean: round(sum / sorted.length),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]),
  };
}

export interface Check {
  name: string;
  actual: number;
  /** `<`: the actual must be under the limit; `<=`: at or under it. */
  op: '<' | '<=';
  limit: number;
  unit: string;
  passed: boolean;
}

export function check(name: string, actual: number, op: Check['op'], limit: number, unit: string): Check {
  return { name, actual, op, limit, unit, passed: op === '<' ? actual < limit : actual <= limit };
}

/** Requests grouped by their label (e.g. `GET /trips`), with their durations and failures. */
export class Recorder {
  private readonly durations = new Map<string, number[]>();
  private readonly failures = new Map<string, Map<string, number>>();

  record(label: string, ms: number, ok: boolean, outcome: string): void {
    if (!this.durations.has(label)) this.durations.set(label, []);
    this.durations.get(label)!.push(ms);
    if (ok) return;
    if (!this.failures.has(label)) this.failures.set(label, new Map());
    const byOutcome = this.failures.get(label)!;
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
  }

  labels(): string[] {
    return [...this.durations.keys()].sort();
  }

  samples(label: string): number[] {
    return this.durations.get(label) ?? [];
  }

  /** Failed requests, by label and outcome (an HTTP status, or `network`). */
  errors(): Record<string, Record<string, number>> {
    return Object.fromEntries([...this.failures].map(([label, outcomes]) => [label, Object.fromEntries(outcomes)]));
  }

  errorCount(): number {
    return [...this.failures.values()].reduce((n, outcomes) => n + [...outcomes.values()].reduce((a, b) => a + b, 0), 0);
  }

  /** Each label's summary, and its requests per second over `seconds`. */
  table(seconds: number): Record<string, Summary & { perSecond: number }> {
    return Object.fromEntries(
      this.labels().map((label) => {
        const s = summarize(this.samples(label));
        return [label, { ...s, perSecond: round(s.count / Math.max(seconds, 1)) }];
      }),
    );
  }
}
