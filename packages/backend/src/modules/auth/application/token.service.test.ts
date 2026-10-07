import { describe, expect, test } from 'vitest';
import { SignJWT } from 'jose';
import { AppError } from '../../../shared/errors/app-error';
import { ACCESS_TOKEN_TTL_SECONDS } from '../domain/auth-policy';
import { TokenService, hashRefreshToken, newRefreshToken } from './token.service';

const SECRET = 'unit-test-signing-key-at-least-32-characters';
const claims = { userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', sessionFamilyId: '9b2c6f1e-2a4d-4c1b-8e7f-0a1b2c3d4e5f' };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).code;
}

describe('TokenService', () => {
  test('a signed access token verifies to the same claims', async () => {
    const tokens = new TokenService(SECRET);
    expect(await tokens.verifyAccessToken(await tokens.signAccessToken(claims))).toEqual(claims);
  });

  test('the token expires after 15 minutes', async () => {
    let now = Date.UTC(2026, 9, 7, 8, 0, 0);
    const tokens = new TokenService(SECRET, () => now);
    const token = await tokens.signAccessToken(claims);

    now += (ACCESS_TOKEN_TTL_SECONDS - 1) * 1000;
    await expect(tokens.verifyAccessToken(token)).resolves.toEqual(claims);

    now += 2000;
    expect(await codeOf(tokens.verifyAccessToken(token))).toBe('AUTH_TOKEN_EXPIRED');
  });

  test('a missing, malformed or tampered token is AUTH_TOKEN_INVALID', async () => {
    const tokens = new TokenService(SECRET);
    const token = await tokens.signAccessToken(claims);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: claims.userId, sid: claims.sessionFamilyId, exp: 4102444800 })).toString('base64url');

    expect(await codeOf(tokens.verifyAccessToken(undefined))).toBe('AUTH_TOKEN_INVALID');
    expect(await codeOf(tokens.verifyAccessToken('not.a.jwt'))).toBe('AUTH_TOKEN_INVALID');
    expect(await codeOf(tokens.verifyAccessToken(`${header}.${forgedPayload}.${signature}`))).toBe('AUTH_TOKEN_INVALID');
  });

  test('a token signed with another key is rejected', async () => {
    const other = new TokenService('another-signing-key-of-at-least-32-chars!');
    const token = await other.signAccessToken(claims);
    expect(await codeOf(new TokenService(SECRET).verifyAccessToken(token))).toBe('AUTH_TOKEN_INVALID');
  });

  test("an unsigned token ('alg: none') is rejected", async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: claims.userId, sid: claims.sessionFamilyId, iss: 'fms-backend', aud: 'fms-web', exp: 4102444800 }),
    ).toString('base64url');
    expect(await codeOf(new TokenService(SECRET).verifyAccessToken(`${header}.${payload}.`))).toBe('AUTH_TOKEN_INVALID');
  });

  test('a validly signed token without the expected subject or session is rejected', async () => {
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('42')
      .setIssuer('fms-backend')
      .setAudience('fms-web')
      .setExpirationTime('5m')
      .sign(key);
    expect(await codeOf(new TokenService(SECRET).verifyAccessToken(token))).toBe('AUTH_TOKEN_INVALID');
  });
});

describe('refresh tokens', () => {
  test('are 256-bit random values', () => {
    const a = newRefreshToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(newRefreshToken()).not.toBe(a);
  });

  test('are stored as a SHA-256 hex digest', () => {
    const token = newRefreshToken();
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toContain(token);
  });
});
