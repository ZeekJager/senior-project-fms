import { describe, expect, test } from 'vitest';
import { REPLAY_WINDOW_MS, signWebhook, verifyWebhook } from './webhook-signature';

const SECRET = 'w'.repeat(40);
const NOW = Date.parse('2026-10-21T09:00:00Z');
const seconds = (ms: number) => Math.floor(ms / 1000);
const body = Buffer.from('{"event_id":"evt-1","kind":"position"}');

const check = (over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) => {
  const ts = seconds(NOW);
  return verifyWebhook({ secret: SECRET, signature: signWebhook(SECRET, ts, body), timestamp: String(ts), rawBody: body, now: NOW, ...over });
};

describe('verifyWebhook', () => {
  test('accepts a delivery signed with the secret over the timestamp and the exact body', () => {
    expect(check()).toEqual({ ok: true, timestamp: new Date(seconds(NOW) * 1000) });
  });

  test('refuses a delivery without headers, or with headers it cannot read', () => {
    expect(check({ signature: undefined })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check({ signature: 'md5=abc' })).toEqual({ ok: false, reason: 'malformed_signature' });
    expect(check({ timestamp: '2026-10-21T09:00:00Z' })).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  test('refuses another secret, a changed body, or a timestamp swapped after signing', () => {
    expect(check({ secret: 'x'.repeat(40) })).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(check({ rawBody: Buffer.from('{"event_id":"evt-2","kind":"position"}') })).toEqual({ ok: false, reason: 'signature_mismatch' });
    expect(check({ timestamp: String(seconds(NOW) + 1) })).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  test('refuses a genuine delivery more than 5 minutes old (a replay) or ahead of the clock', () => {
    const at = (offsetMs: number) => {
      const ts = seconds(NOW + offsetMs);
      return check({ timestamp: String(ts), signature: signWebhook(SECRET, ts, body) });
    };
    expect(at(-REPLAY_WINDOW_MS).ok).toBe(true);
    expect(at(-REPLAY_WINDOW_MS - 1000)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(at(REPLAY_WINDOW_MS)).toMatchObject({ ok: true });
    expect(at(REPLAY_WINDOW_MS + 1000)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });
});
