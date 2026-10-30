# Authentication

Card: FMS-05 (SE-41). Code: `packages/backend/src/modules/auth/`. Contract: [api-contract.md](api-contract.md) §5.1, error codes §3.6.

## Endpoints

| Method + path | Needs | Success | Errors |
|---|---|---|---|
| `POST /api/v1/auth/login` | `{email, password}` | `200` + both cookies, body = current user | `400 VALIDATION_FAILED`, `401 AUTH_INVALID_CREDENTIALS`, `403 AUTH_ACCOUNT_DISABLED`, `429 RATE_LIMITED` (with `Retry-After`) |
| `POST /api/v1/auth/refresh` | refresh cookie | `200` + new cookies, body = current user | `401 AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_REVOKED`, `403 AUTH_ACCOUNT_DISABLED`; cookies are cleared |
| `POST /api/v1/auth/logout` | refresh cookie (optional) | `204`, cookies cleared | none |
| `GET /api/v1/auth/me` | access cookie | `200`, body = current user | `401 AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_REVOKED`, `403 AUTH_ACCOUNT_DISABLED` |
| `POST /api/v1/auth/password` | `{token, password}` (a one-time link) | `204`; every session of the user ends | `400 VALIDATION_FAILED` (`token`: `invalid_or_expired`; `password`: `too_short`, `too_long`, `contains_email`, `repeated_character`) |

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
- **Driver app offline (FMS-34).** On a driver's phone, the driver app's service worker keeps a copy of the driver's last session body (the same body, never a token) in Cache Storage (`fms-driver-session`), so that a refresh that cannot reach the server is answered from it, marked `X-FMS-Offline: true`, and the driver stays signed in with no signal. Only a session whose roles include `driver` is kept; a staff account on the same phone is never kept. The copy is offered for at most 7 days from the last session the server gave (the refresh token's life), a sign-out (`POST /auth/logout`) or a server `401` on refresh deletes it, and offline starts cannot renew it. Once online again, the first request the server rejects ends the session as usual. Staff browsers never register the worker.
- **Silent refresh on load.** `AuthProvider` calls `POST /auth/refresh`; success means signed in, a 4xx means signed out. The API client (`lib/api/client.ts`) shares one in-flight refresh, so React StrictMode and parallel requests never present the cookie twice.
- **API client.** `api.request(path, {method, json})` returns `body.data` and throws `ApiError {status, code, message, details, requestId}` built from the error envelope. On `401 AUTH_TOKEN_EXPIRED` or `AUTH_TOKEN_INVALID` (the browser dropped the expired access cookie) it refreshes once and retries once; a second 401, a rejected refresh, or `AUTH_TOKEN_REVOKED` ends the session. `lib/query.ts` configures TanStack Query on top of it (4xx errors are not retried).
- **Routes.** Add a screen as one line in `router/routes.tsx`: `{ path, element, permission? }`. `ProtectedRoute` sends visitors without a session to `/login?redirect=<url>`; after sign-in `LoginPage` returns them there (in-app paths only) or to their portal home. `RoleGate permission="fuel-anomaly:read"` renders nothing when the user lacks the code; it checks the permission codes from `/auth/me`, never role names, and does not replace the server check.
- **Idle logout.** 30 minutes without input calls `POST /auth/logout` and goes to `/login?reason=idle`.


## Login throttling

After 5 failed logins for the same email from the same IP within 15 minutes, further attempts get `429 RATE_LIMITED` until the oldest failure is 15 minutes old. Wrong passwords and unknown emails both count; a successful login resets the count. The counter lives in Redis (FMS-72), so every API instance shares it. Each account and IP pair is one sorted set of failure times, under a hashed key, so no email is stored in Redis. While Redis is unreachable each process counts in memory (`ResilientLoginThrottle` falls back to `InMemoryLoginThrottle`), so logins are still throttled.

The IP is Express's `req.ip`. Behind a reverse proxy it is the proxy's address until `trust proxy` is configured for that deployment.

## Audit

Every login attempt writes an `audit.audit_logs` row. Like every audit row (FMS-27, CONVENTIONS.md Audit), it records where the attempt came from in `request_source` (channel, IP, user agent; the IP also in `ip_address`) and how it ended in `result`. The user agent is also kept in `details.user_agent`.

| `action` | `result` | `user_id` (actor) | `entity_id` (account) | `details` |
|---|---|---|---|---|
| `auth.login_succeeded` | `success` | the user | the user | |
| `auth.login_failed` | `failed` | null | the account, if the email exists | `email`, `reason` (`invalid_credentials` or `account_disabled`), `status` |
| `auth.login_throttled` | `denied` | null | null | `email` |
| `auth.logout` | `success` | the user | the user | |
| `auth.refresh_reuse_detected` | `denied` | null | the user | `session_family_id` |
| `auth.password_set` | `success` | the user | the user | `purpose` (`setup` or `reset`), `sessions_revoked` |
| `access.denied` | `denied` | the user | the user | `method`, `route` (the pattern, e.g. `/api/v1/users/:userId`), `required` (the permission codes) |

`access.denied` is written for every request a signed-in user is refused with `403 FORBIDDEN_INSUFFICIENT_ROLE` (reads included), before the response goes out. An anonymous request (`401`) writes nothing. Role changes are `ROLE_CHANGE` rows on `auth.user_roles` ([api-contract.md](api-contract.md) §5.1). Permission grants change only through migrations.

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

### The access audit (FMS-59)

Three integration tests check access control across the whole API. Each reads what it checks from the code, so a new route or event is covered the day it is added, with no test written for it.

- **`test/integration/route-access.test.ts`**, from the route registry (`routeRegistry(app)` in `shared/authz/route-policy.ts`: every method and path the app serves, with every policy it declared). Every route that is not public answers `401` with no cookie and with a forged one. For each of the nine roles, every route answers `403 FORBIDDEN_INSUFFICIENT_ROLE` when the role's seeded grants lack its permission and lets the role through when they hold it. A user with no role is refused everywhere. A route that chains two `authorize` calls needs both. The routes open to anyone (`publicRoute()`) or to any signed-in user (`authenticated()`) must match the two reviewed lists in the test, so **a new route without a permission fails CI** until someone adds it there on purpose. Every permission code a route asks for must exist and be held by some role.
- **`test/integration/data-scope.test.ts`**, depot and own-record scope on a seeded fleet (the small seed profile, three depots). Users of the four depot-scoped roles in depot A call every route they hold. Lists are called plain and filtered to depot B's depot, vehicle, driver and trip. Routes with a path parameter are called on a depot B record, writes with an empty body. A `2xx` on depot B's record is a leak, and so is any depot B id or plate anywhere in an answer. The ids come from the schema: every table with a `public_id` and a `depot_id`, `vehicle_id`, `driver_id`, `trip_id`, `route_id`, `user_id` or document owner column. A depot A driver is checked the same way, and against every other driver's trips, fuel logs, attendance, inspections and incidents (§24.3). Depots themselves are a directory (any signed-in user may read any depot's name; `in_scope=true` narrows the list), and ML models and integration providers belong to no depot.
- **`test/integration/realtime-scope.test.ts`**, socket rooms (FMS-43). Every domain event the gateway forwards has a depot B sample in the test, and a forwarded type without one fails CI. For every role's seeded grants, no depot A room is a room a depot B event goes to. On live sockets, no depot A socket of any depot role or a driver receives any of them, and a colleague of driver B gets none of driver B's trips or incidents. Depot B's dispatcher and driver do receive them, so the test is not vacuous.

What the audit found and fixed: a driver's `GET /vehicles` carried each vehicle's `current_trip`, so a driver could see where every colleague was driving; a driver now gets `null` there. The prediction feedback routes need `prediction:read` and `maintenance:write`; the registry used to report only the first.

## Creating a user

An admin creates accounts with `POST /api/v1/users` (FMS-78; rules in [api-contract.md](api-contract.md) §5.1). The account has no password. The response carries a one-time setup link (`meta.password_setup.token`, valid 72 hours, shown once). The admin passes it to the user, who sets a password with `POST /api/v1/auth/password`. `POST /api/v1/users/{id}/password-reset` issues a new link (1 hour) when a user forgets their password or the setup link expired. Only the SHA-256 of a link is stored (`auth.password_tokens`); issuing a new one closes the older ones, and setting a password ends every session of the user.

Roles are granted and removed through `PATCH /api/v1/users/{id}`. Nobody can grant a role carrying a permission they lack, only an admin can grant `admin`, nobody changes their own roles, and a status other than `active` revokes the user's sessions at once.

For the first admin of an empty database, or from a script, create users from the backend container:

```bash
docker exec -it fms_backend npm run user:create -- --email admin@fms.local --name "Admin" --role admin
docker exec -it fms_backend npm run user:create -- --email d@fms.local --name "Dispatcher" --role dispatcher --depot ADD-01
```

The password is generated and printed once, or taken from `FMS_USER_PASSWORD` if set. Passwords are hashed with argon2id (19 MiB, 2 passes, 1 lane; the OWASP minimum).

Drivers added from the Drivers screen (`POST /drivers` with `account`, FMS-19) get an account **without a password**: the stored value is a marker that is not a hash (`UNSET_HASH`), so no password matches it. Login treats it like an unknown email, including running a dummy hash so the response time gives nothing away. An admin gives such a driver a password with `POST /users/{id}/password-reset`, which issues a setup link for an account without one.
