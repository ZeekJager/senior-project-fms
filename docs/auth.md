# Authentication

Card: FMS-05 (SE-41). Code: `packages/backend/src/modules/auth/`. Contract: [api-contract.md](api-contract.md) §5.1, error codes §3.6.

## Endpoints

| Method + path | Needs | Success | Errors |
|---|---|---|---|
| `POST /api/v1/auth/login` | `{email, password}` | `200` + both cookies, body = current user | `400 VALIDATION_FAILED`, `401 AUTH_INVALID_CREDENTIALS`, `403 AUTH_ACCOUNT_DISABLED`, `429 RATE_LIMITED` (with `Retry-After`) |
| `POST /api/v1/auth/refresh` | refresh cookie | `200` + new cookies, body = current user | `401 AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_REVOKED`, `403 AUTH_ACCOUNT_DISABLED`; cookies are cleared |
| `POST /api/v1/auth/logout` | refresh cookie (optional) | `204`, cookies cleared | none |
| `GET /api/v1/auth/me` | access cookie | `200`, body = current user | `401 AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_REVOKED`, `403 AUTH_ACCOUNT_DISABLED` |

The "current user" body:

```json
{
  "data": {
    "user": { "id": "uuid", "email": "d@fms.local", "full_name": "…", "phone": null, "status": "active", "depot_id": "uuid", "last_login_at": "2026-10-07T08:00:00Z" },
    "roles": ["dispatcher"],
    "permissions": ["alert:ack", "alert:read", "…"]
  },
  "meta": { "request_id": "uuid" }
}
```

Unknown email and wrong password return the same 401, after the same amount of work, so neither the response nor its timing reveals whether an account exists. Account status is checked only after the password is correct.

Logout needs only the refresh cookie, not a valid access token, so a user whose access token has expired can still sign out.

## Tokens and cookies

| Cookie | Holds | Lifetime | Path |
|---|---|---|---|
| `fms_access` | JWT (HS256, `JWT_SECRET`), `sub` = user `public_id`, `sid` = session family | 15 min | `/` |
| `fms_refresh` | 256-bit random value; the database stores only its SHA-256 | 7 days, renewed on each refresh | `/api/v1/auth` |

Both are `HttpOnly; Secure; SameSite=Strict`. Tokens never appear in response bodies, so page scripts and `localStorage` never see them. `SameSite=Strict` is the CSRF defence: no cross-site request carries the cookies. Browsers accept `Secure` cookies from `http://localhost`, so development needs no exception.

## Sessions, rotation and reuse detection

Each login starts a **session family** (`auth.refresh_sessions.family_id`, migration 014). Each refresh revokes the presented refresh token and issues a new one in the same family. If a revoked token is presented again, someone copied it, so the **whole family is revoked**, the caller gets `401 AUTH_TOKEN_REVOKED`, and `auth.refresh_reuse_detected` is audited. Other devices (other families) of the same user are not affected.

`authenticate` reads the user's status, roles and permissions from the database on every request and checks that the token's family is still live. A disabled user, a role change, a logout or a reuse detection therefore takes effect immediately, not when the 15-minute token expires.

**Frontend (FMS-09):** send only one refresh at a time. Two tabs refreshing with the same cookie at once look like reuse, and the second request ends the session. Refresh on a `401 AUTH_TOKEN_EXPIRED` **or `AUTH_TOKEN_INVALID`**, then retry the original request once. A browser deletes the access cookie when its 15 minutes are up, so after that the server sees no cookie and answers `AUTH_TOKEN_INVALID`; it never sees an expired token from a browser.

## Frontend session handling

Card: FMS-09 (SE-45). Code: `packages/frontend/src/{context,router,components,lib/api}`.

- **No token in the page.** The tokens are HttpOnly cookies, so `AuthContext` keeps only the current user (from `/auth/refresh`, whose body is the same as `/auth/me`) in memory. Nothing goes to `localStorage` or `sessionStorage`.
- **Silent refresh on load.** `AuthProvider` calls `POST /auth/refresh`; success means signed in, a 4xx means signed out. The API client (`lib/api/client.ts`) shares one in-flight refresh, so React StrictMode and parallel requests never present the cookie twice.
- **API client.** `api.request(path, {method, json})` returns `body.data` and throws `ApiError {status, code, message, details, requestId}` built from the error envelope. On `401 AUTH_TOKEN_EXPIRED` or `AUTH_TOKEN_INVALID` (the browser dropped the expired access cookie) it refreshes once and retries once; a second 401, a rejected refresh, or `AUTH_TOKEN_REVOKED` ends the session. `lib/query.ts` configures TanStack Query on top of it (4xx errors are not retried).
- **Routes.** Add a screen as one line in `router/routes.tsx`: `{ path, element, permission? }`. `ProtectedRoute` sends visitors without a session to `/login?redirect=<url>`; after sign-in `LoginPage` returns them there (in-app paths only) or to their portal home. `RoleGate permission="fuel-anomaly:read"` renders nothing when the user lacks the code; it checks the permission codes from `/auth/me`, never role names, and does not replace the server check.
- **Idle logout.** 30 minutes without input calls `POST /auth/logout` and goes to `/login?reason=idle`.


## Login throttling

After 5 failed logins for the same email from the same IP within 15 minutes, further attempts get `429 RATE_LIMITED` until the oldest failure is 15 minutes old. Wrong passwords and unknown emails both count; a successful login resets the count. The counter is in memory per API process (`InMemoryLoginThrottle`), behind the `LoginThrottle` interface so FMS-72 can move it to Redis when the API runs on several instances.

The IP is Express's `req.ip`. Behind a reverse proxy it is the proxy's address until `trust proxy` is configured for that deployment.

## Audit

Every login attempt writes an `audit.audit_logs` row with the IP (`ip_address`) and user agent (`details.user_agent`):

| `action` | `user_id` (actor) | `entity_id` (account) | `details` |
|---|---|---|---|
| `auth.login_succeeded` | the user | the user | |
| `auth.login_failed` | null | the account, if the email exists | `email`, `reason` (`invalid_credentials` or `account_disabled`), `status` |
| `auth.login_throttled` | null | null | `email` |
| `auth.logout` | the user | the user | |
| `auth.refresh_reuse_detected` | null | the user | `session_family_id` |

Passwords are never logged or audited. `auditedMutation` redacts `password_hash` and `token_hash` in `old_values`/`new_values`.

## Using it in another module

```ts
import { authenticate } from '../auth';

router.get('/vehicles', authenticate, asyncHandler(async (req, res) => {
  // req.user: { id, publicId, roles, permissions, depotId }
}));
```

Permission checks (`requirePermission('vehicle:read')`) are FMS-06.

## Authorization

Card: FMS-06 (SE-42). Code: `modules/auth/api/authorize.ts`, `shared/authz/`. The permission codes and which role holds which are in [permissions.md](permissions.md), generated from the seed.

```ts
import { authorize, authenticated, publicRoute, depotScope, scopeClause } from '../auth';

router.get('/vehicles', authorize('vehicle:read'), handler);         // signed in AND holds the code
router.post('/alerts/:id/close', authorize('alert:resolve', 'incident:write'), handler); // any one of several
router.get('/auth/me', authenticated(), handler);                    // any signed-in user
router.post('/auth/login', publicRoute(), handler);                  // anyone
```

- **Deny by default.** Every route must declare one of the four. When the app is built it walks its routes and **refuses to start** if one declares nothing, naming the route. (This found `POST /test-audit`, which was open to anyone.)
- **401 vs 403.** Not signed in is `401` (never `403`); signed in without the permission is `403 FORBIDDEN_INSUFFICIENT_ROLE`; a suspended account is `403 AUTH_ACCOUNT_DISABLED`.
- **Permissions are read from the database on every request** (see `authenticate` above), not cached, so removing a role or suspending a user takes effect on the next request. A cache would trade that immediacy for a query that costs about a millisecond.
- **Check permission codes, never role names.**

### Scope: which records, not just which actions

Permissions say what a user may do; scope says to which records. Repositories build the `WHERE` clause from a scope so the filter is in the query:

```ts
const scope = scopeClause(depotScope(req.user), 'v.depot_id', 2);
db.query(`SELECT ... FROM fleet.vehicles v WHERE v.public_id = $1 AND ${scope.sql}`, [id, ...scope.params]);
// no row -> the service throws notFound() -> 404
```

| Helper | Meaning |
|---|---|
| `depotScope(user)` | `admin`, `fleet_manager`, `fleet_owner`, `compliance_officer` see every depot. Every other role sees only its home depot. A depot-scoped user with **no** depot sees nothing |
| `ownDriverScope(user)` | A user whose only role is `driver` sees only their own records; anyone with another role is not narrowed by this helper |

- **Out of scope is `404`, not `403`**, with the same body as a record that does not exist, so a depot A user cannot learn that a depot B record exists.
- **Fails closed.** An anonymous caller, an unknown role or a missing depot gives `none` (`WHERE FALSE`), never `all`.
- The admin bypasses depot scope but **not** permissions: `authorize` still has to pass.
- The column passed to `scopeClause` is a literal from repository code, never request input.

## Creating a user

There is no user administration API yet (`POST /users` is a later card). Create users from the backend container:

```bash
docker exec -it fms_backend npm run user:create -- --email admin@fms.local --name "Admin" --role admin
docker exec -it fms_backend npm run user:create -- --email d@fms.local --name "Dispatcher" --role dispatcher --depot ADD-01
```

The password is generated and printed once, or taken from `FMS_USER_PASSWORD` if set. Passwords are hashed with argon2id (19 MiB, 2 passes, 1 lane; the OWASP minimum).
