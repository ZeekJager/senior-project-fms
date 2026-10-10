import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where an action came from (architecture §14.2): the browser app, the
 * installed driver app, a scheduled job, an inbound webhook, or a script
 * (seed, user:create) or test running outside any of them.
 */
export const CHANNELS = ['web', 'pwa', 'job', 'webhook', 'script'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Stored as audit.audit_logs.request_source. */
export interface RequestSource {
  channel: Channel;
  ip?: string | null;
  user_agent?: string | null;
  /** 'system' for scheduled jobs: no user acted. */
  actor?: 'system';
  /** The job's name, for a job run. */
  job?: string;
}

const USER_AGENT_MAX = 512;
const storage = new AsyncLocalStorage<RequestSource>();

/** Runs `fn` (and everything it awaits) with this source; audit rows written inside record it. */
export function withRequestSource<T>(source: RequestSource, fn: () => T): T {
  return storage.run({ ...source, user_agent: source.user_agent?.slice(0, USER_AGENT_MAX) ?? source.user_agent }, fn);
}

/** The current source; outside a request or job, a script. */
export function currentRequestSource(): RequestSource {
  return storage.getStore() ?? { channel: 'script' };
}

/** The system actor of a scheduled job. */
export function jobSource(jobName: string): RequestSource {
  return { channel: 'job', actor: 'system', job: jobName };
}
