import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhook signatures (FMS-85, api-contract §15). A provider signs `<timestamp>.<raw body>` with
// HMAC-SHA256 and its shared secret, and sends:
//   X-FMS-Timestamp: 1761040800            (Unix seconds)
//   X-FMS-Signature: sha256=<hex digest>
// The timestamp is inside the signature, so a captured delivery cannot be replayed with a fresh one,
// and a delivery more than 5 minutes from the server's clock is refused.

export const SIGNATURE_HEADER = 'X-FMS-Signature';
export const TIMESTAMP_HEADER = 'X-FMS-Timestamp';
/** How far a delivery's timestamp may be from the server's clock, either way. */
export const REPLAY_WINDOW_MS = 5 * 60_000;

/** The header value for a body: what a provider (or a test) sends. */
export function signWebhook(secret: string, timestampSeconds: number, rawBody: Buffer | string): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

export type SignatureCheck =
  | { ok: true; timestamp: Date }
  | { ok: false; reason: 'missing_signature' | 'malformed_signature' | 'signature_mismatch' | 'stale_timestamp' };

/**
 * Checks a delivery in this order: both headers present and well formed, the signature matches (in
 * constant time), then the timestamp is within the window. A forged delivery is a mismatch whatever
 * its time; only a genuine one can be stale (a replay, or a provider clock that is far off).
 */
export function verifyWebhook(input: {
  secret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer;
  now: number;
}): SignatureCheck {
  const { signature, timestamp } = input;
  if (!signature || !timestamp) return { ok: false, reason: 'missing_signature' };
  if (!/^\d{1,12}$/.test(timestamp.trim()) || !/^sha256=[0-9a-f]{64}$/i.test(signature.trim())) {
    return { ok: false, reason: 'malformed_signature' };
  }
  const seconds = Number(timestamp.trim());
  const expected = Buffer.from(signWebhook(input.secret, seconds, input.rawBody).slice('sha256='.length), 'hex');
  const given = Buffer.from(signature.trim().slice('sha256='.length), 'hex');
  if (!timingSafeEqual(expected, given)) return { ok: false, reason: 'signature_mismatch' };
  if (Math.abs(input.now - seconds * 1000) > REPLAY_WINDOW_MS) return { ok: false, reason: 'stale_timestamp' };
  return { ok: true, timestamp: new Date(seconds * 1000) };
}
