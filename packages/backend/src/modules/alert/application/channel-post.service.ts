import type { PoolClient } from 'pg';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import { alertPath, MAX_DELIVERY_ATTEMPTS, nextAttemptAt } from '../domain/delivery';
import type { AlertRepository, ChannelPostRow } from '../infrastructure/alert.repository';

/** What the gateway's send needs for a post to a channel with no recipient. */
export interface ChannelSender {
  send(
    message: { channel: 'teams'; reference: string; to: Record<string, never>; subject: string; text: string; data?: Record<string, unknown>; urgency: 'normal' | 'high'; ttlSeconds: number },
    correlationId: string,
  ): Promise<{ status: 'sent' | 'refused' | 'paused' | 'failed'; providerId?: string | null; message?: string; retryable?: boolean }>;
  channels(): Promise<Set<string>>;
}

export interface ChannelPostDeps {
  repo: Pick<AlertRepository, 'inTransaction' | 'dueChannelPosts' | 'markChannelPost'>;
  gateway: ChannelSender;
  /** The web app's address, for the card's button; none without it. */
  appUrl: string | null;
}

const BATCH = 20;

/**
 * Monitoring alerts posted to the operations channel (FMS-163, docs/observability.md): a Teams card when one opens and
 * again when it resolves, each once. Attempts and backoff as the other channels' (MAX_DELIVERY_ATTEMPTS). With Teams
 * off (no provider), posts wait: they go out once it is set up, unless they fail for good first.
 */
export class ChannelPostService {
  constructor(private readonly deps: ChannelPostDeps) {}

  async drain(run: { now: Date; correlationId: string }): Promise<{ sent: number; failed: number; waiting: number }> {
    const { repo, gateway } = this.deps;
    const result = { sent: 0, failed: 0, waiting: 0 };
    if (!(await gateway.channels()).has('teams')) return result;
    for (;;) {
      const handled = await repo.inTransaction(async (client) => {
        const due = await repo.dueChannelPosts(client, run.now, BATCH);
        for (const post of due) await this.send(client, post, run, result);
        return due.length;
      });
      if (handled < BATCH) return result;
    }
  }

  private async send(client: PoolClient, post: ChannelPostRow, run: { now: Date; correlationId: string }, result: { sent: number; failed: number; waiting: number }): Promise<void> {
    const ctx: MutationContext = { userId: null, correlationId: run.correlationId };
    const resolved = post.kind === 'resolved';
    const url = this.deps.appUrl ? `${this.deps.appUrl.replace(/\/+$/, '')}${alertPath(post.entityType, post.entityId)}` : null;
    const outcome = await this.deps.gateway.send(
      {
        channel: 'teams',
        reference: post.publicId,
        to: {},
        subject: resolved ? `Resolved: ${post.title}` : post.title,
        text: resolved ? 'The limit is no longer passed; the alert closed by itself.' : (post.message ?? ''),
        data: url ? { url } : {},
        urgency: post.severity === 'critical' && !resolved ? 'high' : 'normal',
        ttlSeconds: 3600,
      },
      run.correlationId,
    );
    const attempts = post.attempts + 1;
    if (outcome.status === 'sent') {
      await this.deps.repo.markChannelPost(client, ctx, post.id, { status: 'sent', attempts, sent_at: run.now, provider_id: outcome.providerId ?? null, last_error: null });
      result.sent += 1;
      return;
    }
    if (outcome.status === 'paused') {
      await this.deps.repo.markChannelPost(client, ctx, post.id, { next_attempt_at: new Date(run.now.getTime() + 60_000), last_error: (outcome.message ?? '').slice(0, 500) });
      result.waiting += 1;
      return;
    }
    const next = outcome.status === 'failed' && outcome.retryable !== false ? nextAttemptAt(attempts, run.now) : null;
    if (next && attempts < MAX_DELIVERY_ATTEMPTS) {
      await this.deps.repo.markChannelPost(client, ctx, post.id, { attempts, next_attempt_at: next, last_error: (outcome.message ?? '').slice(0, 500) });
      result.waiting += 1;
    } else {
      await this.deps.repo.markChannelPost(client, ctx, post.id, { status: 'failed', attempts, last_error: (outcome.message ?? '').slice(0, 500) });
      result.failed += 1;
    }
  }
}
