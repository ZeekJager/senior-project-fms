import type { PoolClient } from 'pg';
import { describe, expect, test } from 'vitest';
import { AppError } from '../../../shared/errors/app-error';
import { InProcessEventBus } from '../../../shared/events/in-process-event-bus';
import type { RequestUser } from '../../../types/express';
import type { Caller } from './caller';
import { DocumentService, type DocumentServiceDeps } from './document.service';
import { DocumentUrlSigner } from './document-url';

const VEHICLE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const user: RequestUser = {
  id: '10',
  publicId: '11111111-1111-4111-8111-111111111111',
  roles: ['depot_admin'],
  permissions: ['vehicle:read', 'document:write'],
  depotId: '5',
};
const caller: Caller = { user, correlationId: '22222222-2222-4222-8222-222222222222' };

function harness(options: { insertFails?: boolean; ownerVisible?: boolean } = {}) {
  const storage = { put: [] as string[], removed: [] as string[] };
  const deps: DocumentServiceDeps = {
    documents: {
      inTransaction: (fn) => fn({} as PoolClient),
      findLive: async () => null,
      findById: async () => {
        throw new Error('not used');
      },
      insert: async () => {
        if (options.insertFails) throw new Error('database down');
        return { id: '1' };
      },
      softDelete: async () => ({ id: '1' }),
    },
    storage: {
      put: async (key) => void storage.put.push(key),
      get: async () => {
        throw new Error('not used');
      },
      remove: async (key) => void storage.removed.push(key),
    },
    urls: new DocumentUrlSigner('unit-test-signing-key-at-least-32-characters'),
    vehicles: { findRef: async () => (options.ownerVisible === false ? null : { id: '7', publicId: VEHICLE }) },
    drivers: { findByPublicId: async () => null, findById: async () => null },
    users: { findByIds: async () => [] },
    events: new InProcessEventBus(() => {}),
  };
  return { service: new DocumentService(deps), storage };
}

const input = (bytes: Buffer) => ({
  owner_type: 'vehicle' as const,
  owner_id: VEHICLE,
  document_type: 'registration' as const,
  file: { bytes, originalName: 'x.png' },
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).code;
}

describe('DocumentService.upload', () => {
  test('a file the database could not record is removed from storage again', async () => {
    const { service, storage } = harness({ insertFails: true });
    await expect(service.upload(caller, input(PNG))).rejects.toThrow('database down');
    expect(storage.put).toHaveLength(1);
    expect(storage.removed).toEqual(storage.put);
  });

  test('keys are random and never come from the filename', async () => {
    const a = harness({ insertFails: true });
    await a.service.upload(caller, input(PNG)).catch(() => {});
    await a.service.upload(caller, input(PNG)).catch(() => {});
    expect(a.storage.put[0]).toMatch(/^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(a.storage.put[0]).not.toBe(a.storage.put[1]);
    expect(a.storage.put.join()).not.toContain('x.png');
  });

  test('nothing is stored for a wrong type, an oversized file or an owner the caller cannot read', async () => {
    for (const [h, bytes, code] of [
      [harness(), Buffer.from('plain text'), 'UNSUPPORTED_MEDIA_TYPE'],
      [harness(), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), 'PAYLOAD_TOO_LARGE'],
      [harness({ ownerVisible: false }), PNG, 'VALIDATION_FAILED'],
    ] as const) {
      expect(await codeOf(h.service.upload(caller, input(bytes)))).toBe(code);
      expect(h.storage.put).toEqual([]);
    }
  });
});
