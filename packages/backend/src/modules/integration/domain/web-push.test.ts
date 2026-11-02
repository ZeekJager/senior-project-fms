import { createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { describe, expect, test } from 'vitest';
import { encryptPushPayload, generateVapidKeys, MAX_PAYLOAD_BYTES, pushEndpointProblem, pushTopic, vapidAuthorization, vapidKeysMatch } from './web-push';

// FMS-93: Web Push message encryption (RFC 8291) and VAPID (RFC 8292).

const b = (text: string) => Buffer.from(text, 'base64url');

// RFC 8291 Appendix A, the worked example.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow (the RFC's published example, not a credential)
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

/** What the browser does (RFC 8291 3.4, 8188): read the header, derive the key from its own private key, decrypt. */
function decrypt(body: Buffer, uaPrivate: string, auth: string): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b(uaPrivate));
  const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
  const prkKey = hmac(b(auth), ecdh.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const record = body.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString('utf8');
}

describe('push message encryption (RFC 8291)', () => {
  test('reproduces the RFC example byte for byte', () => {
    const body = encryptPushPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, b(RFC.plaintext), { salt: b(RFC.salt), serverPrivateKey: b(RFC.asPrivate) });
    // The header is 86 bytes, so the two base64url strings are joined as bytes.
    expect(body.toString('hex')).toBe(Buffer.concat([b(RFC.header), b(RFC.ciphertext)]).toString('hex'));
  });

  test('a fresh salt and key each time, which the browser decrypts', () => {
    const message = JSON.stringify({ title: 'Brakes failed on AA 3-77001', body: 'Addis Ababa — ኢትዮጵያ' });
    const one = encryptPushPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, Buffer.from(message));
    const two = encryptPushPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, Buffer.from(message));
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(decrypt(one, RFC.uaPrivate, RFC.auth)).toBe(message);
  });

  test('refuses a message too long for one record, and keys that are not a browser’s', () => {
    expect(() => encryptPushPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, Buffer.alloc(MAX_PAYLOAD_BYTES + 1))).toThrow(RangeError);
    expect(() => encryptPushPayload({ p256dh: RFC.uaPublic, auth: 'AAAA' }, Buffer.from('x'))).toThrow(/auth/);
    expect(() => encryptPushPayload({ p256dh: RFC.auth, auth: RFC.auth }, Buffer.from('x'))).toThrow(/p256dh/);
  });
});

describe('VAPID (RFC 8292)', () => {
  test('a signed token for the push service’s origin, with our contact and the public key', async () => {
    const keys = generateVapidKeys();
    expect(vapidKeysMatch(keys)).toBe(true);
    expect(vapidKeysMatch({ ...keys, privateKey: generateVapidKeys().privateKey })).toBe(false);
    const now = new Date('2026-11-01T06:00:00Z');
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', keys, 'mailto:ops@fleet.example', now);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(match[2]).toBe(keys.publicKey);
    expect(decodeProtectedHeader(match[1])).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(decodeJwt(match[1])).toEqual({ aud: 'https://fcm.googleapis.com', sub: 'mailto:ops@fleet.example', exp: now.getTime() / 1000 + 12 * 3600 });
    const pub = b(keys.publicKey);
    const verifier = await importJWK({ kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, 'ES256');
    await expect(jwtVerify(match[1], verifier, { currentDate: now })).resolves.toBeTruthy();
  });

  test('a topic per message, short enough for a push service', () => {
    expect(pushTopic('a')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(pushTopic('a')).not.toBe(pushTopic('b'));
  });
});

describe('push endpoints', () => {
  test('only https addresses of the browsers’ push services', () => {
    expect(pushEndpointProblem('https://fcm.googleapis.com/fcm/send/x')).toBeNull();
    expect(pushEndpointProblem('https://updates.push.services.mozilla.com/wpush/v2/x')).toBeNull();
    expect(pushEndpointProblem('https://wns2-par02p.notify.windows.com/w/?token=x')).toBeNull();
    expect(pushEndpointProblem('https://web.push.apple.com/x')).toBeNull();
    expect(pushEndpointProblem('http://fcm.googleapis.com/fcm/send/x')).toBe('not_https');
    expect(pushEndpointProblem('https://169.254.169.254/latest')).toBe('unknown_push_service');
    expect(pushEndpointProblem('https://fcm.googleapis.com.evil.example/x')).toBe('unknown_push_service');
    expect(pushEndpointProblem('https://user:pw@fcm.googleapis.com/x')).toBe('credentials_in_url');
    expect(pushEndpointProblem('not a url')).toBe('not_a_url');
    expect(pushEndpointProblem('http://127.0.0.1:9/x', ['127.0.0.1'], true)).toBeNull();
  });
});
