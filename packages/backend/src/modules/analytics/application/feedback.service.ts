import type { PoolClient } from 'pg';
import { depotScope } from '../../../shared/authz/scope';
import { AppError, validationFailed } from '../../../shared/errors/app-error';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { monthOf } from '../domain/appeal';
import {
  COUNT_DAYS,
  EDIT_WINDOW_MS,
  FEEDBACK_EVENTS,
  UNACKNOWLEDGED_DAYS,
  abilities,
  alreadyReplied,
  canEdit,
  editLocked,
  feedbackNotFound,
  otherDepot,
  retentionCutoff,
  retracted,
  templateNotFound,
  unacknowledgedTooLong,
  type FeedbackAbilities,
  type FeedbackSubject,
  type FeedbackTone,
} from '../domain/feedback';
import type { AppealDriver } from '../infrastructure/appeal.repository';
import type { FeedbackRepository, FeedbackRow, TemplateRow } from '../infrastructure/feedback.repository';
import type { Caller, MonthScore } from './appeal.service';

export interface FeedbackServiceDeps {
  repo: FeedbackRepository;
  events: EventBus;
  /** The categories in use (the feedback_categories parameter, FMS-157) and how long items are kept. */
  rules: () => Promise<{ categories: readonly string[]; retentionMonths: number }>;
  /** The driver's score for a month (`YYYY-MM`): recorded with feedback on that month. */
  score: (db: Queryable, driverUserId: string, month: string) => Promise<MonthScore>;
  /** User accounts by internal id (auth): authors, retractors and editors by name. */
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]> };
  now?: () => Date;
}

export interface GiveInput {
  subject_type: FeedbackSubject;
  trip_id?: string;
  month?: string;
  category: string;
  tone: FeedbackTone;
  message: string;
}

export interface FeedbackQuery {
  category?: string;
  tone?: FeedbackTone;
  page: number;
  page_size: number;
}

export interface TemplateInput {
  category: string;
  title: string;
  body: string;
}

type Person = { id: string; name: string } | null;

/** An item as the driver reads it: no retraction, no earlier texts. */
export interface DriverFeedbackView {
  id: string;
  subject: { type: FeedbackSubject; trip_id: string | null; month: string | null; score_shown: number | null };
  category: string;
  tone: FeedbackTone;
  message: string;
  from: Person;
  given_at: string;
  edited_at: string | null;
  acknowledged_at: string | null;
  reply: string | null;
  replied_at: string | null;
  can: FeedbackAbilities;
}

/** An item as a manager reads it: who gave and retracted it, and every earlier text. */
export interface FeedbackView extends DriverFeedbackView {
  driver: Person;
  depot: Person;
  editable_until: string;
  retracted_at: string | null;
  retracted_by: Person;
  retraction_reason: string | null;
  /** Live, never acknowledged, given 7 or more days ago. */
  unacknowledged_overdue: boolean;
  revisions: { message: string; revised_by: Person; at: string }[];
  version: number;
}

export interface TemplateView {
  id: string;
  category: string;
  title: string;
  body: string;
  updated_at: string;
  version: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const RETENTION_BATCH = 500;
const RETENTION_MAX_BATCHES = 200;

/**
 * Admin-to-driver feedback (FMS-158, docs/driver-feedback.md). A manager (feedback:write) of the driver's depot gives
 * feedback on a trip, a month (recording the score then shown) or overall; the driver is told in the app and by push,
 * reads it, acknowledges it and may reply once. Its author may correct it for 24 hours (the earlier text kept); after
 * that it is only retracted, with a reason: gone for the driver, kept for the managers and the audit. Every step is
 * audited and published as an event without the words.
 */
export class FeedbackService {
  private readonly now: () => Date;

  constructor(private readonly deps: FeedbackServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // Managers -------------------------------------------------------------------------------------------------------

  /** POST /drivers/{id}/feedback. */
  async give(caller: Caller, driverPublicId: string, input: GiveInput): Promise<FeedbackView> {
    const { repo } = this.deps;
    const db = repo.pool();
    const driver = await this.managedDriver(db, caller, driverPublicId);
    await this.assertCategory(input.category);
    const now = this.now();
    const subject = await this.subject(db, driver, input, now);
    return repo.inTransaction(async (client) => {
      const ctx = this.ctx(caller);
      const row = await repo.insert(
        ctx,
        {
          driver_id: driver.driverId,
          depot_id: driver.depotId,
          subject_type: input.subject_type,
          trip_id: subject.tripId,
          score_month: subject.month ? `${subject.month}-01` : null,
          score_shown: subject.scoreShown,
          category: input.category,
          tone: input.tone,
          message: input.message,
          author_id: caller.user.id,
          editable_until: new Date(now.getTime() + EDIT_WINDOW_MS),
        },
        client,
      );
      const item = (await repo.findById(client, String(row.id)))!;
      await this.publish(client, caller, FEEDBACK_EVENTS.given, item, driver);
      return (await this.managerViews(client, caller, [item]))[0];
    });
  }

  /** GET /drivers/{id}/feedback: newest first, by category and tone, with the 90 days' counts per category. */
  async forDriver(
    caller: Caller,
    driverPublicId: string,
    query: FeedbackQuery,
  ): Promise<{ items: FeedbackView[]; total: number; counts: { days: number; by_category: Record<string, number>; unacknowledged_overdue: number } }> {
    const { repo } = this.deps;
    const db = repo.pool();
    const driver = await this.managedDriver(db, caller, driverPublicId);
    const { rows, total } = await repo.list(db, {
      driverId: driver.driverId,
      category: query.category,
      tone: query.tone,
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    const now = this.now();
    const counts = await repo.counts(db, driver.driverId, new Date(now.getTime() - COUNT_DAYS * 86_400_000), new Date(now.getTime() - UNACKNOWLEDGED_DAYS * 86_400_000));
    return { items: await this.managerViews(db, caller, rows), total, counts: { days: COUNT_DAYS, by_category: counts.byCategory, unacknowledged_overdue: counts.unacknowledged } };
  }

  /** GET /feedback/{id}. */
  async get(caller: Caller, publicId: string): Promise<FeedbackView> {
    const db = this.deps.repo.pool();
    const item = await this.managedItem(db, caller, publicId);
    return (await this.managerViews(db, caller, [item]))[0];
  }

  /** PATCH /feedback/{id}: its author corrects the message within 24 hours; the earlier text is kept. */
  async edit(caller: Caller, publicId: string, message: string): Promise<FeedbackView> {
    return this.managerStep(caller, publicId, async (client, item, ctx) => {
      if (item.retractedAt) throw retracted();
      if (item.authorId !== String(caller.user.id)) throw new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Only its author can correct feedback.');
      if (!canEdit(item, String(caller.user.id), this.now())) throw editLocked();
      if (message === item.message) return null;
      await this.deps.repo.addRevision(ctx, item.id, item.message, client);
      await this.deps.repo.update(ctx, item.id, { message, edited_at: this.now() }, client);
      return FEEDBACK_EVENTS.edited;
    });
  }

  /** POST /feedback/{id}/retract: gone for the driver; kept, with the reason, for the managers and the audit. */
  async retract(caller: Caller, publicId: string, reason: string): Promise<FeedbackView> {
    return this.managerStep(caller, publicId, async (client, item, ctx) => {
      if (item.retractedAt) throw retracted();
      await this.deps.repo.update(ctx, item.id, { retracted_at: this.now(), retracted_by: caller.user.id, retraction_reason: reason }, client);
      return FEEDBACK_EVENTS.retracted;
    });
  }

  // The driver -----------------------------------------------------------------------------------------------------

  /** GET /driver/feedback: the signed-in driver's live items, newest first. */
  async mine(caller: Caller, page: { page: number; page_size: number }): Promise<{ items: DriverFeedbackView[]; total: number; unacknowledged: number }> {
    const { repo } = this.deps;
    const db = repo.pool();
    const driver = await this.ownDriver(db, caller);
    const { rows, total } = await repo.list(db, { driverId: driver.driverId, live: true, limit: page.page_size, offset: (page.page - 1) * page.page_size });
    const counts = await repo.counts(db, driver.driverId, new Date(0), this.now());
    return { items: await this.driverViews(db, caller, rows), total, unacknowledged: counts.unacknowledged };
  }

  /** GET /driver/feedback/{id}: one of the driver's live items. */
  async mineOne(caller: Caller, publicId: string): Promise<DriverFeedbackView> {
    const db = this.deps.repo.pool();
    const item = await this.ownItem(db, caller, publicId);
    return (await this.driverViews(db, caller, [item]))[0];
  }

  /** POST /driver/feedback/{id}/acknowledge: "Got it". Once; again changes nothing. */
  async acknowledge(caller: Caller, publicId: string): Promise<DriverFeedbackView> {
    return this.driverStep(caller, publicId, async (client, item, ctx) => {
      if (item.acknowledgedAt) return null;
      await this.deps.repo.update(ctx, item.id, { acknowledged_at: this.now() }, client);
      return FEEDBACK_EVENTS.acknowledged;
    });
  }

  /** POST /driver/feedback/{id}/reply: one reply; it acknowledges the item too. */
  async reply(caller: Caller, publicId: string, body: string): Promise<DriverFeedbackView> {
    return this.driverStep(caller, publicId, async (client, item, ctx) => {
      if (item.repliedAt) throw alreadyReplied();
      const now = this.now();
      await this.deps.repo.update(ctx, item.id, { reply: body, replied_at: now, ...(item.acknowledgedAt ? {} : { acknowledged_at: now }) }, client);
      return FEEDBACK_EVENTS.replied;
    });
  }

  // Templates ------------------------------------------------------------------------------------------------------

  async templates(category?: string): Promise<TemplateView[]> {
    return (await this.deps.repo.templates(this.deps.repo.pool(), category)).map(templateView);
  }

  async createTemplate(caller: Caller, input: TemplateInput): Promise<TemplateView> {
    await this.assertCategory(input.category);
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const row = await repo.insertTemplate(this.ctx(caller), { category: input.category, title: input.title, body: input.body, created_by: caller.user.id, updated_by: caller.user.id }, client);
      return templateView((await repo.template(client, String(row.public_id)))!);
    });
  }

  async updateTemplate(caller: Caller, publicId: string, input: Partial<TemplateInput>): Promise<TemplateView> {
    if (input.category !== undefined) await this.assertCategory(input.category);
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const t = await repo.template(client, publicId, true);
      if (!t) throw templateNotFound();
      const changes = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      if (Object.keys(changes).length) await repo.updateTemplate(this.ctx(caller), t.id, { ...changes, updated_by: caller.user.id }, client);
      return templateView((await repo.template(client, publicId))!);
    });
  }

  async deleteTemplate(caller: Caller, publicId: string): Promise<void> {
    const { repo } = this.deps;
    await repo.inTransaction(async (client) => {
      const t = await repo.template(client, publicId, true);
      if (!t) throw templateNotFound();
      await repo.updateTemplate(this.ctx(caller), t.id, { is_active: false, updated_by: caller.user.id }, client);
    });
  }

  // Data protection ------------------------------------------------------------------------------------------------

  /** A driver's every item, retracted ones too, for their data export (FMS-104): what they were told, and their reply. */
  async exportFor(db: Queryable, driverId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.deps.repo.forDriver(db, driverId);
    const users = await this.people(db, rows.flatMap((r) => [r.authorId]));
    const revisions = await this.deps.repo.revisions(db, rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.publicId,
      subject_type: r.subjectType,
      trip_id: r.tripPublicId,
      month: r.scoreMonth,
      score_shown: r.scoreShown,
      category: r.category,
      tone: r.tone,
      message: r.message,
      earlier_messages: revisions.filter((v) => v.feedbackId === r.id).map((v) => ({ message: v.message, replaced_at: v.at.toISOString() })),
      from: users(r.authorId)?.name ?? null,
      given_at: r.createdAt.toISOString(),
      edited_at: iso(r.editedAt),
      retracted_at: iso(r.retractedAt),
      retraction_reason: r.retractionReason,
      acknowledged_at: iso(r.acknowledgedAt),
      reply: r.reply,
      replied_at: iso(r.repliedAt),
    }));
  }

  /** An erasure (privacy module): every item of the driver, with its earlier texts. The number deleted. */
  async eraseFor(client: PoolClient, ctx: MutationContext, driverId: string): Promise<number> {
    const ids = await this.deps.repo.idsOfDriver(client, driverId);
    return this.deps.repo.remove(ctx, ids, 'privacy.feedback_erased', client);
  }

  /** The nightly job: items older than the retention period (feedback_retention_months) are deleted. */
  async purge(run: { now: Date; correlationId: string }): Promise<{ deleted: number; cutoff: string }> {
    const { repo } = this.deps;
    const { retentionMonths } = await this.deps.rules();
    const cutoff = retentionCutoff(run.now, retentionMonths);
    const ctx: MutationContext = { userId: null, correlationId: run.correlationId };
    let deleted = 0;
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
      const n = await repo.inTransaction(async (client) => repo.remove(ctx, await repo.olderThan(client, cutoff, RETENTION_BATCH), 'feedback.retention_deleted', client));
      deleted += n;
      if (n < RETENTION_BATCH) break;
    }
    return { deleted, cutoff: cutoff.toISOString() };
  }

  /** Who gave the feedback an appeal disagrees with (FMS-159): they may not decide the appeal. */
  authorOf(db: Queryable, feedbackId: string): Promise<string | null> {
    return this.deps.repo.authorOf(db, feedbackId);
  }

  /** The signed-in driver's live item by public id, for an appeal that disagrees with it: its internal id and month. */
  async ownLiveItem(db: Queryable, driverId: string, publicId: string): Promise<{ id: string; month: string | null } | null> {
    const item = await this.deps.repo.find(db, publicId);
    if (!item || item.driverId !== driverId || item.retractedAt) return null;
    return { id: item.id, month: item.scoreMonth };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private ctx(caller: Caller): MutationContext {
    return { userId: caller.user.id, correlationId: caller.correlationId };
  }

  private async assertCategory(category: string): Promise<void> {
    const { categories } = await this.deps.rules();
    if (!categories.includes(category)) throw validationFailed([{ field: 'category', reason: 'not_an_option' }], 'Choose one of the feedback categories in use.');
  }

  /** A driver the caller manages: 404 for none, 403 for one of another depot. */
  private async managedDriver(db: Queryable, caller: Caller, driverPublicId: string): Promise<AppealDriver> {
    const driver = await this.deps.repo.driver(db, driverPublicId);
    if (!driver) throw new AppError(404, 'NOT_FOUND', 'Driver not found.');
    if (!(await this.manages(db, caller, driver.depotId))) throw otherDepot();
    return driver;
  }

  /** An item of a driver the caller manages: 404 for none, 403 when the driver is of another depot. */
  private async managedItem(db: Queryable, caller: Caller, publicId: string, lock = false): Promise<FeedbackRow> {
    const item = await this.deps.repo.find(db, publicId, lock);
    if (!item) throw feedbackNotFound();
    const driver = await this.deps.repo.driverById(db, item.driverId);
    if (!(await this.manages(db, caller, driver?.depotId ?? item.depotId))) throw otherDepot();
    return item;
  }

  private async manages(db: Queryable, caller: Caller, depotId: string | null): Promise<boolean> {
    const scope = depotScope(caller.user);
    if (scope.kind === 'none') return false;
    if (scope.kind === 'all') return true;
    return this.deps.repo.depotInAudience(db, depotId, { scope });
  }

  /** The caller's own driver record; 404 for anyone who is not a driver. */
  private async ownDriver(db: Queryable, caller: Caller): Promise<AppealDriver> {
    const driver = caller.user.id === null ? null : await this.deps.repo.driverOfUser(db, String(caller.user.id));
    if (!driver) throw feedbackNotFound();
    return driver;
  }

  /** One of the driver's live items: a retracted one, or anyone else's, is not found. */
  private async ownItem(db: Queryable, caller: Caller, publicId: string, lock = false): Promise<FeedbackRow> {
    const driver = await this.ownDriver(db, caller);
    const item = await this.deps.repo.find(db, publicId, lock);
    if (!item || item.driverId !== driver.driverId || item.retractedAt) throw feedbackNotFound();
    return item;
  }

  /** What the feedback is about: the driver's completed trip, a month that has begun (with the score now shown), or overall. */
  private async subject(db: Queryable, driver: AppealDriver, input: GiveInput, now: Date): Promise<{ tripId: string | null; month: string | null; scoreShown: number | null }> {
    if (input.subject_type === 'trip') {
      if (!input.trip_id) throw validationFailed([{ field: 'trip_id', reason: 'required' }], 'Name the trip the feedback is about.');
      const trip = await this.deps.repo.trip(db, input.trip_id);
      if (!trip || trip.driverId !== driver.driverId || trip.status !== 'completed') {
        throw validationFailed([{ field: 'trip_id', reason: 'not_a_completed_trip_of_the_driver' }], "That is not one of this driver's completed trips.");
      }
      return { tripId: trip.id, month: null, scoreShown: null };
    }
    if (input.subject_type === 'month') {
      const month = input.month;
      if (!month || !MONTH.test(month)) throw validationFailed([{ field: 'month', reason: 'required' }], 'Name the month, as YYYY-MM.');
      if (month > monthOf(now)) throw validationFailed([{ field: 'month', reason: 'month_not_begun' }], 'That month has not begun.');
      const shown = driver.userId ? await this.deps.score(db, driver.userId, month) : null;
      return { tripId: null, month, scoreShown: shown?.score.score ?? null };
    }
    return { tripId: null, month: null, scoreShown: null };
  }

  private async managerStep(
    caller: Caller,
    publicId: string,
    fn: (client: PoolClient, item: FeedbackRow, ctx: MutationContext) => Promise<string | null>,
  ): Promise<FeedbackView> {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const item = await this.managedItem(client, caller, publicId, true);
      const type = await fn(client, item, this.ctx(caller));
      const updated = (await repo.findById(client, item.id))!;
      if (type) await this.publish(client, caller, type, updated, await repo.driverById(client, updated.driverId));
      return (await this.managerViews(client, caller, [updated]))[0];
    });
  }

  private async driverStep(
    caller: Caller,
    publicId: string,
    fn: (client: PoolClient, item: FeedbackRow, ctx: MutationContext) => Promise<string | null>,
  ): Promise<DriverFeedbackView> {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const item = await this.ownItem(client, caller, publicId, true);
      const type = await fn(client, item, this.ctx(caller));
      const updated = (await repo.findById(client, item.id))!;
      if (type) await this.publish(client, caller, type, updated, await repo.driverById(client, updated.driverId));
      return (await this.driverViews(client, caller, [updated]))[0];
    });
  }

  /** The step's event: which item, whose, of what kind; never the words. */
  private async publish(client: PoolClient, caller: Caller, type: string, item: FeedbackRow, driver: AppealDriver | null): Promise<void> {
    await this.deps.events.publish(client, [
      createEvent(
        type,
        {
          feedback_id: item.publicId,
          driver_id: driver?.publicId ?? null,
          depot_id: driver?.depotPublicId ?? null,
          subject_type: item.subjectType,
          category: item.category,
          tone: item.tone,
        },
        { actor: caller.user.publicId, correlationId: caller.correlationId },
        { aggregate: aggregateKey('feedback', item.publicId) },
      ),
    ]);
  }

  private async people(db: Queryable, ids: readonly (string | null)[]): Promise<(id: string | null) => Person> {
    const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
    const users = new Map((await this.deps.users.findByIds(db, wanted)).map((u) => [String(u.id), u]));
    return (id) => {
      const u = id ? users.get(String(id)) : undefined;
      return u ? { id: u.publicId, name: u.fullName } : null;
    };
  }

  private base(r: FeedbackRow, person: (id: string | null) => Person, can: FeedbackAbilities): DriverFeedbackView {
    return {
      id: r.publicId,
      subject: { type: r.subjectType, trip_id: r.tripPublicId, month: r.scoreMonth, score_shown: r.scoreShown },
      category: r.category,
      tone: r.tone,
      message: r.message,
      from: person(r.authorId),
      given_at: r.createdAt.toISOString(),
      edited_at: iso(r.editedAt),
      acknowledged_at: iso(r.acknowledgedAt),
      reply: r.reply,
      replied_at: iso(r.repliedAt),
      can,
    };
  }

  private async driverViews(db: Queryable, caller: Caller, rows: readonly FeedbackRow[]): Promise<DriverFeedbackView[]> {
    const person = await this.people(db, rows.map((r) => r.authorId));
    const now = this.now();
    return rows.map((r) => this.base(r, person, abilities(r, { manager: false, canWrite: false, driver: true, userId: caller.user.id === null ? null : String(caller.user.id) }, now)));
  }

  private async managerViews(db: Queryable, caller: Caller, rows: readonly FeedbackRow[]): Promise<FeedbackView[]> {
    const revisions = await this.deps.repo.revisions(db, rows.map((r) => r.id));
    const person = await this.people(db, [...rows.flatMap((r) => [r.authorId, r.retractedBy]), ...revisions.map((v) => v.revisedBy)]);
    const drivers = new Map<string, AppealDriver | null>();
    for (const id of new Set(rows.map((r) => r.driverId))) drivers.set(id, await this.deps.repo.driverById(db, id));
    const now = this.now();
    const userId = caller.user.id === null ? null : String(caller.user.id);
    const canWrite = caller.user.permissions.includes('feedback:write');
    return rows.map((r) => {
      const d = drivers.get(r.driverId) ?? null;
      return {
        ...this.base(r, person, abilities(r, { manager: true, canWrite, driver: false, userId }, now)),
        driver: d ? { id: d.publicId, name: d.name } : null,
        depot: d?.depotPublicId ? { id: d.depotPublicId, name: d.depotName ?? '' } : null,
        editable_until: r.editableUntil.toISOString(),
        retracted_at: iso(r.retractedAt),
        retracted_by: person(r.retractedBy),
        retraction_reason: r.retractionReason,
        unacknowledged_overdue: unacknowledgedTooLong(r, now),
        revisions: revisions.filter((v) => v.feedbackId === r.id).map((v) => ({ message: v.message, revised_by: person(v.revisedBy), at: v.at.toISOString() })),
        version: r.version,
      };
    });
  }
}

function templateView(t: TemplateRow): TemplateView {
  return { id: t.publicId, category: t.category, title: t.title, body: t.body, updated_at: t.updatedAt.toISOString(), version: t.version };
}
