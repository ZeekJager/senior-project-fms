import { config } from '../../config';
import { pool } from '../../db';
import type { AppModule } from '../../shared/module';
import { authRouter } from './api/auth.routes';
import { authenticateWith } from './api/authenticate';
import { authenticatedWith, authorizeWith } from './api/authorize';
import { AuthService } from './application/auth.service';
import { InMemoryLoginThrottle } from './application/login-throttle';
import { TokenService } from './application/token.service';
import { AuthUserRepository } from './infrastructure/auth-user.repository';
import { SessionRepository } from './infrastructure/session.repository';

const authService = new AuthService({
  db: pool,
  users: new AuthUserRepository(),
  sessions: new SessionRepository(),
  tokens: new TokenService(config.jwtSecret),
  throttle: new InMemoryLoginThrottle(),
});

/**
 * Route middleware for every protected endpoint: sets `req.user` from the
 * access cookie or responds 401/403. Other modules import it from here.
 */
export const authenticate = authenticateWith(authService);

/**
 * `authorize('vehicle:read')` as route middleware: signs the caller in, then
 * requires one of the permission codes (401 if not signed in, 403
 * FORBIDDEN_INSUFFICIENT_ROLE if the code is missing). Every route declares
 * `authorize(...)`, `authenticated()` or `publicRoute()`; the app refuses to
 * start otherwise (docs/auth.md, Authorization).
 */
export const authorize = authorizeWith(authenticate);

/** Any signed-in user, no particular permission. */
export const authenticated = authenticatedWith(authenticate);

export { publicRoute } from '../../shared/authz/route-policy';
export { depotScope, ownDriverScope, scopeClause, type Scope } from '../../shared/authz/scope';

export { hashPassword } from './infrastructure/password-hasher';

export const authModule: AppModule = { name: 'auth', router: authRouter(authService, authenticate) };
