import { AppError } from '../../../shared/errors/app-error';

// The audit trail as GET /audit-logs returns it (api-contract §5.2, FMS-28).
// Read-only: rows are written by the API with each mutation and auth event.

export type AuditActor =
  | { type: 'user'; id: string | null; full_name: string | null; email: string | null }
  /** A scheduled job (request source actor: system). */
  | { type: 'system' }
  /** Not signed in: a failed or throttled login. */
  | { type: 'anonymous' };

export interface AuditLogView {
  /** Opaque, unique per row; also a valid `cursor` (the page after this row). */
  id: string;
  occurred_at: string;
  action: string;
  /** success, denied or failed; null on rows written before FMS-27. */
  result: string | null;
  actor: AuditActor;
  entity_type: string | null;
  /** The entity's public id, when the row carries one (mutations, account events). */
  entity_id: string | null;
  correlation_id: string;
  /** channel, ip, user_agent (and actor and job for jobs); null on rows written before FMS-27. */
  request_source: Record<string, unknown> | null;
  /** Row values before and after, without internal numeric ids; money stays in integer minor units. */
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  details: Record<string, unknown>;
}

export const MAX_PAGE_SIZE = 200;

/** The most actions one `action` filter may list. */
export const MAX_ACTIONS = 10;

/** One action (`UPDATE`, `auth.login_failed`), or a prefix of actions ending in `.*` (`auth.*`). */
const ACTION = /^[A-Za-z_]+(\.[A-Za-z_]+)*(\.\*)?$/;

/** The `action` filter: actions matched exactly, and prefixes (without their `*`) matched at the start. */
export interface ActionFilter {
  exact: string[];
  prefixes: string[];
}

/**
 * `action` as sent: one or more actions, comma-separated, each exact or a
 * prefix (`INSERT,UPDATE,DELETE`, `auth.*`), so one view can show every data
 * change or every sign-in event. Null when a part is malformed or there are
 * more than MAX_ACTIONS.
 */
export function parseActions(value: string): ActionFilter | null {
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length > MAX_ACTIONS || !parts.every((p) => ACTION.test(p))) return null;
  return {
    exact: parts.filter((p) => !p.endsWith('.*')),
    prefixes: parts.filter((p) => p.endsWith('.*')).map((p) => p.slice(0, -1)),
  };
}

/** Columns that hold internal numeric ids (a row's own `id`, or a reference to another row's). */
const INTERNAL_REF = /^(id|.+_id|created_by|assigned_by|logged_by|uploaded_by|performed_by|deleted_by|completed_by)$/;
const NUMERIC = /^\d+$/;

/**
 * The stored values without internal ids: the API exposes public ids only
 * (CONVENTIONS.md, IDs). A numeric value under an id-like key is dropped;
 * `public_id` and every other field stay.
 */
export function withoutInternalIds(values: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!values) return null;
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => !(INTERNAL_REF.test(key) && (typeof value === 'number' || (typeof value === 'string' && NUMERIC.test(value))))),
  );
}

/** A position in the newest-first order: the row's timestamp (microseconds, UTC) and id. */
export interface AuditCursor {
  at: string;
  id: string;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`).toString('base64url');
}

export function decodeCursor(token: string): AuditCursor {
  const [at, id, extra] = Buffer.from(token, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !CURSOR_AT.test(at ?? '') || !NUMERIC.test(id ?? '') || id.length > 19) throw invalidCursor();
  return { at, id };
}

export const invalidCursor = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The cursor is not valid. Start again from the first page.', [{ field: 'cursor', reason: 'invalid_cursor' }]);
