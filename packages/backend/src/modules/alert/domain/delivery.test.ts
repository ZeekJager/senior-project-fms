import { describe, expect, test } from 'vitest';
import { alertPath, CHANNELS_BY_SEVERITY, emailContent, MAX_DELIVERY_ATTEMPTS, nextAttemptAt, pushContent, SMS_MAX_LENGTH, smsText, type MessageFacts } from './delivery';

// FMS-93: which channels an alert goes out on, when a failed message is tried again, and what each one says.

const facts: MessageFacts = {
  severity: 'critical',
  title: 'Brakes failed on AA 3-77001',
  message: 'The pre-trip inspection of AA 3-77001 found 2 defects: Brakes, Lights.',
  raisedAt: new Date('2026-10-03T05:15:00Z'),
  path: '/maintenance',
  appUrl: 'https://fms.example',
  alertId: '11111111-1111-4111-8111-111111111111',
};

describe('channel rules', () => {
  test('critical: email, SMS and push; high: push; the rest stay in the app', () => {
    expect(CHANNELS_BY_SEVERITY).toEqual({ critical: ['email', 'sms', 'push'], high: ['push'], medium: [], low: [] });
  });
});

describe('retries', () => {
  test('after 1, 5, 15 and 60 minutes, then never: five attempts in all', () => {
    const now = new Date('2026-11-01T06:00:00Z');
    const after = (n: number) => (nextAttemptAt(n, now)!.getTime() - now.getTime()) / 60_000;
    expect([1, 2, 3, 4].map(after)).toEqual([1, 5, 15, 60]);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
    expect(nextAttemptAt(5, now)).toBeNull();
  });
});

describe('messages', () => {
  test('an email: the severity in the subject; when, in Addis Ababa; a link when the app’s address is known', () => {
    const { subject, text } = emailContent(facts);
    expect(subject).toBe('[Critical] Brakes failed on AA 3-77001');
    expect(text).toContain('Raised: 3 Oct 2026, 08:15 (Addis Ababa)');
    expect(text).toContain('Open it in FMS: https://fms.example/maintenance');
    expect(emailContent({ ...facts, appUrl: null }).text).not.toContain('Open it in FMS');
  });

  test('an SMS: the severity first, at most two parts', () => {
    expect(smsText(facts)).toBe('FMS CRITICAL: Brakes failed on AA 3-77001. The pre-trip inspection of AA 3-77001 found 2 defects: Brakes, Lights.');
    expect(smsText({ ...facts, message: facts.title })).toBe('FMS CRITICAL: Brakes failed on AA 3-77001');
    const long = smsText({ ...facts, message: 'x'.repeat(1000) });
    expect(long).toHaveLength(SMS_MAX_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });

  test('a push: what it opens, one per alert on a device', () => {
    expect(pushContent(facts)).toEqual({
      subject: facts.title,
      text: facts.message,
      data: { url: '/maintenance', alert_id: facts.alertId, tag: `alert-${facts.alertId}`, severity: 'critical' },
    });
  });

  test('links open the screen that deals with the alert, as the inbox’s do', () => {
    expect(alertPath('dvir_report', 'x')).toBe('/maintenance');
    expect(alertPath('fuel_anomaly', 'a b')).toBe('/fuel-reconciliation?tab=anomalies&anomaly=a%20b');
    expect(alertPath('incident', 'x')).toBe('/command-center?view=attention');
    expect(alertPath(null, null)).toBe('/');
  });
});
