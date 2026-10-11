import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import { authRouter } from './api/auth.routes';
import { authenticateWith } from './api/authenticate';
import { authenticatedWith, authorizeWith } from './api/authorize';
import { userAdminRouter } from './api/user-admin.routes';
import { AuthService } from './application/auth.service';
import { UserAdminService } from './application/user-admin.service';
import { InMemoryLoginThrottle } from './application/login-throttle';
import { TokenService } from './application/token.service';
import type { DepotDirectory } from './domain/depot-directory';
import { AuthUserRepository } from './infrastructure/auth-user.repository';
import { SessionRepository } from './infrastructure/session.repository';
import { UserAdminRepository } from './infrastructure/user-admin.repository';

let depotDirectory: DepotDirectory | null = null;

/**
 * Connects the fleet module's depot lookup. Called once by src/modules/index.ts:
 * auth cannot import fleet itself, since fleet imports auth.
 */
export function provideDepotDirectory(directory: DepotDirectory): void {
  depotDirectory = directory;
}

/** Fleet's depot lookup, through the connection provideDepotDirectory makes. */
function depots(): DepotDirectory {
  if (!depotDirectory) throw new Error('auth: no DepotDirectory provided; src/modules/index.ts connects the fleet module');
  return depotDirectory;
}

const depotLookup: DepotDirectory = {
  publicIdOf: (depotId) => depots().publicIdOf(depotId),
  resolveActive: (publicId, db) => depots().resolveActive(publicId, db),
};

const authService = new AuthService({
  db: pool,
  users: new AuthUserRepository(),
  sessions: new SessionRepository(),
  tokens: new TokenService(config.jwtSecret),
  throttle: new InMemoryLoginThrottle(),
  depots: depotLookup,
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
/** UserCreated, UserRoleChanged, UserDeactivated (FMS-78): payloads carry the user's public id. */
export { USER_ADMIN_EVENTS } from './domain/user-admin';
export type { DepotDirectory } from './domain/depot-directory';

const userAdminService = new UserAdminService({
  db: pool,
  users: new UserAdminRepository(),
  depots: depotLookup,
  events: eventBus,
  accountChangedEvent: USER_EVENTS.accountChanged,
});

const router = Router();
router.use(authRouter(authService, authenticate));
router.use(userAdminRouter(userAdminService, authorize));

export const authModule: AppModule = { name: 'auth', router };
