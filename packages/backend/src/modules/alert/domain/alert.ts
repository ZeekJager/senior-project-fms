import { AppError } from '../../../shared/errors/app-error';

// Alerts (FMS-92, architecture §9.4 and §34): a business event that needs someone's attention, kept in
// alert.alerts before anyone is told, then acknowledged, resolved, or escalated when nobody acts.

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AlertSeverity = (typeof SEVERITIES)[number];

export const STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export type AlertStatus = (typeof STATUSES)[number];

/** An alert someone still has to deal with: a repeat of its source updates it, and only these escalate. */
export const ACTIVE_STATUSES: readonly AlertStatus[] = ['open', 'acknowledged'];

const RANK: Record<AlertSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/** The more severe of two: a repeat never lowers an alert's severity. */
export const moreSevere = (a: AlertSeverity, b: AlertSeverity): AlertSeverity => (RANK[a] >= RANK[b] ? a : b);

/** P1 (critical) to P4 (low): the order a dispatcher works through them. */
export const priorityOf = (severity: AlertSeverity): 1 | 2 | 3 | 4 => (5 - RANK[severity]) as 1 | 2 | 3 | 4;

export const ALERT_EVENTS = {
  /** A new alert. The real-time gateway forwards it as `alert.created` to the depot's `alerts` room. */
  created: 'AlertCreated',
  /** A repeat of its source within the window: one more occurrence, perhaps a higher severity. Forwarded as `alert.updated`. */
  updated: 'AlertUpdated',
  acknowledged: 'AlertAcknowledged',
  resolved: 'AlertResolved',
  /** A critical alert left unacknowledged went to the next tier of recipients. Forwarded as `alert.updated`. */
  escalated: 'AlertEscalated',
} as const;

/** An alert as the API returns it (api-contract §16.3). Public ids only. */
export interface AlertView {
  id: string;
  type: string;
  severity: AlertSeverity;
  priority: 1 | 2 | 3 | 4;
  status: AlertStatus;
  title: string;
  message: string | null;
  depot_id: string | null;
  vehicle_id: string | null;
  driver_id: string | null;
  trip_id: string | null;
  /** What it is about, by public id: a vehicle, driver, document, fuel anomaly, incident ... */
  entity_type: string | null;
  entity_id: string | null;
  source: { module: string; event_type: string | null };
  occurrence_count: number;
  last_occurred_at: string;
  escalation_level: number;
  escalated_at: string | null;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

export const alertNotFound = () => new AppError(404, 'NOT_FOUND', 'Alert not found.');

/** Acknowledging an alert that is no longer open, or resolving one that is already closed. */
export const alertNotActive = (status: AlertStatus, action: 'acknowledge' | 'resolve') =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `An ${status} alert cannot be ${action === 'acknowledge' ? 'acknowledged' : 'resolved'}.`, [
    { field: 'status', reason: `alert_${status}` },
  ]);
