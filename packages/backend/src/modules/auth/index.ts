import { config } from '../../config';
import { pool } from '../../db';
import type { AppModule } from '../../shared/module';
import { authRouter } from './api/auth.routes';
import { authenticateWith } from './api/authenticate';
import { authenticatedWith, authorizeWith } from './api/authorize';
import { AuthService } from './application/auth.service';
import { InMemoryLoginThrottle } from './application/login-throttle';
import { TokenService } from './application/token.service';
import type { DepotDirectory } from './domain/depot-directory';
import { AuthUserRepository } from './infrastructure/auth-user.repository';
import { SessionRepository } from './infrastructure/session.repository';

let depotDirectory: DepotDirectory | null = null;

/**
 * Connects the fleet module's depot lookup. Called once by src/modules/index.ts:
 * auth cannot import fleet itself, since fleet imports auth.
 */
export function provideDepotDirectory(directory: DepotDirectory): void {
  depotDirectory = directory;
}

const authService = new AuthService({
  db: pool,
  users: new AuthUserRepository(),
  sessions: new SessionRepository(),
  tokens: new TokenService(config.jwtSecret),
  throttle: new InMemoryLoginThrottle(),
  depots: {
    publicIdOf(depotId) {
      if (!depotDirectory) throw new Error('auth: no DepotDirectory provided; src/modules/index.ts connects the fleet module');
      return depotDirectory.publicIdOf(depotId);
    },
  },
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
/** User accounts for other modules (drivers live on their account): look up, move depot. */
export { userDirectory, type UserAccount } from './infrastructure/user-directory';

/**
 * Account events. Code that changes a user's name, email, status or depot
 * outside the module that asked for it (user administration, SE users API)
 * publishes UserAccountChanged with `{ user_id }` (public id), so modules
 * that keep a copy (fleet.driver_accounts) refresh it.
 */
export const USER_EVENTS = { accountChanged: 'UserAccountChanged' } as const;
export type { DepotDirectory } from './domain/depot-directory';

export const authModule: AppModule = { name: 'auth', router: authRouter(authService, authenticate) };
