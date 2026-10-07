import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The request id for a request: the client's `X-Request-Id` when it is a
 * UUID, otherwise a new one. It is stored in audit rows (a UUID column),
 * so an arbitrary client string must never pass through (api-contract §3.2).
 */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && UUID.test(value) ? value.toLowerCase() : randomUUID();
}
