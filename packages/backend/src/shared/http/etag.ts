import { AppError, validationFailed } from '../errors/app-error';

/**
 * Optimistic concurrency (api-contract §19). A resource with a `version`
 * counter sends it as the ETag; a client that sends it back in `If-Match`
 * with a write is refused if someone changed the record in between, instead
 * of silently overwriting that change. Without `If-Match` the write goes
 * through (last write wins), so existing clients keep working.
 */
export function etagFor(version: number): string {
  return `"${version}"`;
}

/**
 * The version an `If-Match` header requires, or null when there is none or it
 * is `*`. A weak tag (`W/"3"`) is accepted. Anything else is 400.
 */
export function ifMatchVersion(header: string | undefined): number | null {
  const value = header?.trim();
  if (!value || value === '*') return null;
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(value);
  if (!match) throw validationFailed([{ field: 'If-Match', reason: 'invalid_format' }], 'If-Match must be an ETag such as "3".');
  return Number(match[1]);
}

export const staleVersion = () =>
  new AppError(409, 'CONFLICT_CONCURRENT_MODIFICATION', 'The record was changed by someone else. Reload it and try again.');
