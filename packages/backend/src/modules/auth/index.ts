import { config } from '../../config';
import { pool } from '../../db';
import type { AppModule } from '../../shared/module';
import { authRouter } from './api/auth.routes';
import { authenticateWith } from './api/authenticate';
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

export { hashPassword } from './infrastructure/password-hasher';

export const authModule: AppModule = { name: 'auth', router: authRouter(authService, authenticate) };
