import type Redis from 'ioredis';
import { isReady } from '../cache/redis';
import type { JobClaim, JobLock } from './job-lock';

/** Deletes the lease only if this run still holds it (a successor may have taken an expired one). */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * The job lock in Redis (FMS-72), in front of the run history: a lease
 * (SET NX PX) decides which instance runs, with no PostgreSQL round trip for
 * the ones that lose. The winner still claims the jobs.job_runs row, which
 * stays the durable once-per-day guarantee: a Redis restart forgets leases,
 * not runs. Redis down or failing: the PostgreSQL lock alone, as before.
 */
export class RedisJobLock implements JobLock {
  constructor(
    private readonly client: Redis,
    private readonly runs: JobLock,
    private readonly keyFor: (jobName: string, runKey: string) => string,
  ) {}

  async claim(input: Parameters<JobLock['claim']>[0]): Promise<JobClaim | null> {
    const key = this.keyFor(input.jobName, input.runKey);
    let leased = false;
    if (isReady(this.client)) {
      try {
        if ((await this.client.set(key, input.correlationId, 'PX', input.leaseMs, 'NX')) !== 'OK') return null;
        leased = true;
      } catch {
        // Redis failing: PostgreSQL decides alone.
      }
    }
    const claim = await this.runs.claim(input).catch(async (err: unknown) => {
      if (leased) await this.release(key, input.correlationId);
      throw err;
    });
    if (!claim && leased) await this.release(key, input.correlationId);
    return claim;
  }

  async succeed(claim: JobClaim, result: Record<string, unknown>): Promise<void> {
    await this.runs.succeed(claim, result);
    await this.release(this.keyFor(claim.jobName, claim.runKey), claim.correlationId);
  }

  async fail(claim: JobClaim, error: string): Promise<void> {
    await this.runs.fail(claim, error);
    await this.release(this.keyFor(claim.jobName, claim.runKey), claim.correlationId);
  }

  private async release(key: string, token: string): Promise<void> {
    if (!isReady(this.client)) return;
    await this.client.eval(RELEASE, 1, key, token).catch(() => {});
  }
}
