import type { Queryable } from '../../../shared/infrastructure/queryable';

export interface RefreshSession {
  id: string;
  userId: string;
  familyId: string;
  revoked: boolean;
  expired: boolean;
}

/**
 * auth.refresh_sessions. Writes skip auditedMutation on purpose: an audit
 * row would copy token_hash into the audit log. The auth audit events
 * (login, logout, reuse) record what happened instead.
 */
export class SessionRepository {
  async create(
    db: Queryable,
    session: { userId: string; familyId: string; tokenHash: string; ttlSeconds: number },
  ): Promise<void> {
    await db.query(
      `INSERT INTO auth.refresh_sessions (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + make_interval(secs => $4))`,
      [session.userId, session.familyId, session.tokenHash, session.ttlSeconds],
    );
  }

  async findByTokenHash(db: Queryable, tokenHash: string): Promise<RefreshSession | null> {
    const res = await db.query<RefreshSession>(
      `SELECT id, user_id AS "userId", family_id AS "familyId",
              revoked_at IS NOT NULL AS revoked,
              expires_at <= CURRENT_TIMESTAMP AS expired
         FROM auth.refresh_sessions
        WHERE token_hash = $1`,
      [tokenHash],
    );
    return res.rows[0] ?? null;
  }

  /** Revokes one session. False when it was already revoked (lost a race with another use). */
  async revoke(db: Queryable, id: string): Promise<boolean> {
    const res = await db.query(
      'UPDATE auth.refresh_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
    return res.rowCount === 1;
  }

  async revokeFamily(db: Queryable, familyId: string): Promise<void> {
    await db.query(
      'UPDATE auth.refresh_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId],
    );
  }

  /** True while the family has an unrevoked, unexpired session (the user is still signed in). */
  async isFamilyActive(db: Queryable, familyId: string): Promise<boolean> {
    const res = await db.query(
      `SELECT 1 FROM auth.refresh_sessions
        WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        LIMIT 1`,
      [familyId],
    );
    return res.rowCount === 1;
  }
}
