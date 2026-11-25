import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError, validationFailed } from '../../../shared/errors/app-error';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DocumentStorage } from '../../../shared/storage/document-storage';
import type { RequestUser } from '../../../types/express';
import { FREQUENCIES, LINK_DAYS, MAX_ATTACHMENT_BYTES, MAX_SEND_ATTEMPTS, RETRY_MINUTES, nextRunAt, periodFor, type Frequency } from '../domain/report-schedule';
import { REPORTS, REPORT_KINDS, type ReportKind } from '../domain/reports';
import type { AttachmentUrlSigner } from '../infrastructure/attachment-url';
import type { ExportRow, RecipientOutcome, ReportStoreRepository, RunRow, ScheduleRow } from '../infrastructure/report-store.repository';
import { BACKGROUND_EXPORT_ROWS, type ReportFile, type ReportQuery, type ReportService } from './report.service';

interface Caller {
  user: RequestUser;
  correlationId: string;
}

export type FileFormat = 'csv' | 'xlsx' | 'pdf';

/** Where a recipient's email goes, and what the integration gateway answers (only email here). */
export interface ReportMailer {
  send(
    message: { channel: 'email'; reference: string; to: { email: string; name?: string }; subject: string; text: string; urgency: 'normal'; ttlSeconds: number; attachments?: { filename: string; contentType: string; content: Buffer }[] },
    correlationId: string,
  ): Promise<{ status: 'sent' | 'refused' | 'paused' | 'failed'; message?: string }>;
}

export interface ReportJobsDeps {
  repo: ReportStoreRepository;
  reports: Pick<ReportService, 'report' | 'render'>;
  storage: DocumentStorage;
  /** Signed links: an export's (24 hours) and a scheduled file's (7 days). */
  urls: AttachmentUrlSigner;
  /** The account a schedule's recipient or an export's owner is now: roles, permissions, depot; null when inactive. */
  users: {
    requestUser(db: Queryable, id: string): Promise<RequestUser | null>;
    findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string; email: string }[]>;
    findByPublicId(db: Queryable, publicId: string): Promise<{ id: string; status: string } | null>;
    withPermission(db: Queryable, permission: string, search: string, limit: number): Promise<{ publicId: string; fullName: string; roles: string[] }[]>;
  };
  mailer: ReportMailer;
  appUrl: string | null;
  now?: () => Date;
}

const EXPORT_HOURS = 24;
const DAY_MS = 86_400_000;
const cut = (s: string) => s.slice(0, 500);

/**
 * Saved filters, background exports and report schedules (FMS-160, docs/reports.md): a filter combination kept by
 * name; an export over 20,000 rows made in the background, its file downloadable for 24 hours by a signed link; a
 * report emailed daily, weekly or monthly to FMS users, each checked at send time (still active, analytics:read, and
 * their own depot scope), attached up to 5 MB or as a 7-day link, retried 3 times, with a run history.
 */
export class ReportJobsService {
  private readonly now: () => Date;

  constructor(private readonly deps: ReportJobsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // Saved filters -------------------------------------------------------------------------------------------------

  async savedFilters(caller: Caller) {
    return (await this.deps.repo.filters(this.deps.repo.pool(), String(caller.user.id))).map((f) => ({ id: f.publicId, name: f.name, filters: f.filters, created_at: f.createdAt.toISOString() }));
  }

  async saveFilter(caller: Caller, input: { name: string; filters: Record<string, unknown> }) {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      await client.query('SAVEPOINT save_filter');
      try {
        const row = await repo.insertFilter(this.ctx(caller), { user_id: caller.user.id, name: input.name, filters: JSON.stringify(input.filters) }, client);
        const f = (await repo.filter(client, String(row.public_id)))!;
        return { id: f.publicId, name: f.name, filters: f.filters, created_at: f.createdAt.toISOString() };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          await client.query('ROLLBACK TO SAVEPOINT save_filter');
          throw new AppError(409, 'CONFLICT_DUPLICATE', 'You already have a filter by that name.', [{ field: 'name', reason: 'duplicate' }]);
        }
        throw err;
      }
    });
  }

  async deleteFilter(caller: Caller, publicId: string): Promise<void> {
    const { repo } = this.deps;
    await repo.inTransaction(async (client) => {
      const f = await repo.filter(client, publicId);
      if (!f || f.userId !== String(caller.user.id)) throw new AppError(404, 'NOT_FOUND', 'Saved filter not found.');
      await repo.deleteFilter(this.ctx(caller), f.id, client);
    });
  }

  // Exports -------------------------------------------------------------------------------------------------------

  /**
   * GET /reports/{report}?format=: the file now, or, over 20,000 rows, an export queued for the background (the
   * caller polls GET /reports/exports/{id}).
   */
  async exportOrFile(caller: Caller, kind: ReportKind, format: FileFormat, query: ReportQuery): Promise<{ file: ReportFile } | { queued: ReturnType<ReportJobsService['exportView']> }> {
    const { data, meta } = await this.deps.reports.report(kind, caller.user, query);
    if (data.rows.length <= BACKGROUND_EXPORT_ROWS) return { file: await this.deps.reports.render(data, format, meta.data_freshness) };
    const { repo } = this.deps;
    const row = await repo.inTransaction((client) =>
      repo.insertExport(this.ctx(caller), { user_id: caller.user.id, report: kind, format, filters: JSON.stringify(query), status: 'queued' }, client),
    );
    return { queued: this.exportView((await repo.exportById(repo.pool(), String(row.id)))!) };
  }

  /** GET /reports/exports/{id}: the caller's own; with a signed 24-hour link once ready. */
  async exportStatus(caller: Caller, publicId: string) {
    const e = await this.deps.repo.export(this.deps.repo.pool(), publicId);
    if (!e || e.userId !== String(caller.user.id)) throw new AppError(404, 'NOT_FOUND', 'Export not found.');
    return this.exportView(e);
  }

  /** GET /report-files/{id}/content: an export's file, or a scheduled report's, for a valid unexpired link. */
  async fileContent(id: string, expires: string | undefined, signature: string | undefined): Promise<{ stream: Readable; filename: string; contentType: string }> {
    const check = this.deps.urls.verify(id, expires, signature);
    // As an appeal attachment's link (FMS-159): 401, expired or not a link at all.
    if (check === 'expired') throw new AppError(401, 'AUTH_TOKEN_EXPIRED', 'This report link has expired. Ask for the report again.');
    if (check === 'invalid') throw new AppError(401, 'AUTH_TOKEN_INVALID', 'This report link is not valid.');
    const e = await this.deps.repo.export(this.deps.repo.pool(), id);
    if (!e || e.status !== 'ready' || !e.storageKey || !e.filename) throw new AppError(404, 'NOT_FOUND', 'The file is gone.');
    return { stream: await this.deps.storage.get(e.storageKey), filename: e.filename, contentType: CONTENT_TYPES[e.format] };
  }

  /** The export job: the oldest queued export, built as its owner now is, stored for 24 hours; and expired files removed. */
  async runExports(run: { now: Date; correlationId: string }): Promise<{ made: number; failed: number; expired: number }> {
    const { repo, storage } = this.deps;
    const ctx: MutationContext = { userId: null, correlationId: run.correlationId };
    const result = { made: 0, failed: 0, expired: 0 };
    for (let i = 0; i < 5; i++) {
      const claimed = await repo.inTransaction(async (client) => {
        const e = await repo.nextExport(client);
        if (e) await repo.updateExport(ctx, e.id, { status: 'running' }, client);
        return e;
      });
      if (!claimed) break;
      try {
        const user = await this.deps.users.requestUser(repo.pool(), claimed.userId);
        if (!user || !user.permissions.includes('analytics:read')) throw new Error('The account can no longer read reports.');
        const { data, meta } = await this.deps.reports.report(claimed.report as ReportKind, user, asQuery(claimed.filters));
        const file = await this.deps.reports.render(data, claimed.format, meta.data_freshness);
        const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8');
        const key = `reports/exports/${claimed.publicId}`;
        await storage.put(key, body, file.contentType);
        await repo.inTransaction((client) =>
          repo.updateExport(
            ctx,
            claimed.id,
            { status: 'ready', storage_key: key, filename: file.filename, rows: data.rows.length, size_bytes: body.length, finished_at: run.now, expires_at: new Date(run.now.getTime() + EXPORT_HOURS * 3_600_000) },
            client,
          ),
        );
        result.made += 1;
      } catch (err) {
        await repo.inTransaction((client) => repo.updateExport(ctx, claimed.id, { status: 'failed', error: cut((err as Error).message), finished_at: run.now }, client));
        result.failed += 1;
      }
    }
    for (const e of await repo.expiredExports(repo.pool(), run.now, 100)) {
      if (e.storageKey) await storage.remove(e.storageKey).catch(() => {});
      await repo.inTransaction((client) => repo.updateExport(ctx, e.id, { status: 'expired' }, client));
      result.expired += 1;
    }
    return result;
  }

  private exportView(e: ExportRow) {
    const ready = e.status === 'ready' && e.expiresAt && e.expiresAt > this.now();
    const link = ready ? this.deps.urls.sign(e.publicId, Math.max(60, Math.floor((e.expiresAt!.getTime() - this.now().getTime()) / 1000))) : null;
    return {
      id: e.publicId,
      report: e.report,
      format: e.format,
      status: e.status,
      rows: e.rows,
      size_bytes: e.sizeBytes,
      error: e.error,
      created_at: e.createdAt.toISOString(),
      expires_at: e.expiresAt?.toISOString() ?? null,
      url: link?.url ?? null,
    };
  }

  // Schedules -----------------------------------------------------------------------------------------------------

  /** Who a schedule can go to: active users who can read reports (analytics:read), by name. */
  async recipients(search: string) {
    const found = await this.deps.users.withPermission(this.deps.repo.pool(), 'analytics:read', search.trim().replace(/[%_\\]/g, ''), 20);
    return found.map((u) => ({ id: u.publicId, name: u.fullName, roles: u.roles }));
  }

  async schedules(caller: Caller) {
    const all = caller.user.roles.includes('admin');
    const rows = await this.deps.repo.schedules(this.deps.repo.pool(), all ? null : String(caller.user.id));
    return this.scheduleViews(rows);
  }

  async createSchedule(caller: Caller, input: ScheduleInput) {
    const { repo } = this.deps;
    const recipients = await this.recipientIds(input.recipients);
    this.checkSchedule(input);
    return repo.inTransaction(async (client) => {
      const row = await repo.insertSchedule(
        this.ctx(caller),
        {
          owner_id: caller.user.id,
          name: input.name,
          report: input.report,
          filters: JSON.stringify(input.filters ?? {}),
          format: input.format,
          frequency: input.frequency,
          day: input.frequency === 'daily' ? null : input.day,
          hour: input.hour,
          recipients,
          next_run_at: nextRunAt(input.frequency, input.frequency === 'daily' ? null : (input.day ?? null), input.hour, this.now()),
        },
        client,
      );
      return (await this.scheduleViews([(await repo.scheduleById(client, String(row.id)))!]))[0];
    });
  }

  async updateSchedule(caller: Caller, publicId: string, input: Partial<ScheduleInput> & { active?: boolean }) {
    const { repo } = this.deps;
    return repo.inTransaction(async (client) => {
      const s = await this.owned(client, caller, publicId, true);
      const merged: ScheduleInput = {
        name: input.name ?? s.name,
        report: (input.report ?? s.report) as ReportKind,
        filters: input.filters ?? s.filters,
        format: input.format ?? s.format,
        frequency: input.frequency ?? s.frequency,
        day: input.day !== undefined ? input.day : s.day,
        hour: input.hour ?? s.hour,
        recipients: [],
      };
      this.checkSchedule(merged);
      const recipients = input.recipients ? await this.recipientIds(input.recipients) : s.recipients;
      await repo.updateSchedule(
        this.ctx(caller),
        s.id,
        {
          name: merged.name,
          report: merged.report,
          filters: JSON.stringify(merged.filters ?? {}),
          format: merged.format,
          frequency: merged.frequency,
          day: merged.frequency === 'daily' ? null : merged.day,
          hour: merged.hour,
          recipients,
          next_run_at: nextRunAt(merged.frequency, merged.frequency === 'daily' ? null : (merged.day ?? null), merged.hour, this.now()),
        },
        client,
      );
      return (await this.scheduleViews([(await repo.scheduleById(client, s.id))!]))[0];
    });
  }

  async deleteSchedule(caller: Caller, publicId: string): Promise<void> {
    const { repo } = this.deps;
    await repo.inTransaction(async (client) => {
      const s = await this.owned(client, caller, publicId, true);
      await repo.deleteSchedule(this.ctx(caller), s.id, client);
    });
  }

  /** GET /reports/schedules/{id}/runs: the last 50 runs, newest first, each recipient's outcome. */
  async runs(caller: Caller, publicId: string) {
    const { repo } = this.deps;
    const s = await this.owned(repo.pool(), caller, publicId, false);
    const runs = await repo.runs(repo.pool(), s.id, 50);
    const users = await this.people(runs.flatMap((r) => r.outcomes.map((o) => o.user_id)));
    return runs.map((r) => ({
      id: r.publicId,
      due_at: r.dueAt.toISOString(),
      period: { from: r.periodFrom.toISOString(), to: r.periodTo.toISOString() },
      status: r.status,
      attempts: r.attempts,
      next_attempt_at: r.nextAttemptAt?.toISOString() ?? null,
      rows: r.rows,
      size_bytes: r.sizeBytes,
      error: r.error,
      recipients: r.outcomes.map((o) => ({ user: users.get(o.user_id) ?? null, outcome: o.outcome, reason: o.reason, delivered: o.delivered })),
      started_at: r.startedAt.toISOString(),
      finished_at: r.finishedAt?.toISOString() ?? null,
    }));
  }

  /**
   * The schedule job: each due schedule gets a run for the period just ended, sent to each recipient as they now are
   * (skipped, and the owner told, when they lost access), and moves to its next time; failed recipients are retried.
   */
  async runSchedules(run: { now: Date; correlationId: string; maxAttachmentBytes?: number }): Promise<{ runs: number; sent: number; skipped: number; failed: number; retried: number }> {
    const { repo } = this.deps;
    const ctx: MutationContext = { userId: null, correlationId: run.correlationId };
    const tally = { runs: 0, sent: 0, skipped: 0, failed: 0, retried: 0 };
    const due = await repo.inTransaction(async (client) => {
      const list = await repo.dueSchedules(client, run.now, 20);
      const made: { schedule: ScheduleRow; run: RunRow }[] = [];
      for (const s of list) {
        const period = periodFor(s.frequency, s.nextRunAt);
        const r = await repo.insertRun(client, ctx, {
          schedule_id: s.id,
          due_at: s.nextRunAt,
          period_from: new Date(`${period.from}T00:00:00+03:00`),
          period_to: new Date(new Date(`${period.to}T00:00:00+03:00`).getTime() + DAY_MS),
          status: 'running',
          attempts: 0,
          outcomes: JSON.stringify([]),
        });
        await repo.updateSchedule(ctx, s.id, { next_run_at: nextRunAt(s.frequency, s.day, s.hour, s.nextRunAt) }, client);
        if (r) made.push({ schedule: s, run: r });
      }
      return made;
    });
    for (const { schedule, run: r } of due) {
      tally.runs += 1;
      const outcomes = await this.send(schedule, r, schedule.recipients, run.correlationId, run.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES);
      await this.finish(ctx, schedule, r, outcomes, [], run.now, tally);
    }
    const retries = await repo.inTransaction((client) => repo.dueRetries(client, run.now, 20));
    for (const r of retries) {
      const schedule = await repo.scheduleById(repo.pool(), r.scheduleId);
      if (!schedule) continue;
      tally.retried += 1;
      const failed = r.outcomes.filter((o) => o.outcome === 'failed').map((o) => o.user_id);
      const again = await this.send(schedule, r, failed, run.correlationId, run.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES);
      const kept = r.outcomes.filter((o) => o.outcome !== 'failed');
      await this.finish(ctx, schedule, r, again, kept, run.now, tally);
    }
    return tally;
  }

  /** A run's outcome: sent, partial (someone skipped or failed for good), failed, or retrying the failed ones. */
  private async finish(ctx: MutationContext, schedule: ScheduleRow, r: RunRow, fresh: Sent, kept: RecipientOutcome[], now: Date, tally: { sent: number; skipped: number; failed: number }) {
    const outcomes = [...kept, ...fresh.outcomes];
    const attempts = r.attempts + 1;
    const failed = outcomes.filter((o) => o.outcome === 'failed').length;
    const skipped = outcomes.filter((o) => o.outcome === 'skipped').length;
    tally.sent += fresh.outcomes.filter((o) => o.outcome === 'sent').length;
    tally.skipped += fresh.outcomes.filter((o) => o.outcome === 'skipped').length;
    tally.failed += fresh.outcomes.filter((o) => o.outcome === 'failed').length;
    const retry = failed > 0 && attempts < MAX_SEND_ATTEMPTS;
    const status = retry ? 'retrying' : failed === outcomes.length ? 'failed' : failed > 0 || skipped > 0 ? 'partial' : 'sent';
    await this.deps.repo.inTransaction((client) =>
      this.deps.repo.updateRun(
        ctx,
        r.id,
        {
          status,
          attempts,
          outcomes: JSON.stringify(outcomes),
          next_attempt_at: retry ? new Date(now.getTime() + RETRY_MINUTES * 60_000) : null,
          rows: fresh.rows ?? r.rows,
          size_bytes: fresh.sizeBytes ?? r.sizeBytes,
          error: fresh.error ? cut(fresh.error) : null,
          finished_at: retry ? null : now,
        },
        client,
      ),
    );
    // The owner hears of recipients who lost access, once, on the first attempt.
    const lost = fresh.outcomes.filter((o) => o.outcome === 'skipped');
    if (lost.length && r.attempts === 0) await this.tellOwner(schedule, lost, ctx.correlationId);
  }

  /** Each recipient's report, built as they now are, by email: attached up to 5 MB, else a 7-day link. */
  private async send(schedule: ScheduleRow, r: RunRow, recipientIds: readonly string[], correlationId: string, maxAttachment: number): Promise<Sent> {
    const { repo, users, reports, mailer } = this.deps;
    const accounts = new Map((await users.findByIds(repo.pool(), recipientIds)).map((u) => [String(u.id), u]));
    const outcomes: RecipientOutcome[] = [];
    let rows: number | null = null;
    let sizeBytes: number | null = null;
    let error: string | null = null;
    const query: ReportQuery = { ...asQuery(schedule.filters), month: undefined, quarter: undefined, year: undefined, from: day(r.periodFrom), to: day(new Date(r.periodTo.getTime() - DAY_MS)) };
    for (const id of recipientIds) {
      const user = await users.requestUser(repo.pool(), id);
      const account = accounts.get(String(id));
      if (!user || !account) {
        outcomes.push({ user_id: id, outcome: 'skipped', reason: 'inactive', delivered: null });
        continue;
      }
      if (!user.permissions.includes('analytics:read')) {
        outcomes.push({ user_id: id, outcome: 'skipped', reason: 'no_access', delivered: null });
        continue;
      }
      try {
        // Their own scope: a depot admin gets their depot's rows; the driver score only with tracking:read.
        const { data, meta } = await reports.report(schedule.report as ReportKind, user, query);
        const file = await reports.render(data, schedule.format, meta.data_freshness);
        const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8');
        rows = data.rows.length;
        sizeBytes = body.length;
        const title = `${REPORTS[schedule.report as ReportKind].title}, ${data.period.label}`;
        let link: string | null = null;
        if (body.length > maxAttachment) link = await this.storeLink(schedule, file, body, user);
        const sent = await mailer.send(
          {
            channel: 'email',
            reference: `${r.publicId}:${id}:${r.attempts}`,
            to: { email: account.email, name: account.fullName },
            subject: `${schedule.name}: ${title}`,
            text: link
              ? `${title} is ready. The file is larger than 5 MB: download it within ${LINK_DAYS} days at ${link}`
              : `${title} is attached (${data.rows.length.toLocaleString('en-US')} rows). Sent by the FMS schedule "${schedule.name}".`,
            urgency: 'normal',
            ttlSeconds: 86_400,
            ...(link ? {} : { attachments: [{ filename: file.filename, contentType: file.contentType, content: body }] }),
          },
          correlationId,
        );
        if (sent.status === 'sent') outcomes.push({ user_id: id, outcome: 'sent', reason: null, delivered: link ? 'link' : 'attached' });
        else {
          outcomes.push({ user_id: id, outcome: 'failed', reason: cut(sent.message ?? sent.status), delivered: null });
          error = sent.message ?? sent.status;
        }
      } catch (err) {
        outcomes.push({ user_id: id, outcome: 'failed', reason: cut((err as Error).message), delivered: null });
        error = (err as Error).message;
      }
    }
    return { outcomes, rows, sizeBytes, error };
  }

  /** A file too large to attach, kept 7 days behind a signed link (an export row, so the same link route serves it). */
  private async storeLink(schedule: ScheduleRow, file: ReportFile, body: Buffer, user: RequestUser): Promise<string> {
    const { repo, storage, urls } = this.deps;
    const id = randomUUID();
    const format = schedule.format;
    const key = `reports/exports/${id}`;
    await storage.put(key, body, file.contentType);
    const now = this.now();
    await repo.inTransaction((client) =>
      repo.insertExport(
        { userId: null, correlationId: id },
        {
          public_id: id,
          user_id: user.id,
          report: schedule.report,
          format,
          filters: JSON.stringify(schedule.filters ?? {}),
          status: 'ready',
          storage_key: key,
          filename: file.filename,
          size_bytes: body.length,
          finished_at: now,
          expires_at: new Date(now.getTime() + LINK_DAYS * DAY_MS),
        },
        client,
      ),
    );
    const signed = urls.sign(id, LINK_DAYS * 86_400);
    return `${(this.deps.appUrl ?? '').replace(/\/+$/, '')}${signed.url}`;
  }

  private async tellOwner(schedule: ScheduleRow, lost: RecipientOutcome[], correlationId: string): Promise<void> {
    const { repo, users, mailer } = this.deps;
    const [owner] = await users.findByIds(repo.pool(), [schedule.ownerId]);
    if (!owner) return;
    const names = (await users.findByIds(repo.pool(), lost.map((l) => l.user_id))).map((u) => u.fullName);
    await mailer.send(
      {
        channel: 'email',
        reference: `schedule-skipped:${schedule.publicId}:${lost.map((l) => l.user_id).join('-')}`,
        to: { email: owner.email, name: owner.fullName },
        subject: `${schedule.name}: not sent to ${lost.length === 1 ? 'one recipient' : `${lost.length} recipients`}`,
        text: `The scheduled report "${schedule.name}" was not sent to ${names.join(', ') || 'a recipient'}: they no longer have access to reports. Remove them from the schedule, or ask an administrator.`,
        urgency: 'normal',
        ttlSeconds: 86_400,
      },
      correlationId,
    );
  }

  private checkSchedule(input: ScheduleInput): void {
    if (!REPORT_KINDS.includes(input.report)) throw validationFailed([{ field: 'report', reason: 'unknown_report' }], 'No such report.');
    if (!FREQUENCIES.includes(input.frequency)) throw validationFailed([{ field: 'frequency', reason: 'invalid' }], 'Daily, weekly or monthly.');
    if (input.frequency === 'weekly' && !(input.day !== null && input.day !== undefined && input.day >= 1 && input.day <= 7)) throw validationFailed([{ field: 'day', reason: 'weekday_required' }], 'A weekly schedule needs a weekday, 1 (Monday) to 7.');
    if (input.frequency === 'monthly' && !(input.day !== null && input.day !== undefined && input.day >= 1 && input.day <= 28)) throw validationFailed([{ field: 'day', reason: 'day_required' }], 'A monthly schedule needs a day, 1 to 28.');
  }

  /** Recipients by public id: active FMS users. */
  private async recipientIds(publicIds: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const pid of new Set(publicIds)) {
      const u = await this.deps.users.findByPublicId(this.deps.repo.pool(), pid);
      if (!u || u.status !== 'active') throw validationFailed([{ field: 'recipients', reason: 'unknown_user' }], 'Every recipient must be an active FMS user.');
      ids.push(String(u.id));
    }
    return ids;
  }

  private async owned(db: Queryable, caller: Caller, publicId: string, lock: boolean): Promise<ScheduleRow> {
    const s = await this.deps.repo.schedule(db, publicId, lock);
    if (!s || (s.ownerId !== String(caller.user.id) && !caller.user.roles.includes('admin'))) throw new AppError(404, 'NOT_FOUND', 'Schedule not found.');
    return s;
  }

  private async people(ids: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
    const found = await this.deps.users.findByIds(this.deps.repo.pool(), [...new Set(ids)]);
    return new Map(found.map((u) => [String(u.id), { id: u.publicId, name: u.fullName }]));
  }

  private async scheduleViews(rows: readonly ScheduleRow[]) {
    const people = await this.people(rows.flatMap((r) => [...r.recipients, r.ownerId]));
    return rows.map((s) => ({
      id: s.publicId,
      name: s.name,
      report: s.report,
      filters: s.filters,
      format: s.format,
      frequency: s.frequency,
      day: s.day,
      hour: s.hour,
      recipients: s.recipients.map((id) => people.get(id) ?? { id: '', name: '' }),
      owner: people.get(s.ownerId) ?? null,
      next_run_at: s.nextRunAt.toISOString(),
      version: s.version,
      created_at: s.createdAt.toISOString(),
    }));
  }

  private ctx(caller: Caller): MutationContext {
    return { userId: caller.user.id, correlationId: caller.correlationId };
  }
}

export interface ScheduleInput {
  name: string;
  report: ReportKind;
  filters?: Record<string, unknown>;
  format: FileFormat;
  frequency: Frequency;
  day?: number | null;
  hour: number;
  recipients: string[];
}

interface Sent {
  outcomes: RecipientOutcome[];
  rows: number | null;
  sizeBytes: number | null;
  error: string | null;
}

const CONTENT_TYPES: Record<FileFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** Kept filters as the report takes them: depots saved as the query string's `a,b` become a list. */
function asQuery(filters: Record<string, unknown>): ReportQuery {
  const q = { ...filters } as ReportQuery & { depot_ids?: string[] | string };
  if (typeof q.depot_ids === 'string') q.depot_ids = q.depot_ids.split(',').filter(Boolean);
  return q as ReportQuery;
}

const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(d);
