import { AppError } from '../../../shared/errors/app-error';

// The in-app inbox (FMS-48, architecture §9.4): the alert.notifications rows with channel in_app that the alert
// engine writes, one per recipient. A user sees and marks read only their own.

/**
 * The inbox shows the last 30 days (FMS-49: no history older than 30 days in the panel). The window applies to the
 * list, the unread count and mark-all-read alike, so the badge never counts what the panel does not show. Older rows
 * stay in alert.notifications; they are just no longer anyone's inbox.
 */
export const INBOX_WINDOW_DAYS = 30;

/** Which of the caller's notifications to list. */
export const INBOX_STATUSES = ['all', 'unread', 'read'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const NOTIFICATION_EVENTS = {
  /**
   * A user's unread count changed: notifications were delivered to them, or they read some. Carries the new count, so a
   * screen needs no request. The real-time gateway forwards it as `notifications.unread` to that user's own sockets.
   */
  unreadChanged: 'NotificationUnreadChanged',
} as const;

/** Why the count changed. */
export type UnreadReason = 'delivered' | 'read' | 'read_all';

/** A notification as the API returns it (api-contract §12.1). Public ids only. */
export interface NotificationView {
  id: string;
  /** What kind: `alert` or `alert_escalated` today. */
  type: string;
  title: string;
  message: string;
  /** The alert it is about, if any. */
  alert_id: string | null;
  /** What the alert is about (`vehicle`, `dvir_report`, `document`, `driver`, `fuel_anomaly`...), so a screen can link to it. */
  entity: { type: string; id: string } | null;
  /** The vehicle and the driver the alert concerns, when it has them (public ids). */
  vehicle_id: string | null;
  driver_id: string | null;
  read: boolean;
  read_at: Date | null;
  /** When it was delivered to the inbox. */
  created_at: Date;
}

/** Someone else's notification and a missing one answer the same: the caller cannot tell them apart. */
export const notificationNotFound = () => new AppError(404, 'NOT_FOUND', 'Notification not found.');
