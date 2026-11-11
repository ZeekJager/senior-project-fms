/**
 * The API process's CPU and event-loop lag during a scenario (FMS-61), read from its own Prometheus endpoint
 * (docs/metrics.md: prom-client's default metrics). Reading the server's numbers keeps the load generator's CPU out of
 * them, and needs no tool on the machine.
 */
import { summarize, type Summary } from './stats';

/**
 * The value of the first sample of `name` in Prometheus' text format, labelled or not (the API's registry adds
 * `service` to every metric: `process_cpu_seconds_total{service="fms-backend"} 12.5`); undefined when absent.
 */
export function sampleValue(text: string, name: string): number | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const rest = line.slice(name.length);
    if (rest[0] !== '{' && rest[0] !== ' ' && rest[0] !== '\t') continue;
    const value = rest.slice(rest[0] === '{' ? rest.indexOf('}') + 1 : 0).trim().split(/\s+/)[0];
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** CPU as a share of one core between two readings of process_cpu_seconds_total. */
export function cpuPercent(cpuSecondsBefore: number, cpuSecondsAfter: number, wallMs: number): number {
  if (wallMs <= 0) return 0;
  return Math.max(0, ((cpuSecondsAfter - cpuSecondsBefore) * 1000 * 100) / wallMs);
}

export interface ServerLoad {
  /** Readings that failed, with the last reason. */
  missed: number;
  lastError: string | null;
  /** CPU, % of one core, per sample interval. */
  cpuPct: Summary;
  /** Event-loop lag p99 as Node reports it, milliseconds, per sample. */
  eventLoopLagP99Ms: Summary;
  samples: number;
}

/** Samples the API's metrics every `everyMs` until stopped. */
export class ServerSampler {
  private readonly cpu: number[] = [];
  private readonly lag: number[] = [];
  private last: { at: number; cpuSeconds: number } | null = null;
  private missed = 0;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly metricsUrl: string,
    private readonly everyMs = 5000,
  ) {}

  private async read(): Promise<void> {
    try {
      const res = await fetch(this.metricsUrl);
      const text = await res.text();
      const at = performance.now();
      const cpuSeconds = sampleValue(text, 'process_cpu_seconds_total');
      const lagSeconds = sampleValue(text, 'nodejs_eventloop_lag_p99_seconds');
      if (cpuSeconds !== undefined) {
        if (this.last) this.cpu.push(cpuPercent(this.last.cpuSeconds, cpuSeconds, at - this.last.at));
        this.last = { at, cpuSeconds };
      }
      if (lagSeconds !== undefined) this.lag.push(lagSeconds * 1000);
    } catch (err) {
      // A missed sample is a gap, reported; a budget nothing was measured against fails on its own (report.ts).
      this.missed++;
      this.lastError = err instanceof Error ? `${err.message}${err.cause ? `: ${String(err.cause)}` : ''}` : String(err);
    }
  }

  async start(): Promise<void> {
    await this.read();
    this.timer = setInterval(() => void this.read(), this.everyMs);
  }

  async stop(): Promise<ServerLoad> {
    if (this.timer) clearInterval(this.timer);
    await this.read();
    return { missed: this.missed, lastError: this.lastError, cpuPct: summarize(this.cpu), eventLoopLagP99Ms: summarize(this.lag), samples: this.cpu.length };
  }
}
