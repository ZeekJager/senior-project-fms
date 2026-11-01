import { createHash } from 'node:crypto';
import { AppError } from '../../../shared/errors/app-error';
import type { AlertSeverity } from './alert';

// Alerts outside the app (FMS-93, architecture §9.4, §34; docs/notification-channels.md): who hears about an
// alert stays the alert engine's rule (FMS-92); its severity says on which channels besides the inbox. Each
// email, SMS and push is an alert.notifications row of its own, queued with the alert and sent by the
// delivery job, which records every attempt on it.

export const DELIVERY_CHANNELS = ['email', 'sms', 'push'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export type NotificationChannel = 'in_app' | DeliveryChannel;
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'cancelled';

/**
 * The channel rules: everyone an alert notifies gets it in the inbox; a critical alert also by email, SMS (to
 * those with a phone number) and push (to every device they turned it on for); a high one by push. Lower
 * severities stay in the app. Escalations of a critical alert go out the same way to the next tier.
 */
export const CHANNELS_BY_SEVERITY: Record<AlertSeverity, readonly DeliveryChannel[]> = {
  critical: ['email', 'sms', 'push'],
  high: ['push'],
  medium: [],
  low: [],
};

/** Attempts per message, the first included. After the last, it is failed. */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** Minutes to wait after attempt n (1-based) failed: 1, 5, 15, then 60. */
export const RETRY_AFTER_MINUTES = [1, 5, 15, 60] as const;
/** A claimed message is due again after this long, if the instance sending it dies mid-send. */
export const CLAIM_LEASE_MINUTES = 5;
/** Messages sent per batch; the job takes batches until none is due. */
export const DELIVERY_BATCH = 20;

/** When a message whose attempt `attempts` (1-based) failed is next due, or null when that was its last. */
export function nextAttemptAt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return null;
  const minutes = RETRY_AFTER_MINUTES[Math.min(attempts, RETRY_AFTER_MINUTES.length) - 1];
  return new Date(now.getTime() + minutes * 60_000);
}

/** Why a queued message was dropped without being sent. */
export const CANCEL_REASONS = {
  alertClosed: 'The alert was resolved before it was sent.',
  noDestination: 'The recipient has no address for this channel any more.',
  recipientInactive: 'The recipient’s account is no longer active.',
} as const;

const SEVERITY_WORD: Record<AlertSeverity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

const addis = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Addis_Ababa',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "3 Oct 2026, 08:15", Addis Ababa. */
export const addisTime = (d: Date) => addis.format(d);

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** What the alert is about, for the screen a push or an email link opens (the inbox's links, FMS-48). */
export function alertPath(entityType: string | null, entityId: string | null): string {
  switch (entityType) {
    case 'dvir_report':
    case 'maintenance_prediction':
      return '/maintenance';
    case 'vehicle':
    case 'document':
      return '/vehicles';
    case 'driver':
      return '/drivers';
    case 'fuel_anomaly':
      return entityId ? `/fuel-reconciliation?tab=anomalies&anomaly=${encodeURIComponent(entityId)}` : '/fuel-reconciliation';
    case 'telemetry_flag':
    case 'incident':
      return '/command-center?view=attention';
    default:
      return '/';
  }
}

export interface MessageFacts {
  severity: AlertSeverity;
  /** The notification's title and message, as in the inbox. */
  title: string;
  message: string;
  raisedAt: Date;
  /** Where it opens in the app (alertPath), and the app's public URL for an email's link (null: no link). */
  path: string;
  appUrl: string | null;
  alertId: string;
}

/** An email: the severity in the subject, the message, when, and a link when the app's URL is known. Plain text. */
export function emailContent(f: MessageFacts): { subject: string; text: string } {
  const lines = [f.message, '', `Severity: ${SEVERITY_WORD[f.severity]}`, `Raised: ${addisTime(f.raisedAt)} (Addis Ababa)`];
  if (f.appUrl) lines.push('', `Open it in FMS: ${f.appUrl}${f.path}`);
  lines.push('', `You are getting this because ${f.severity} alerts reach you by email. They are in your FMS notifications as well.`);
  return { subject: cut(`[${SEVERITY_WORD[f.severity]}] ${f.title}`, 200), text: lines.join('\n') };
}

/** An SMS: at most two parts' worth, the severity first. */
export const SMS_MAX_LENGTH = 300;
export function smsText(f: Pick<MessageFacts, 'severity' | 'title' | 'message'>): string {
  const body = f.message && f.message !== f.title ? `${f.title}. ${f.message}` : f.title;
  return cut(`FMS ${SEVERITY_WORD[f.severity].toUpperCase()}: ${body}`, SMS_MAX_LENGTH);
}

/** A push notification: title, body, and what it opens. One per alert on a device (`tag`), the latest replacing the last. */
export function pushContent(f: MessageFacts): { subject: string; text: string; data: Record<string, unknown> } {
  return {
    subject: cut(f.title, 120),
    text: cut(f.message, 240),
    data: { url: f.path, alert_id: f.alertId, tag: `alert-${f.alertId}`, severity: f.severity },
  };
}

/** How long a push service may hold a message for a phone that is off: an alert loses its point after a while. */
export const PUSH_TTL_SECONDS: Record<AlertSeverity, number> = { critical: 24 * 3600, high: 6 * 3600, medium: 3600, low: 3600 };

/** One message of an alert (GET /alerts/{id}/deliveries). No email address or phone number: who, not where. */
export interface DeliveryView {
  id: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  /** `alert` or `alert_escalated`. */
  type: string;
  recipient: { id: string | null; name: string | null };
  attempts: number;
  /** The provider's code (`smtp-main`), once one took it. */
  provider: string | null;
  provider_message_id: string | null;
  queued_at: Date;
  sent_at: Date | null;
  failed_at: Date | null;
  /** While queued after a failed attempt: when the next is due. */
  next_attempt_at: Date | null;
  /** The last failure, in our words (a status, a timeout), never the provider's. */
  failure_reason: string | null;
  /** In-app only: when the recipient read it. */
  read_at: Date | null;
}

/** GET /notifications/channels: what reaches the caller where, for the settings screen. */
export interface ChannelsView {
  rules: { severity: AlertSeverity; channels: NotificationChannel[] }[];
  email: { available: boolean; address: string };
  sms: { available: boolean; phone: string | null };
  /** `devices`: the caller's browsers with push on; `device_keys`: their endpointKey, so a browser can tell whether it is one. */
  push: { available: boolean; public_key: string | null; devices: number; device_keys: string[] };
}

/**
 * A short fingerprint of a push endpoint (SHA-256, base64url, 22 characters): a browser compares it with its own
 * endpoint's, without the endpoint, a credential to push to it, going back and forth.
 */
export const endpointKey = (endpoint: string) => createHash('sha256').update(endpoint).digest('base64url').slice(0, 22);

export const pushSubscriptionInvalid = (reason: string) =>
  new AppError(400, 'VALIDATION_FAILED', 'This push subscription cannot be used.', [{ field: 'endpoint', reason }]);

/** No push provider is on: there is nothing to subscribe to or send with. */
export const pushUnavailable = () => new AppError(503, 'UPSTREAM_UNAVAILABLE', 'Push notifications are not set up on this server.');
