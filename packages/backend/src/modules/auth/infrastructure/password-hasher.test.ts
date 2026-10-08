import { describe, expect, test } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password-hasher';

describe('password hasher', () => {
  test('uses argon2id with the OWASP parameters and a random salt', async () => {
    const a = await hashPassword('correct horse battery staple');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hashPassword('correct horse battery staple')).not.toBe(a);
  });

  test('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'Correct horse battery staple')).toBe(false);
  });

  test('a stored value that is not an argon2 hash never verifies', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', '')).toBe(false);
  });

  test('the dummy check completes without throwing', async () => {
    await expect(verifyAgainstDummy('whatever')).resolves.toBeUndefined();
  });
});
