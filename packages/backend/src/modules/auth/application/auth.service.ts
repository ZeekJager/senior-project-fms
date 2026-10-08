import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import type { RequestUser } from '../../../types/express';
import {
  accountDisabled,
  invalidCredentials,
  loginThrottled,
  tokenExpired,
  tokenInvalid,
  tokenRevoked,
} from '../domain/auth-errors';
import { REFRESH_TOKEN_TTL_SECONDS } from '../domain/auth-policy';
import { writeAuthAudit, type AuthAuditEvent } from '../infrastructure/auth-audit';
import type { AuthUserRepository, Principal, UserProfile } from '../infrastructure/auth-user.repository';
import { verifyAgainstDummy, verifyPassword } from '../infrastructure/password-hasher';
import type { SessionRepository } from '../infrastructure/session.repository';
import type { LoginThrottle } from './login-throttle';
import { hashRefreshToken, newRefreshToken, type TokenService } from './token.service';

/** Where a request came from; recorded with every auth audit event. */
export interface RequestMeta {
  correlationId: string;
  ip: string | undefined;
  userAgent: string | undefined;
}

/** The two tokens the API layer puts in cookies. Never sent in a body. */
export interface IssuedSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

/** GET /auth/me, also returned by login and refresh. */
export interface CurrentUserView {
  user: UserProfile;
  roles: string[];
  permissions: string[];
}

export interface AuthServiceDeps {
  db: Pool;
  users: AuthUserRepository;
  sessions: SessionRepository;
  tokens: TokenService;
  throttle: LoginThrottle;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * Checks the password, then the account status, then starts a new session
   * family. Unknown email and wrong password fail identically, in the same
   * time. Every attempt is audited.
   */
  async login(email: string, password: string, meta: RequestMeta): Promise<IssuedSession> {
    const { db, users, throttle } = this.deps;
    const throttleKey = `${email.toLowerCase()}|${meta.ip ?? ''}`;
    const audit = (e: Pick<AuthAuditEvent, 'action' | 'actorId' | 'subjectId' | 'details'>) =>
      writeAuthAudit(db, { ...e, ...meta });

    const retryAfter = throttle.retryAfter(throttleKey);
    if (retryAfter > 0) {
      await audit({ action: 'auth.login_throttled', actorId: null, subjectId: null, details: { email } });
      throw loginThrottled(retryAfter);
    }

    const user = await users.findCredentialsByEmail(db, email);
    let passwordOk = false;
    if (user) passwordOk = await verifyPassword(user.passwordHash, password);
    else await verifyAgainstDummy(password);
    if (!user || !passwordOk) {
      throttle.recordFailure(throttleKey);
      await audit({
        action: 'auth.login_failed',
        actorId: null,
        subjectId: user?.id ?? null,
        details: { email, reason: 'invalid_credentials' },
      });
      throw invalidCredentials();
    }

    // Only after the password is right, so status never leaks for a guessed email.
    if (user.status !== 'active') {
      await audit({
        action: 'auth.login_failed',
        actorId: null,
        subjectId: user.id,
        details: { email, reason: 'account_disabled', status: user.status },
      });
      throw accountDisabled();
    }

    throttle.reset(throttleKey);
    const familyId = randomUUID();
    const refreshToken = newRefreshToken();
    const principal = await withTransaction(db, async (client) => {
      await this.deps.sessions.create(client, {
        userId: user.id,
        familyId,
        tokenHash: hashRefreshToken(refreshToken),
        ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
      });
      await users.recordLogin(client, user.id);
      await writeAuthAudit(client, { action: 'auth.login_succeeded', actorId: user.id, subjectId: user.id, ...meta });
      return users.findPrincipalById(client, user.id);
    });
    if (!principal) throw new Error(`user ${user.id} vanished during login`);

    return this.issue(principal, familyId, refreshToken);
  }

  /**
   * Rotates the refresh token: the presented one is revoked and a new one is
   * issued in the same family. A token that was already rotated or revoked
   * means it was copied, so the whole family is revoked.
   */
  async refresh(refreshToken: string | undefined, meta: RequestMeta): Promise<IssuedSession> {
    const { db, sessions, users } = this.deps;
    if (!refreshToken) throw tokenInvalid();

    const session = await sessions.findByTokenHash(db, hashRefreshToken(refreshToken));
    if (!session) throw tokenInvalid();
    if (session.revoked) return this.rejectReuse(session.familyId, session.userId, meta);
    if (session.expired) throw tokenExpired();

    const principal = await users.findPrincipalById(db, session.userId);
    if (!principal || principal.status !== 'active') {
      await sessions.revokeFamily(db, session.familyId);
      throw accountDisabled();
    }

    const next = newRefreshToken();
    const rotated = await withTransaction(db, async (client) => {
      // Conditional revoke: if a concurrent request rotated it first, this
      // one is the second use of the same token.
      if (!(await sessions.revoke(client, session.id))) return false;
      await sessions.create(client, {
        userId: session.userId,
        familyId: session.familyId,
        tokenHash: hashRefreshToken(next),
        ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
      });
      return true;
    });
    if (!rotated) return this.rejectReuse(session.familyId, session.userId, meta);

    return this.issue(principal, session.familyId, next);
  }

  /** Ends the session family of the presented refresh token. Idempotent. */
  async logout(refreshToken: string | undefined, meta: RequestMeta): Promise<void> {
    const { db, sessions } = this.deps;
    if (!refreshToken) return;
    const session = await sessions.findByTokenHash(db, hashRefreshToken(refreshToken));
    if (!session) return;
    await withTransaction(db, async (client) => {
      await sessions.revokeFamily(client, session.familyId);
      await writeAuthAudit(client, {
        action: 'auth.logout',
        actorId: session.userId,
        subjectId: session.userId,
        ...meta,
      });
    });
  }

  /**
   * Resolves an access token to the caller. Loads roles and status from the
   * database on every request, so a disabled user, a changed role or a
   * revoked session takes effect immediately rather than when the token
   * expires.
   */
  async authenticate(accessToken: string | undefined): Promise<RequestUser> {
    const { db, sessions, tokens, users } = this.deps;
    const claims = await tokens.verifyAccessToken(accessToken);
    const principal = await users.findPrincipalByPublicId(db, claims.userId);
    if (!principal) throw tokenInvalid();
    if (principal.status !== 'active') throw accountDisabled();
    if (!(await sessions.isFamilyActive(db, claims.sessionFamilyId))) throw tokenRevoked();
    return {
      id: principal.id,
      publicId: principal.publicId,
      roles: principal.roles,
      permissions: principal.permissions,
      depotId: principal.depotId,
    };
  }

  async currentUser(userId: string): Promise<CurrentUserView> {
    const { db, users } = this.deps;
    const profile = await users.findProfile(db, userId);
    const principal = await users.findPrincipalById(db, userId);
    if (!profile || !principal) throw tokenInvalid();
    return { user: profile, roles: principal.roles, permissions: principal.permissions };
  }

  private async issue(principal: Principal, familyId: string, refreshToken: string): Promise<IssuedSession> {
    const accessToken = await this.deps.tokens.signAccessToken({ userId: principal.publicId, sessionFamilyId: familyId });
    return { userId: principal.id, accessToken, refreshToken };
  }

  private async rejectReuse(familyId: string, userId: string, meta: RequestMeta): Promise<never> {
    const { db, sessions } = this.deps;
    await withTransaction(db, async (client) => {
      await sessions.revokeFamily(client, familyId);
      await writeAuthAudit(client, {
        action: 'auth.refresh_reuse_detected',
        actorId: null,
        subjectId: userId,
        details: { session_family_id: familyId },
        ...meta,
      });
    });
    throw tokenRevoked();
  }
}
