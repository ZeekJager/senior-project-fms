import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// argon2id (the library default) with the OWASP minimum parameters:
// 19 MiB memory, 2 passes, 1 lane. Stated explicitly so a library upgrade
// cannot silently change them. Existing hashes carry their own parameters.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** False for a wrong password and for a stored value that is not an argon2 hash. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Does the work of a real check against a throwaway hash. Called for an
 * email with no account, so the response takes as long as a wrong password
 * and its timing does not reveal which emails exist.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
}
