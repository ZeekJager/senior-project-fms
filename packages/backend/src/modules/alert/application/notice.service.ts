import type { PoolClient } from 'pg';
import type { DomainEvent } from '../../../shared/events/domain-event';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { APPEAL_NOTICE_TYPE, FEEDBACK_NOTICE_TYPE } from '../domain/delivery';
import type { NotificationRepository } from '../infrastructure/notification.repository';

/** What a driver is told of a step on their appeal (FMS-159), and whether by push too. Never a person's name. */
interface AppealNotice {
  title: string;
  message: string;
  push: boolean;
}

/** The appeal events a driver hears of: questions and decisions by push as well, a reviewer starting in the app. */
export const APPEAL_NOTICE_EVENTS = ['AppealClaimed', 'AppealCommented', 'AppealApproved', 'AppealRejected'] as const;

function noticeOf(event: DomainEvent): AppealNotice | null {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'AppealClaimed':
      return { title: 'Your appeal is being reviewed', message: 'A reviewer has started on your appeal. You will hear when it is decided.', push: false };
    case 'AppealCommented':
      // Only the reviewer's words: the driver knows what they wrote themselves.
      if (p.by !== 'reviewer') return null;
      return { title: 'A question about your appeal', message: 'The reviewer wrote in your appeal. Open it to read and answer.', push: true };
    case 'AppealApproved': {
      const before = typeof p.score_before === 'number' ? p.score_before : null;
      const after = typeof p.score_after === 'number' ? p.score_after : null;
      const corrected = before !== null && after !== null && before !== after ? ` Your score for the month went from ${before} to ${after}.` : '';
      return { title: 'Your appeal was approved', message: `The reviewer agreed and corrected your record.${corrected} Open it to read their note.`, push: true };
    }
    case 'AppealRejected':
      return { title: 'Your appeal was not approved', message: "The reviewer decided against it. Open it to read their note on why.", push: true };
    default:
      return null;
  }
}

/** The feedback events a driver hears of (FMS-158): new feedback in the app and by push, a correction in the app. */
export const FEEDBACK_NOTICE_EVENTS = ['FeedbackGiven', 'FeedbackEdited'] as const;

function feedbackNoticeOf(event: DomainEvent): AppealNotice | null {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'FeedbackGiven':
      return p.tone === 'praise'
        ? { title: 'Well done: new feedback', message: 'Your manager sent you praise. Open it in My feedback.', push: true }
        : { title: 'New feedback from your manager', message: 'Open it in My feedback to read it.', push: true };
    case 'FeedbackEdited':
      return { title: 'Feedback was corrected', message: 'Your manager corrected feedback they sent you. Open it to read it again.', push: false };
    default:
      return null;
  }
}

export interface NoticeServiceDeps {
  notifications: Pick<NotificationRepository, 'insertNotices'>;
  inbox: { announce(tx: PoolClient, userIds: readonly string[], reason: 'delivered', ctx: MutationContext): Promise<unknown> };
  delivery: { queueNotice(tx: PoolClient, ctx: MutationContext, recipients: readonly string[], content: { type: string; title: string; message: string }, entity: { type: string; id: string }): Promise<number> };
  drivers: {
    subject(db: Queryable, publicId: string): Promise<{ id: string } | null>;
    activeAccounts(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
}

/**
 * Notices that are no alert (FMS-159): a step on a driver's own appeal, in their inbox and, for a question or a
 * decision, by push. Each opens the appeal in the driver app. Runs in the consumer's transaction, so a redelivered
 * event, skipped as already handled, never tells them twice.
 */
export class NoticeService {
  constructor(private readonly deps: NoticeServiceDeps) {}

  async appealStep(tx: PoolClient, event: DomainEvent): Promise<number> {
    const p = event.payload as Record<string, unknown>;
    if (typeof p.appeal_id !== 'string') return 0;
    return this.tell(tx, event, noticeOf(event), APPEAL_NOTICE_TYPE, { type: 'appeal', id: p.appeal_id });
  }

  /** Feedback given or corrected (FMS-158): in the inbox, and new feedback by push. Never by email or SMS. */
  async feedbackStep(tx: PoolClient, event: DomainEvent): Promise<number> {
    const p = event.payload as Record<string, unknown>;
    if (typeof p.feedback_id !== 'string') return 0;
    return this.tell(tx, event, feedbackNoticeOf(event), FEEDBACK_NOTICE_TYPE, { type: 'feedback', id: p.feedback_id });
  }

  private async tell(tx: PoolClient, event: DomainEvent, notice: AppealNotice | null, type: string, entity: { type: string; id: string }): Promise<number> {
    const p = event.payload as Record<string, unknown>;
    if (!notice || typeof p.driver_id !== 'string') return 0;
    const driver = await this.deps.drivers.subject(tx, p.driver_id);
    if (!driver) return 0;
    const userId = (await this.deps.drivers.activeAccounts(tx, [String(driver.id)])).get(String(driver.id));
    if (!userId) return 0;
    const ctx: MutationContext = { userId: null, correlationId: event.correlation_id };
    const content = { type, title: notice.title, message: notice.message };
    const told = await this.deps.notifications.insertNotices(tx, ctx, [userId], content, entity);
    if (told > 0) await this.deps.inbox.announce(tx, [userId], 'delivered', ctx);
    if (notice.push) await this.deps.delivery.queueNotice(tx, ctx, [userId], content, entity);
    return told;
  }
}
