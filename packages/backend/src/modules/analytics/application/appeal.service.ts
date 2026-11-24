import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { PoolClient } from 'pg';
import { depotScope } from '../../../shared/authz/scope';
import { AppError, validationFailed } from '../../../shared/errors/app-error';
import { aggregateKey, createEvent, deterministicEventId } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DocumentStorage } from '../../../shared/storage/document-storage';
import type { RequestUser } from '../../../types/express';
import {
  APPEAL_EVENTS,
  AUTO_CLOSE_DAYS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  OPEN_STATUSES,
  addWorkingDays,
  appealNotFound,
  appealOpen,
  assertCan,
  attachmentNotFound,
  correctionsFor,
  fileTooLarge,
  linkExpired,
  linkInvalid,
  median,
  monthEnd,
  monthOf,
  monthStart,
  ownReport,
  sniffAttachment,
  targetKey,
  targetNotFound,
  tooManyFiles,
  unsupportedFile,
  withinWindow,
  windowClosed,
  type AppealEventView,
  type AppealKind,
  type AppealReason,
  type AppealStatus,
  type AppealView,
  type AttachmentType,
  type Correction,
} from '../domain/appeal';
import type { DriverScore } from '../domain/driver-score';
import type { AppealableFact, AppealDriver, AppealRepository, AppealRow } from '../infrastructure/appeal.repository';
import type { AttachmentUrlSigner } from '../infrastructure/attachment-url';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

/** A driver's month as the score reads it, and its score: for the correction and the reviewer's breakdown. */
export interface MonthScore {
  score: DriverScore;
  figures: Record<string, number>;
}

export interface AppealServiceDeps {
  repo: AppealRepository;
  storage: DocumentStorage;
  urls: AttachmentUrlSigner;
  events: EventBus;
  /** The appeal window and the review deadline (settings, FMS-157). */
  rules: () => Promise<{ windowDays: number; reviewWorkingDays: number }>;
  /** The driver's score for a month (`YYYY-MM`), on this connection: inside a decision's transaction it sees the exclusion. */
  score: (db: Queryable, driverUserId: string, month: string) => Promise<MonthScore>;
  /** User accounts by internal id (auth): who claimed, decided and wrote each step. */
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]> };
  now?: () => Date;
}

export interface SubmitInput {
  kind: AppealKind;
  target_type: 'flag' | 'incident' | 'score';
  target_id?: string;
  month?: string;
  reason: AppealReason;
  explanation: string;
}

export interface UploadedFile {
  bytes: Buffer;
  originalName: string;
}

export interface DecisionInput {
  outcome: 'approved' | 'rejected';
  note: string;
  correction?: Correction;
  /** For an appeal against a month's score: the flag, incident or trip (public id) the correction takes out. */
  item_id?: string;
}

export interface QueueQuery {
  status?: AppealStatus[];
  depot_id?: string;
  overdue?: boolean;
  page: number;
  page_size: number;
}

/** The evidence a reviewer sees beside an appeal. */
export interface AppealEvidence {
  /** The vehicle and the time range of its GPS track: the trip's, or the flag's or incident's with a margin. */
  track: { vehicle_id: string; registration_number: string; from: string; to: string } | null;
  flag: { type: string; observed_at: string; resolved_at: string | null } | null;
  incident: { type: string; occurred_at: string } | null;
  trip_flags: { id: string; type: string; observed_at: string; resolved_at: string | null; excluded: boolean }[];
  score: { month: string; score: number | null; reason: string | null; components: DriverScore['components']; figures: Record<string, number> };
  /** The corrections an approval may make. */
  corrections: Correction[];
}

export interface AppealDetail extends AppealView {
  timeline: AppealEventView[];
  evidence: AppealEvidence | null;
  /** What the caller may do now. */
  can: { claim: boolean; comment: boolean; decide: boolean; withdraw: boolean; acknowledge: boolean };
}

const ESCALATION_BATCH = 200;
/** A flag's or incident's track: this long either side of it, when it was on no trip. */
const TRACK_MARGIN_MS = 30 * 60_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const UNIQUE_VIOLATION = '23505';

/**
 * Score appeals and complaints (FMS-159, docs/score-appeals.md). A driver appeals their own flag, incident or month's
 * score within the window, with up to 5 files; reviewers (appeal:review) of the driver's depot claim it, ask in its
 * thread and decide with a note. An approval excludes the flag, incident or trip from the score (the facts stay) and
 * records the score before and after. Every step is on the appeal's timeline and published as an event.
 */
export class AppealService {
  private readonly now: () => Date;

  constructor(private readonly deps: AppealServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** POST /appeals: a driver's appeal or complaint, with its files. */
  async submit(caller: Caller, input: SubmitInput, files: readonly UploadedFile[]): Promise<AppealDetail> {
    const { repo, storage } = this.deps;
    const db = repo.pool();
    const driver = await this.ownDriver(db, caller);
    if (files.length > MAX_ATTACHMENTS) throw tooManyFiles();
    const checked = files.map((f) => {
      if (f.bytes.length > MAX_ATTACHMENT_BYTES) throw fileTooLarge();
      const type = sniffAttachment(f.bytes);
      if (!type) throw unsupportedFile();
      return { ...f, type };
    });
    const now = this.now();
    const rules = await this.deps.rules();
    const target = await this.resolveTarget(db, driver, input, now);
    if (!withinWindow(target.eventAt, now, rules.windowDays)) throw windowClosed(rules.windowDays);

    const publicId = randomUUID();
    const stored = checked.map((f) => ({ ...f, key: `appeals/${publicId}/${randomUUID()}`, sha256: createHash('sha256').update(f.bytes).digest('hex') }));
    for (const f of stored) await storage.put(f.key, f.bytes, f.type);
    try {
      return await repo.inTransaction(async (client) => {
        const ctx = this.ctx(caller);
        let row;
        try {
          await client.query('SAVEPOINT appeal_insert');
          row = await repo.insert(
            ctx,
            {
              public_id: publicId,
              driver_id: driver.driverId,
              depot_id: driver.depotId,
              kind: input.kind,
              target_type: input.target_type,
              flag_id: target.flagId,
              incident_id: target.incidentId,
              score_month: target.month ? `${target.month}-01` : null,
              trip_id: target.tripId,
              target_key: target.key,
              event_at: target.eventAt,
              reason: input.reason,
              explanation: input.explanation,
              status: 'submitted',
              submitted_by: caller.user.id,
              due_at: addWorkingDays(now, rules.reviewWorkingDays),
            },
            client,
          );
        } catch (err) {
          if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
            await client.query('ROLLBACK TO SAVEPOINT appeal_insert');
            throw appealOpen();
          }
          throw err;
        }
        const appealId = String(row.id);
        for (const f of stored) {
          await repo.addAttachment(
            ctx,
            {
              appeal_id: appealId,
              storage_key: f.key,
              content_type: f.type,
              size_bytes: f.bytes.length,
              sha256: f.sha256,
              original_filename: cleanName(f.originalName),
              uploaded_by: caller.user.id,
            },
            client,
          );
        }
        await repo.addEvent(ctx, appealId, 'submitted', null, client);
        const appeal = (await repo.findById(client, appealId))!;
        await this.publish(client, caller, APPEAL_EVENTS.submitted, appeal, driver, { kind: appeal.kind, target_type: appeal.targetType, attachments: stored.length });
        return this.detail(client, caller, appeal, false);
      });
    } catch (err) {
      for (const f of stored) await storage.remove(f.key).catch(() => {});
      throw err;
    }
  }

  /** GET /appeals/mine: the signed-in driver's appeals, newest first. */
  async mine(caller: Caller, page: { page: number; page_size: number }): Promise<{ items: AppealView[]; total: number }> {
    const { repo } = this.deps;
    const db = repo.pool();
    const driver = await this.ownDriver(db, caller);
    const { rows, total } = await repo.list(db, { driverId: driver.driverId, order: 'newest', limit: page.page_size, offset: (page.page - 1) * page.page_size });
    return { items: await this.views(db, rows), total };
  }

  /** GET /appeals/appealable: what the signed-in driver may still appeal, and which months. */
  async appealable(caller: Caller): Promise<{ items: { target_type: 'flag' | 'incident'; id: string; kind: string; at: string; trip_id: string | null; open_appeal_id: string | null; excluded: boolean }[]; months: string[]; window_days: number }> {
    const { repo } = this.deps;
    const db = repo.pool();
    const driver = await this.ownDriver(db, caller);
    const now = this.now();
    const { windowDays } = await this.deps.rules();
    const since = new Date(now.getTime() - windowDays * 86_400_000);
    const found = await repo.appealable(db, driver.driverId, since);
    // Months that have ended within the window, newest first.
    const months: string[] = [];
    for (let m = monthOf(now), i = 0; i < 14; i++) {
      const prev = previousMonth(m);
      if (!withinWindow(monthEnd(prev), now, windowDays)) break;
      months.push(prev);
      m = prev;
    }
    return {
      items: found.map((f) => ({ target_type: f.target, id: f.publicId, kind: f.kind, at: f.at.toISOString(), trip_id: f.tripPublicId, open_appeal_id: f.openAppealId, excluded: f.excluded })),
      months,
      window_days: windowDays,
    };
  }

  /** GET /appeals: the reviewers' queue, oldest first, in their depots. */
  async queue(caller: Caller, query: QueueQuery): Promise<{ items: AppealView[]; total: number }> {
    const { repo } = this.deps;
    const db = repo.pool();
    const a = await this.audience(db, caller, query.depot_id);
    if (!a) return { items: [], total: 0 };
    const { rows, total } = await repo.list(db, {
      audience: a,
      statuses: query.status ?? OPEN_STATUSES,
      overdueAt: query.overdue ? this.now() : undefined,
      order: 'oldest',
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    return { items: await this.views(db, rows), total };
  }

  /** GET /appeals/{id}: the driver's own, or one in a reviewer's depots; with its timeline, and for reviewers the evidence. */
  async get(caller: Caller, publicId: string): Promise<AppealDetail> {
    const db = this.deps.repo.pool();
    const { appeal, reviewer } = await this.visible(db, caller, publicId);
    return this.detail(db, caller, appeal, reviewer);
  }

  /** POST /appeals/{id}/claim: a reviewer takes it; it is under review. */
  async claim(caller: Caller, publicId: string): Promise<AppealDetail> {
    return this.step(caller, publicId, 'review', async (client, appeal, ctx) => {
      assertCan(appeal.status, 'claim');
      await this.deps.repo.update(ctx, appeal.id, { status: 'under_review', claimed_by: caller.user.id, claimed_at: this.now() }, client);
      await this.deps.repo.addEvent(ctx, appeal.id, 'claimed', null, client);
      return { type: APPEAL_EVENTS.claimed, fields: {} };
    });
  }

  /** POST /appeals/{id}/comments: the driver or a reviewer writes in the thread (a question, an answer). */
  async comment(caller: Caller, publicId: string, body: string): Promise<AppealDetail> {
    return this.step(caller, publicId, 'either', async (client, appeal, ctx, asReviewer) => {
      assertCan(appeal.status, 'comment');
      await this.deps.repo.addEvent(ctx, appeal.id, 'commented', body, client);
      return { type: APPEAL_EVENTS.commented, fields: { by: asReviewer ? 'reviewer' : 'driver' } };
    });
  }

  /** POST /appeals/{id}/decision: approve (correcting the score) or reject, with a note. */
  async decide(caller: Caller, publicId: string, input: DecisionInput): Promise<AppealDetail> {
    if (!input.note.trim()) throw validationFailed([{ field: 'note', reason: 'required' }], 'Write a decision note: the driver reads it.');
    return this.step(caller, publicId, 'review', async (client, appeal, ctx) => {
      assertCan(appeal.status, 'decide');
      const { repo } = this.deps;
      const now = this.now();
      const driver = (await repo.drivers(client, [appeal.driverId])).get(appeal.driverId)!;
      const month = appeal.scoreMonth ?? monthOf(appeal.eventAt);
      // The reviewer may not decide against what they reported or reviewed themselves.
      const own = await this.targetFact(client, appeal);
      if (own?.reporterId && own.reporterId === String(caller.user.id)) throw ownReport();

      if (input.outcome === 'rejected') {
        await repo.update(ctx, appeal.id, { status: 'rejected', outcome: 'rejected', decision_note: input.note, decided_by: caller.user.id, decided_at: now }, client);
        await repo.addEvent(ctx, appeal.id, 'rejected', input.note, client);
        return { type: APPEAL_EVENTS.rejected, fields: {} };
      }

      const exclusion = await this.exclusion(client, appeal, input, month);
      if (exclusion?.reporterId && exclusion.reporterId === String(caller.user.id)) throw ownReport();
      const before = driver.userId ? await this.deps.score(client, driver.userId, month) : null;
      if (exclusion) {
        await repo.addExclusion(
          ctx,
          { appeal_id: appeal.id, exclusion_type: exclusion.type, flag_id: exclusion.flagId, incident_id: exclusion.incidentId, trip_id: exclusion.tripId, created_by: caller.user.id },
          client,
        );
      }
      const after = driver.userId && exclusion ? await this.deps.score(client, driver.userId, month) : before;
      await repo.update(
        ctx,
        appeal.id,
        {
          status: 'approved',
          outcome: 'approved',
          correction: input.correction ?? null,
          decision_note: input.note,
          decided_by: caller.user.id,
          decided_at: now,
          score_before: before?.score.score ?? null,
          score_after: after?.score.score ?? null,
        },
        client,
      );
      await repo.addEvent(ctx, appeal.id, 'approved', input.note, client);
      if (exclusion) {
        await this.deps.events.publish(client, [
          createEvent(
            APPEAL_EVENTS.scoreCorrected,
            {
              appeal_id: appeal.publicId,
              driver_id: driver.publicId,
              depot_id: driver.depotPublicId,
              month,
              correction: input.correction,
              score_before: before?.score.score ?? null,
              score_after: after?.score.score ?? null,
            },
            { actor: caller.user.publicId, correlationId: caller.correlationId },
            { aggregate: aggregateKey('driver', driver.publicId) },
          ),
        ]);
      }
      return { type: APPEAL_EVENTS.approved, fields: { correction: input.correction ?? null, score_before: before?.score.score ?? null, score_after: after?.score.score ?? null } };
    });
  }

  /** POST /appeals/{id}/withdraw: the driver takes it back before a decision. */
  async withdraw(caller: Caller, publicId: string): Promise<AppealDetail> {
    return this.step(caller, publicId, 'driver', async (client, appeal, ctx) => {
      assertCan(appeal.status, 'withdraw');
      await this.deps.repo.update(ctx, appeal.id, { status: 'closed', outcome: 'withdrawn', closed_at: this.now() }, client);
      await this.deps.repo.addEvent(ctx, appeal.id, 'withdrawn', null, client);
      await this.deps.repo.addEvent(ctx, appeal.id, 'closed', null, client);
      return { type: APPEAL_EVENTS.withdrawn, fields: {} };
    });
  }

  /** POST /appeals/{id}/acknowledge: the driver has read the decision; it closes. */
  async acknowledge(caller: Caller, publicId: string): Promise<AppealDetail> {
    return this.step(caller, publicId, 'driver', async (client, appeal, ctx) => {
      assertCan(appeal.status, 'acknowledge');
      const now = this.now();
      await this.deps.repo.update(ctx, appeal.id, { status: 'closed', acknowledged_at: now, closed_at: now }, client);
      await this.deps.repo.addEvent(ctx, appeal.id, 'acknowledged', null, client);
      await this.deps.repo.addEvent(ctx, appeal.id, 'closed', null, client);
      return { type: APPEAL_EVENTS.closed, fields: { by: 'driver' } };
    });
  }

  /** GET /appeals/{id}/attachments/{attachmentId}/link: a signed link to one file, for the driver and reviewers; recorded. */
  async attachmentLink(caller: Caller, publicId: string, attachmentId: string): Promise<{ url: string; expires_at: Date }> {
    const { repo, urls } = this.deps;
    const db = repo.pool();
    const { appeal } = await this.visible(db, caller, publicId);
    const file = await repo.attachment(db, attachmentId);
    if (!file || file.appealId !== appeal.id) throw attachmentNotFound();
    await repo.inTransaction((client) => repo.addEvent(this.ctx(caller), appeal.id, 'attachment_opened', file.publicId, client));
    const link = urls.sign(file.publicId);
    return { url: link.url, expires_at: link.expiresAt };
  }

  /** GET /appeal-attachments/{id}/content: the bytes, for a valid unexpired signed link. */
  async attachmentContent(attachmentId: string, expires: string | undefined, signature: string | undefined): Promise<{ stream: Readable; contentType: AttachmentType; sizeBytes: number; filename: string | null }> {
    const check = this.deps.urls.verify(attachmentId, expires, signature);
    if (check === 'expired') throw linkExpired();
    if (check === 'invalid') throw linkInvalid();
    const file = await this.deps.repo.attachment(this.deps.repo.pool(), attachmentId);
    if (!file) throw attachmentNotFound();
    return { stream: await this.deps.storage.get(file.storageKey), contentType: file.contentType, sizeBytes: file.sizeBytes, filename: file.filename };
  }

  /** GET /appeals/kpis: appeals opened, the share approved and the median days to a decision, for the KPI dashboard (FMS-160). */
  async kpis(caller: Caller, query: { from: Date; to: Date; depot_id?: string }): Promise<{ opened: number; decided: number; approved: number; approved_share: number | null; median_days_to_decision: number | null }> {
    const db = this.deps.repo.pool();
    const a = await this.audience(db, caller, query.depot_id);
    if (!a) return { opened: 0, decided: 0, approved: 0, approved_share: null, median_days_to_decision: null };
    const k = await this.deps.repo.kpis(db, a, query.from, query.to);
    const m = median(k.days);
    return {
      opened: k.opened,
      decided: k.decided,
      approved: k.approved,
      approved_share: k.decided ? Math.round((1000 * k.approved) / k.decided) / 1000 : null,
      median_days_to_decision: m === null ? null : Math.round(m * 10) / 10,
    };
  }

  /** For "Corrected after appeal" on the driver's score card: the month's approved corrections. */
  async corrections(db: Queryable, driverUserId: string, month: string): Promise<{ appeal_id: string; correction: Correction | null; score_before: number | null; score_after: number | null; decided_at: string | null }[]> {
    const driver = await this.deps.repo.driverOfUser(db, driverUserId);
    if (!driver) return [];
    const rows = await this.deps.repo.corrections(db, driver.driverId, monthStart(month), monthEnd(month));
    return rows.map((r) => ({ appeal_id: r.publicId, correction: r.correction, score_before: r.scoreBefore, score_after: r.scoreAfter, decided_at: iso(r.decidedAt) }));
  }

  /** The escalation job: undecided appeals past their deadline go to the depot admin, once. */
  async escalate(run: { now: Date; correlationId: string }): Promise<{ escalated: number }> {
    const { repo } = this.deps;
    let escalated = 0;
    for (const due of await repo.dueForEscalation(repo.pool(), run.now, ESCALATION_BATCH)) {
      const done = await repo.inTransaction(async (client) => {
        const appeal = await repo.find(client, due.publicId, true);
        if (!appeal || !OPEN_STATUSES.includes(appeal.status) || appeal.escalatedAt) return false;
        const ctx: MutationContext = { userId: null, correlationId: run.correlationId };
        await repo.update(ctx, appeal.id, { escalated_at: run.now }, client);
        await repo.addEvent(ctx, appeal.id, 'escalated', null, client);
        const driver = (await repo.drivers(client, [appeal.driverId])).get(appeal.driverId);
        await this.deps.events.publish(client, [
          createEvent(
            APPEAL_EVENTS.overdue,
            { appeal_id: appeal.publicId, driver_id: driver?.publicId ?? null, depot_id: driver?.depotPublicId ?? null, due_at: appeal.dueAt.toISOString(), status: appeal.status },
            { actor: null, correlationId: run.correlationId },
            { id: deterministicEventId(`AppealOverdue:${appeal.publicId}`), aggregate: aggregateKey('appeal', appeal.publicId) },
          ),
        ]);
        return true;
      });
      if (done) escalated += 1;
    }
    return { escalated };
  }

  /** The closing job: a decision the driver never acknowledged closes a week after it was made. */
  async autoClose(run: { now: Date; correlationId: string }): Promise<{ closed: number }> {
    const { repo } = this.deps;
    let closed = 0;
    const cutoff = new Date(run.now.getTime() - AUTO_CLOSE_DAYS * 86_400_000);
    for (const due of await repo.decidedBefore(repo.pool(), cutoff, ESCALATION_BATCH)) {
      const done = await repo.inTransaction(async (client) => {
        const appeal = await repo.find(client, due.publicId, true);
        if (!appeal || (appeal.status !== 'approved' && appeal.status !== 'rejected')) return false;
        const ctx: MutationContext = { userId: null, correlationId: run.correlationId };
        await repo.update(ctx, appeal.id, { status: 'closed', closed_at: run.now }, client);
        await repo.addEvent(ctx, appeal.id, 'closed', null, client);
        const driver = (await repo.drivers(client, [appeal.driverId])).get(appeal.driverId)!;
        await this.publish(client, { user: { id: null, publicId: null, roles: [], permissions: [], depotId: null }, correlationId: run.correlationId }, APPEAL_EVENTS.closed, { ...appeal, status: 'closed' }, driver, { by: 'system' });
        return true;
      });
      if (done) closed += 1;
    }
    return { closed };
  }

  // ---------------------------------------------------------------------------------------------------------------

  /**
   * One step on an appeal, in a transaction with the row locked: `review` needs appeal:review and the appeal in the
   * caller's depots, `driver` the appeal's own driver, `either` one of the two. Publishes the step's event.
   */
  private async step(
    caller: Caller,
    publicId: string,
    who: 'review' | 'driver' | 'either',
    fn: (client: PoolClient, appeal: AppealRow, ctx: MutationContext, asReviewer: boolean) => Promise<{ type: string; fields: Record<string, unknown> }>,
  ): Promise<AppealDetail> {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const appeal = await repo.find(client, publicId, true);
      if (!appeal) throw appealNotFound();
      const asDriver = await this.isOwnDriver(client, caller, appeal);
      const asReviewer = !asDriver && caller.user.permissions.includes('appeal:review') && (await this.inAudience(client, caller, appeal));
      const allowed = who === 'review' ? asReviewer : who === 'driver' ? asDriver : asDriver || asReviewer;
      if (!allowed) {
        // A reviewer of another depot, or someone else's driver: as if it did not exist. A reader without review: 403.
        if (who !== 'driver' && !asDriver && caller.user.permissions.includes('appeal:read') && (await this.inAudience(client, caller, appeal))) {
          throw new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'You do not have permission to do this.');
        }
        throw appealNotFound();
      }
      const ctx = this.ctx(caller);
      const event = await fn(client, appeal, ctx, asReviewer);
      const updated = (await repo.findById(client, appeal.id))!;
      const driver = (await repo.drivers(client, [appeal.driverId])).get(appeal.driverId)!;
      await this.publish(client, caller, event.type, updated, driver, event.fields);
      return this.detail(client, caller, updated, asReviewer);
    });
  }

  private async publish(client: PoolClient, caller: Caller, type: string, appeal: AppealRow, driver: AppealDriver, fields: Record<string, unknown>): Promise<void> {
    await this.deps.events.publish(client, [
      createEvent(
        type,
        {
          appeal_id: appeal.publicId,
          driver_id: driver.publicId,
          depot_id: driver.depotPublicId,
          status: appeal.status,
          outcome: appeal.outcome,
          target_type: appeal.targetType,
          ...fields,
        },
        { actor: caller.user.publicId, correlationId: caller.correlationId },
        { aggregate: aggregateKey('appeal', appeal.publicId) },
      ),
    ]);
  }

  private ctx(caller: Caller): MutationContext {
    return { userId: caller.user.id, correlationId: caller.correlationId };
  }

  /** The caller's own driver record; 404 for anyone who is not a driver. */
  private async ownDriver(db: Queryable, caller: Caller): Promise<AppealDriver> {
    const driver = caller.user.id === null ? null : await this.deps.repo.driverOfUser(db, caller.user.id);
    if (!driver) throw targetNotFound();
    return driver;
  }

  private async isOwnDriver(db: Queryable, caller: Caller, appeal: AppealRow): Promise<boolean> {
    if (caller.user.id === null || !caller.user.permissions.includes('appeal:submit')) return false;
    const driver = await this.deps.repo.driverOfUser(db, caller.user.id);
    return driver?.driverId === appeal.driverId;
  }

  private async inAudience(db: Queryable, caller: Caller, appeal: AppealRow): Promise<boolean> {
    const scope = depotScope(caller.user);
    if (scope.kind === 'none') return false;
    return this.deps.repo.inAudience(db, appeal.id, { scope });
  }

  /** The caller's audience for the queue: their depots, narrowed to one; null when they see none. */
  private async audience(db: Queryable, caller: Caller, depotPublicId?: string) {
    const scope = depotScope(caller.user);
    if (scope.kind === 'none') return null;
    if (!depotPublicId) return { scope };
    const depotId = await this.deps.repo.depotInAudience(db, depotPublicId, { scope });
    return depotId ? { scope, depotId } : null;
  }

  /** An appeal the caller may read: their own as a driver, or one in their depots with appeal:read. */
  private async visible(db: Queryable, caller: Caller, publicId: string): Promise<{ appeal: AppealRow; reviewer: boolean }> {
    const appeal = await this.deps.repo.find(db, publicId);
    if (!appeal) throw appealNotFound();
    if (await this.isOwnDriver(db, caller, appeal)) return { appeal, reviewer: false };
    if (caller.user.permissions.includes('appeal:read') && (await this.inAudience(db, caller, appeal))) return { appeal, reviewer: true };
    throw appealNotFound();
  }

  /** What an appeal is against: the driver's own flag or incident, or a month that has ended. */
  private async resolveTarget(
    db: Queryable,
    driver: AppealDriver,
    input: SubmitInput,
    now: Date,
  ): Promise<{ key: string; eventAt: Date; flagId: string | null; incidentId: string | null; tripId: string | null; month: string | null }> {
    const { repo } = this.deps;
    if (input.target_type === 'score') {
      const month = input.month!;
      if (monthEnd(month).getTime() > now.getTime()) throw validationFailed([{ field: 'month', reason: 'month_not_ended' }], 'A month can be appealed once it has ended.');
      return { key: targetKey({ type: 'score', driverId: driver.driverId, month }), eventAt: monthEnd(month), flagId: null, incidentId: null, tripId: null, month };
    }
    const fact = input.target_type === 'flag' ? await repo.flag(db, input.target_id!) : await repo.incident(db, input.target_id!);
    if (!fact || fact.driverId !== driver.driverId) throw targetNotFound();
    if (input.target_type === 'flag' && fact.kind !== 'speeding' && fact.kind !== 'idling') throw targetNotFound();
    return {
      key: targetKey({ type: input.target_type, id: fact.id }),
      eventAt: fact.at,
      flagId: input.target_type === 'flag' ? fact.id : null,
      incidentId: input.target_type === 'incident' ? fact.id : null,
      tripId: fact.tripId,
      month: null,
    };
  }

  private async targetFact(db: Queryable, appeal: AppealRow): Promise<AppealableFact | null> {
    if (appeal.targetType === 'flag' && appeal.targetPublicId) return this.deps.repo.flag(db, appeal.targetPublicId);
    if (appeal.targetType === 'incident' && appeal.targetPublicId) return this.deps.repo.incident(db, appeal.targetPublicId);
    return null;
  }

  /** What an approval excludes; null for an upheld complaint without one. 400 when the correction does not fit. */
  private async exclusion(
    db: Queryable,
    appeal: AppealRow,
    input: DecisionInput,
    month: string,
  ): Promise<{ type: 'flag' | 'incident' | 'trip'; flagId: string | null; incidentId: string | null; tripId: string | null; reporterId: string | null } | null> {
    const bad = (reason: string, message: string) => validationFailed([{ field: 'correction', reason }], message);
    if (!input.correction) {
      if (appeal.kind === 'complaint') return null;
      throw bad('required', 'An approved appeal corrects the score: choose what it excludes.');
    }
    const allowed = correctionsFor(appeal.targetType, appeal.tripId !== null);
    if (!allowed.includes(input.correction)) throw bad('not_allowed', 'That correction does not fit what this appeal is against.');
    const { repo } = this.deps;
    if (appeal.targetType !== 'score') {
      if (input.correction === 'exclude_trip') return { type: 'trip', flagId: null, incidentId: null, tripId: appeal.tripId, reporterId: null };
      return input.correction === 'exclude_flag'
        ? { type: 'flag', flagId: appeal.flagId, incidentId: null, tripId: null, reporterId: null }
        : { type: 'incident', flagId: null, incidentId: appeal.incidentId, tripId: null, reporterId: null };
    }
    // A month's score: the reviewer names the driver's flag, incident or trip of that month.
    if (!input.item_id) throw bad('item_required', 'Name the flag, incident or trip of the month the correction takes out.');
    const inMonth = (at: Date | null) => at !== null && monthOf(at) === month;
    if (input.correction === 'exclude_trip') {
      const trip = await repo.trip(db, input.item_id);
      if (!trip || trip.driverId !== appeal.driverId || !inMonth(trip.endedAt ?? trip.startedAt)) throw bad('item_not_found', "That is not one of the driver's trips of the month.");
      return { type: 'trip', flagId: null, incidentId: null, tripId: trip.id, reporterId: null };
    }
    const fact = input.correction === 'exclude_flag' ? await repo.flag(db, input.item_id) : await repo.incident(db, input.item_id);
    if (!fact || fact.driverId !== appeal.driverId || !inMonth(fact.at)) throw bad('item_not_found', "That is not one of the driver's flags or incidents of the month.");
    return input.correction === 'exclude_flag'
      ? { type: 'flag', flagId: fact.id, incidentId: null, tripId: null, reporterId: fact.reporterId }
      : { type: 'incident', flagId: null, incidentId: fact.id, tripId: null, reporterId: fact.reporterId };
  }

  private async detail(db: Queryable, caller: Caller, appeal: AppealRow, reviewer: boolean): Promise<AppealDetail> {
    const [view] = await this.views(db, [appeal]);
    const events = await this.deps.repo.events(db, appeal.id);
    const actors = new Map((await this.deps.users.findByIds(db, [...new Set(events.flatMap((e) => (e.actorId ? [e.actorId] : [])))])).map((u) => [u.id, u]));
    const timeline = events
      // A driver's timeline leaves out who opened the files: that record is for the reviewers and the audit.
      .filter((e) => reviewer || e.type !== 'attachment_opened')
      .map((e) => {
        const actor = e.actorId ? actors.get(e.actorId) : undefined;
        return { id: e.publicId, type: e.type, actor: actor ? { id: actor.publicId, name: actor.fullName } : null, body: e.body, at: e.at.toISOString() };
      });
    const canReview = reviewer && caller.user.permissions.includes('appeal:review');
    const driverView = !reviewer;
    return {
      ...view,
      timeline,
      evidence: reviewer ? await this.evidence(db, appeal) : null,
      can: {
        claim: canReview && appeal.status === 'submitted',
        comment: (canReview || driverView) && OPEN_STATUSES.includes(appeal.status),
        decide: canReview && appeal.status === 'under_review',
        withdraw: driverView && OPEN_STATUSES.includes(appeal.status),
        acknowledge: driverView && (appeal.status === 'approved' || appeal.status === 'rejected'),
      },
    };
  }

  private async evidence(db: Queryable, appeal: AppealRow): Promise<AppealEvidence> {
    const { repo } = this.deps;
    const fact = await this.targetFact(db, appeal);
    const driver = (await repo.drivers(db, [appeal.driverId])).get(appeal.driverId);
    const month = appeal.scoreMonth ?? monthOf(appeal.eventAt);
    let track: AppealEvidence['track'] = null;
    if (fact?.vehicleId) {
      const vehicle = await repo.vehiclePublicId(db, fact.vehicleId);
      const times = fact.tripId ? await repo.tripTimes(db, fact.tripId) : null;
      const from = times?.start ?? new Date(fact.at.getTime() - TRACK_MARGIN_MS);
      const to = times?.end ?? new Date((fact.endedAt ?? fact.at).getTime() + TRACK_MARGIN_MS);
      if (vehicle) track = { vehicle_id: vehicle.publicId, registration_number: vehicle.registrationNumber, from: from.toISOString(), to: to.toISOString() };
    }
    const tripFlags = appeal.tripId ? await repo.tripFlags(db, appeal.tripId) : [];
    const monthScore = driver?.userId ? await this.deps.score(db, driver.userId, month) : null;
    return {
      track,
      flag: appeal.targetType === 'flag' && fact ? { type: fact.kind, observed_at: fact.at.toISOString(), resolved_at: iso(fact.endedAt) } : null,
      incident: appeal.targetType === 'incident' && fact ? { type: fact.kind, occurred_at: fact.at.toISOString() } : null,
      trip_flags: tripFlags.map((f) => ({ id: f.publicId, type: f.kind, observed_at: f.at.toISOString(), resolved_at: iso(f.endedAt), excluded: f.excluded })),
      score: {
        month,
        score: monthScore?.score.score ?? null,
        reason: monthScore?.score.reason ?? null,
        components: monthScore?.score.components ?? ({} as DriverScore['components']),
        figures: monthScore?.figures ?? {},
      },
      corrections: [...correctionsFor(appeal.targetType, appeal.tripId !== null)],
    };
  }

  private async views(db: Queryable, rows: readonly AppealRow[]): Promise<AppealView[]> {
    const { repo } = this.deps;
    const drivers = await repo.drivers(db, rows.map((r) => r.driverId));
    const depots = await repo.depots(db, rows.flatMap((r) => (r.depotId ? [r.depotId] : [])));
    const userIds = [...new Set(rows.flatMap((r) => [r.claimedBy, r.decidedBy].filter((v): v is string => v !== null)))];
    const users = new Map((await this.deps.users.findByIds(db, userIds)).map((u) => [u.id, u]));
    const files = await repo.attachments(db, rows.map((r) => r.id));
    const now = this.now();
    const person = (id: string | null) => {
      const u = id ? users.get(String(id)) : undefined;
      return u ? { id: u.publicId, name: u.fullName } : null;
    };
    return rows.map((r) => {
      const driver = drivers.get(r.driverId);
      const depot = r.depotId ? depots.get(r.depotId) : undefined;
      return {
        id: r.publicId,
        kind: r.kind,
        status: r.status,
        outcome: r.outcome,
        target: { type: r.targetType, id: r.targetPublicId, month: r.scoreMonth, trip_id: r.tripPublicId, event_at: r.eventAt.toISOString() },
        reason: r.reason,
        explanation: r.explanation,
        driver: { id: driver?.publicId ?? '', name: driver?.name ?? '' },
        depot: depot ? { id: depot.publicId, name: depot.name } : null,
        submitted_at: r.createdAt.toISOString(),
        due_at: r.dueAt.toISOString(),
        overdue: OPEN_STATUSES.includes(r.status) && r.dueAt.getTime() <= now.getTime(),
        escalated_at: iso(r.escalatedAt),
        claimed_by: person(r.claimedBy),
        claimed_at: iso(r.claimedAt),
        decided_by: person(r.decidedBy),
        decided_at: iso(r.decidedAt),
        decision_note: r.decisionNote,
        correction: r.correction,
        score_before: r.scoreBefore,
        score_after: r.scoreAfter,
        acknowledged_at: iso(r.acknowledgedAt),
        closed_at: iso(r.closedAt),
        attachments: files.filter((f) => f.appealId === r.id).map((f) => ({ id: f.publicId, content_type: f.contentType, size_bytes: f.sizeBytes, filename: f.filename })),
        version: r.version,
      };
    });
  }
}

/** The month before `YYYY-MM`. */
function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** A file's name as shown back: no path, no control characters, at most 255 characters. */
function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 255);
  return name || null;
}
