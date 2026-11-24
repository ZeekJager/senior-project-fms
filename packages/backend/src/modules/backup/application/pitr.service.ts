import { aggregateKey, createEvent, deterministicEventId } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import type { Pool } from 'pg';
import { backupFindings, isOffsite, pitrOverview, type BackupFinding, type BaseBackupView, type PitrOverview } from '../domain/pitr';
import type { BackupRepository } from '../infrastructure/backup.repository';

/** The event a backup risk raises; alert rule BackupAtRisk (docs/alerts.md) makes it an alert for administrators. */
export const BACKUP_AT_RISK = 'BackupAtRisk';

export interface PitrServiceDeps {
  db: Pool;
  backups: BackupRepository;
  events: EventBus;
  now?: () => Date;
}

/**
 * Point-in-time recovery (FMS-108, docs/backups.md): what the database container recorded, read for the Backups
 * screen (GET /system/backups meta.pitr, GET /system/base-backups), System health's Backups component, and the
 * backup-monitor job, which raises an alert for each risk once. The API never runs pgBackRest: the container does.
 */
export class PitrService {
  constructor(private readonly deps: PitrServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async overview(): Promise<PitrOverview> {
    return pitrOverview(await this.deps.backups.pitrState(this.deps.db), this.now());
  }

  async findings(): Promise<{ enabled: boolean; findings: BackupFinding[] }> {
    const state = await this.deps.backups.pitrState(this.deps.db);
    return { enabled: state.archiver.enabled, findings: backupFindings(state, this.now()) };
  }

  async baseBackups(page: number, pageSize: number): Promise<{ items: BaseBackupView[]; total: number }> {
    const { rows, total } = await this.deps.backups.listBaseBackups(this.deps.db, page, pageSize);
    return {
      items: rows.map((r) => ({
        id: r.publicId,
        label: r.label,
        type: r.type,
        triggered_by: r.triggeredBy,
        repo: r.repoKey,
        location: isOffsite(r.repoKey) ? 'offsite' : 'local',
        status: r.status,
        started_at: r.startedAt,
        finished_at: r.finishedAt,
        size_bytes: r.sizeBytes,
        repo_size_bytes: r.repoSizeBytes,
        error: r.error,
      })),
      total,
    };
  }

  /**
   * The backup-monitor job, every minute: a BackupAtRisk event per risk found. Its id is fixed by the risk and the
   * moment it began, so a risk that goes on is published once, and one that comes back after clearing is new.
   */
  async monitor(correlationId: string): Promise<Record<string, unknown>> {
    const { findings } = await this.findings();
    if (findings.length === 0) return { at_risk: 0 };
    const events = findings.map((f) => {
      const key = `${f.condition}:${f.repoKey ?? 'all'}`;
      return createEvent(
        BACKUP_AT_RISK,
        {
          condition: f.condition,
          severity: f.severity,
          repo: f.repoKey,
          since: f.since.toISOString(),
          message: f.message,
        },
        { actor: null, correlationId },
        { id: deterministicEventId(`${BACKUP_AT_RISK}:${key}:${f.since.toISOString()}`), aggregate: aggregateKey('backup', key) },
      );
    });
    await withTransaction(this.deps.db, (client) => this.deps.events.publish(client, events));
    return { at_risk: findings.length, critical: findings.filter((f) => f.severity === 'critical').length };
  }
}
