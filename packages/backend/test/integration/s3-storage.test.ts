import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { S3Storage } from '../../src/shared/storage/document-storage';

/**
 * The S3 adapter against a real S3-compatible service. Runs only when
 * S3_TEST_ENDPOINT is set (e.g. a local MinIO, docs/testing.md); CI has no
 * bucket and skips it.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe.skipIf(!endpoint)('S3Storage (S3_TEST_ENDPOINT)', () => {
  const storage = new S3Storage({
    driver: 's3',
    endpoint,
    region: process.env.S3_TEST_REGION ?? 'us-east-1',
    bucket: process.env.S3_TEST_BUCKET ?? 'fms-test',
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
  });

  test('stores, reads, refuses to overwrite and removes an object', async () => {
    const key = `documents/test/${randomUUID()}`;
    const bytes = Buffer.from('%PDF-1.4\nhello\n');
    await storage.put(key, bytes, 'application/pdf');
    expect(Buffer.compare(await read(await storage.get(key)), bytes)).toBe(0);
    await expect(storage.put(key, Buffer.from('other'), 'application/pdf')).rejects.toThrow();
    await storage.remove(key);
    await expect(storage.get(key)).rejects.toThrow();
  });
});
