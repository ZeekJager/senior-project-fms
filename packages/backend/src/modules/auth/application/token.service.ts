import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, errors, jwtVerify, type JWTPayload } from 'jose';
import { authenticationRequired, tokenExpired, tokenInvalid } from '../domain/auth-errors';
import { ACCESS_TOKEN_TTL_SECONDS } from '../domain/auth-policy';

const ISSUER = 'fms-backend';
const AUDIENCE = 'fms-web';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessClaims {
  /** The user's public_id. Internal ids never leave the server. */
  userId: string;
  /** The refresh-session family; revoking the family ends this token too. */
  sessionFamilyId: string;
}

/** Signs and verifies access JWTs (HS256, key from config). */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  signAccessToken(claims: AccessClaims): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    return new SignJWT({ sid: claims.sessionFamilyId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.key);
  }

  /** Throws AUTH_TOKEN_EXPIRED or AUTH_TOKEN_INVALID (401). */
  async verifyAccessToken(token: string | undefined): Promise<AccessClaims> {
    if (!token) throw authenticationRequired();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: new Date(this.now()),
      }));
    } catch (err) {
      throw err instanceof errors.JWTExpired ? tokenExpired() : tokenInvalid();
    }
    const { sub, sid } = payload;
    if (typeof sub !== 'string' || !UUID.test(sub) || typeof sid !== 'string' || !UUID.test(sid)) {
      throw tokenInvalid();
    }
    return { userId: sub, sessionFamilyId: sid };
  }
}

/** An opaque refresh token: 256 random bits. Only its hash is stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
