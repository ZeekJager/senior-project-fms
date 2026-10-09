import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LocalDiskStorage, type DocumentStorage } from './document-storage';

async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

describe('LocalDiskStorage', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'fms-storage-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('stores, reads and removes an object under its key', async () => {
    const storage: DocumentStorage = new LocalDiskStorage(root);
    await storage.put('documents/2026/10/abc-123', Buffer.from('hello'), 'application/pdf');
    expect(await readFile(path.join(root, 'documents/2026/10/abc-123'), 'utf8')).toBe('hello');
    expect(await read(await storage.get('documents/2026/10/abc-123'))).toBe('hello');
    await storage.remove('documents/2026/10/abc-123');
    await expect(storage.get('documents/2026/10/abc-123')).rejects.toThrow();
  });

  test('never overwrites an existing object', async () => {
    const storage: DocumentStorage = new LocalDiskStorage(root);
    await storage.put('documents/x/one', Buffer.from('first'), 'image/png');
    await expect(storage.put('documents/x/one', Buffer.from('second'), 'image/png')).rejects.toThrow();
    expect(await read(await storage.get('documents/x/one'))).toBe('first');
  });

  test.each(['../escape', 'documents/../../etc/passwd', 'documents/Upper', 'documents/a b', '/abs/path', 'documents'])(
    'refuses the key %j',
    async (key) => {
      const storage: DocumentStorage = new LocalDiskStorage(root);
      await expect(storage.put(key, Buffer.from('x'), 'image/png')).rejects.toThrow(/Invalid storage key|leaves the storage root/);
    },
  );
});
