import { describe, expect, test } from 'vitest';
import { DOCUMENT_URL_TTL_SECONDS, DocumentUrlSigner } from './document-url';

const SECRET = 'unit-test-signing-key-at-least-32-characters';
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function parts(url: string) {
  const q = new URL(url, 'http://x').searchParams;
  return { expires: q.get('expires') ?? undefined, signature: q.get('signature') ?? undefined };
}

describe('DocumentUrlSigner', () => {
  test('a link works for one hour, then reports expired', () => {
    let now = Date.UTC(2026, 9, 9, 8, 0, 0);
    const signer = new DocumentUrlSigner(SECRET, () => now);
    const { url, expiresAt } = signer.sign(ID);
    expect(expiresAt.getTime()).toBe(now + DOCUMENT_URL_TTL_SECONDS * 1000);
    const { expires, signature } = parts(url);

    now += 59 * 60 * 1000;
    expect(signer.verify(ID, expires, signature)).toBe('ok');
    now += 60 * 1000;
    expect(signer.verify(ID, expires, signature)).toBe('expired');
  });

  test('another document, a changed expiry, a changed signature or another key is invalid', () => {
    const signer = new DocumentUrlSigner(SECRET);
    const { expires, signature } = parts(signer.sign(ID).url);

    expect(signer.verify('9b2c6f1e-2a4d-4c1b-8e7f-0a1b2c3d4e5f', expires, signature)).toBe('invalid');
    expect(signer.verify(ID, String(Number(expires) + 1), signature)).toBe('invalid');
    expect(signer.verify(ID, expires, signature!.replace(/^./, (c) => (c === '0' ? '1' : '0')))).toBe('invalid');
    expect(new DocumentUrlSigner('another-signing-key-of-at-least-32-chars!').verify(ID, expires, signature)).toBe('invalid');
  });

  test('missing or malformed parameters are invalid, not errors', () => {
    const signer = new DocumentUrlSigner(SECRET);
    expect(signer.verify(ID, undefined, undefined)).toBe('invalid');
    expect(signer.verify(ID, 'soon', 'a'.repeat(64))).toBe('invalid');
    expect(signer.verify(ID, '1', 'xyz')).toBe('invalid');
  });

  test('the signature is not the JWT secret’s plain HMAC (a key derived for this purpose only)', async () => {
    const { createHmac } = await import('node:crypto');
    const { expires, signature } = parts(new DocumentUrlSigner(SECRET).sign(ID).url);
    expect(signature).not.toBe(createHmac('sha256', SECRET).update(`${ID}:${expires}`).digest('hex'));
  });
});
