import { describe, expect, test } from 'vitest';
import { MAX_ERROR_LENGTH, backupFilename, backupKey, dumpError } from './backup';
import { BackupLinkSigner } from './backup-link';

const ID = '3f1c2a9e-7b4d-4e21-9a55-0c8d1e2f3a4b';
const USER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('backup helpers (FMS-144)', () => {
  test('the download name says which database and when, in UTC', () => {
    expect(backupFilename('fms_db', new Date('2026-11-02T01:07:44Z'))).toBe('fms-fms_db-20261102-0107Z.dump');
    expect(backupFilename('odd name/db', new Date('2026-01-05T23:59:00Z'))).toBe('fms-odd_name_db-20260105-2359Z.dump');
  });

  test('the storage key is the month and the backup’s id: nothing a client steers', () => {
    expect(backupKey(ID.toUpperCase(), new Date('2026-03-31T23:00:00Z'))).toBe(`backups/2026/03/${ID}`);
  });

  test('pg_dump’s error keeps its words, drops blank lines and any password, and is bounded', () => {
    expect(dumpError('pg_dump: error: connection failed\n\n  FATAL: database "x" does not exist\n', 'fallback')).toBe(
      'pg_dump: error: connection failed\nFATAL: database "x" does not exist',
    );
    expect(dumpError('could not connect: host=db password=hunter2 user=a', 'f')).toBe('could not connect: host=db password=*** user=a');
    expect(dumpError('   ', 'pg_dump exited with code 1')).toBe('pg_dump exited with code 1');
    const long = dumpError('x'.repeat(5000), 'f');
    expect(long).toHaveLength(MAX_ERROR_LENGTH);
    expect(long.startsWith('…')).toBe(true);
  });
});

describe('BackupLinkSigner', () => {
  const secret = 'unit-test-signing-key-at-least-32-characters';

  test('a link works for its backup and admin until it expires', () => {
    let now = Date.parse('2026-11-02T01:00:00Z');
    const signer = new BackupLinkSigner(secret, () => now);
    const { url, expiresAt } = signer.sign(ID, USER);
    const q = new URL(url, 'http://x').searchParams;
    expect(url.startsWith(`/api/v1/system/backups/${ID}/content?`)).toBe(true);
    expect(expiresAt.toISOString()).toBe('2026-11-02T01:05:00.000Z');
    expect(signer.verify(ID, q.get('user')!, q.get('expires')!, q.get('signature')!)).toBe('ok');
    // Another backup, another admin, a changed expiry: not this link.
    expect(signer.verify('00000000-0000-4000-8000-000000000000', USER, q.get('expires')!, q.get('signature')!)).toBe('invalid');
    expect(signer.verify(ID, '00000000-0000-4000-8000-000000000000', q.get('expires')!, q.get('signature')!)).toBe('invalid');
    expect(signer.verify(ID, USER, String(Number(q.get('expires')) + 60), q.get('signature')!)).toBe('invalid');
    expect(signer.verify(ID, USER, undefined, q.get('signature')!)).toBe('invalid');
    now += 5 * 60 * 1000;
    expect(signer.verify(ID, USER, q.get('expires')!, q.get('signature')!)).toBe('expired');
  });

  test('a link signed under another secret is another link', () => {
    const a = new BackupLinkSigner(secret, () => 0).sign(ID, USER).url;
    const b = new BackupLinkSigner(`${secret}-other`, () => 0).sign(ID, USER).url;
    expect(a).not.toBe(b);
  });
});
