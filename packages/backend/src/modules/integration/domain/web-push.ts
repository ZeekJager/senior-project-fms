import { createCipheriv, createECDH, createHash, createHmac, randomBytes } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';
import type { PushTarget } from './adapter';

// Web Push (FMS-93): the message encryption of RFC 8291 (aes128gcm, RFC 8188) and the VAPID authorisation of
// RFC 8292, with node:crypto and jose. A push service only relays the bytes; only the browser that subscribed
// can read them.

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string) => Buffer.from(text, 'base64url');
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac('sha256', key).update(data).digest();

/** One record (RFC 8188): the whole message must fit, padding delimiter and tag included. */
export const RECORD_SIZE = 4096;
/** The most a message may carry: the record, less its 16-byte tag and 1-byte padding delimiter. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 17;

/** Fixed inputs for the RFC's worked example; a real message draws a fresh salt and key pair every time. */
export interface EncryptionInputs {
  salt?: Uint8Array;
  /** The application server's ephemeral P-256 private key (32 bytes). */
  serverPrivateKey?: Uint8Array;
}

/**
 * The message body for one subscription: header (salt, record size, the server's ephemeral public key) then the
 * single encrypted record. RFC 8291 section 3.4.
 */
export function encryptPushPayload(target: Pick<PushTarget, 'p256dh' | 'auth'>, plaintext: Uint8Array, inputs: EncryptionInputs = {}): Buffer {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new RangeError(`A push message carries at most ${MAX_PAYLOAD_BYTES} bytes.`);
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new RangeError('p256dh must be an uncompressed P-256 public key.');
  if (authSecret.length !== 16) throw new RangeError('auth must be 16 bytes.');

  const ecdh = createECDH('prime256v1');
  if (inputs.serverPrivateKey) ecdh.setPrivateKey(Buffer.from(inputs.serverPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = Buffer.from(inputs.salt ?? randomBytes(16));

  // Combine the ECDH secret with the auth secret (section 3.3), then derive the key and nonce (RFC 8188 2.2, 2.3).
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the last (only) record, with no padding after it.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export interface VapidKeys {
  /** The uncompressed P-256 public key, base64url (65 bytes): what browsers subscribe with. */
  publicKey: string;
  /** Its private scalar, base64url (32 bytes). A secret. */
  privateKey: string;
}

/** A fresh VAPID key pair (scripts/vapid-keys.ts). */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** Whether the two halves belong together (a key pasted into the wrong variable fails here, not at the push service). */
export function vapidKeysMatch(keys: VapidKeys): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64url(keys.privateKey));
    return b64url(ecdh.getPublicKey()) === keys.publicKey;
  } catch {
    return false;
  }
}

/** VAPID tokens last 12 hours (RFC 8292 allows up to 24). */
export const VAPID_TOKEN_SECONDS = 12 * 3600;

/**
 * The Authorization header for a push to `endpoint` (RFC 8292 section 3): a JWT signed with the VAPID private key,
 * for the push service's origin, with a contact (`mailto:` or `https:`) the push service can reach us at.
 */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: Date = new Date()): Promise<string> {
  const pub = fromB64url(keys.publicKey);
  const key = await importJWK({ kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: keys.privateKey }, 'ES256');
  const issued = Math.floor(now.getTime() / 1000);
  const jwt = await new SignJWT({ sub: subject })
    .setProtectedHeader({ typ: 'JWT', alg: 'ES256' })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime(issued + VAPID_TOKEN_SECONDS)
    .sign(key);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/** A Topic (RFC 8030 5.4) from our message id: a push service replaces an undelivered message with the same one, so a retry is not shown twice. */
export const pushTopic = (reference: string) => createHash('sha256').update(reference).digest('base64url').slice(0, 32);

/** The push services browsers subscribe with (Chrome, Edge, Firefox, Safari). A subscription elsewhere is refused. */
export const PUSH_SERVICE_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'] as const;

/**
 * Why we would not send to this endpoint, or null. The server posts to it, so it must be a push service's https
 * address (the host or a subdomain of a known one), never an address inside our network.
 */
export function pushEndpointProblem(endpoint: string, hosts: readonly string[] = PUSH_SERVICE_HOSTS, allowHttp = false): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'not_a_url';
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return 'not_https';
  if (url.username || url.password) return 'credentials_in_url';
  const host = url.hostname.toLowerCase();
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return 'unknown_push_service';
  return null;
}
