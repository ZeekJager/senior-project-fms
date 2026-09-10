# Fleet Management System (FMS) — Engineering Board Specification
## Modeled on Deel Methodology · Full Deel Anatomy · Production Grade

---

## PART 1: BOARD CONFIGURATION (Reference Column)

---

### CFG-1: READ ME FIRST — Board Setup
**This is not a task card. Read before touching anything.**

**Workflow Columns**
`Reference` → `Backlog` → `Ready` → `In Progress` → `In Review` → `Blocked` → `Done`

**Board Rules**
- WIP limit: 2 cards per developer in `In Progress`. Four cards maximum across the whole team.
- A card enters `Ready` only when every card in its `Deps` line is in `Done`.
- A card with an open `Unknown` line goes to `Blocked`, not `In Progress`.
- Questions are answered in card comments so the next person finds the answer there.
- Never restate content from the reference documents inside a card. Reference by ID only (e.g., `api-contract.md §4.2`).

**Labels — create these in Jira as Components and Tags**
- `track-core` (blue) · `track-dispatch` (green) · `track-maintenance` (orange) · `track-telemetry` (purple)
- `wave-0` through `wave-4` (grey numeric labels)
- `blocked-external` (red) · `blocked-question` (red)

**Card Anatomy — every feature card follows this format exactly**
```
`track-[name]` `wave-[N]` · Est: [XS/S/M/L/XL] · Deps: [FMS-N or None]

Goal — why this exists
Where — exact endpoints, table names, file paths, screen IDs
Layout / Behaviour — UI cards only, or precise logic rules for API cards
Done when — testable statements written exactly as test names
Don't — what is explicitly out of scope
Unknown — genuinely undecided items and who answers them
```

**Estimation scale**: XS = <2 hours · S = half day · M = 1 day · L = 2–3 days · XL = 4–5 days

**Definition of Done — applies to every single card, never repeated on individual cards**
1. Tests pass, including the exact edge case the card was written to prevent
2. No cross-module table access — `track-dispatch` never queries `maintenance_records` directly
3. Migrations are reversible — tested `down` then `up` locally before PR
4. No `float` or `double` anywhere in a fuel or money path — use integer millilitres and integer Ethiopian cents
5. Audit entry written for every mutation (`INSERT` into `audit_logs` in the same transaction)
6. Soft delete enforced — `DELETE` SQL statements are forbidden on core entities; use `is_active = FALSE`
7. Error codes match `api-contract.md` exactly
8. Reviewed and merged to `main`

**Ownership — two tracks, one developer each, end-to-end (DB + API + UI + tests)**
- `track-core` + `track-dispatch` → Developer A
- `track-maintenance` + `track-telemetry` → Developer B
- Six cross-track dependencies exist after Wave 0. They are explicit `Deps` lines on affected cards.

---

### CFG-2: Reference Documents
**The four reference documents. Every task card points at them. Do not restate their contents inside a card.**

1. `fms-mvp-spec.md` — scope, what is explicitly out, phase definitions, user roles
2. `schema-fms.sql` — every table, column type, constraint, and index for the entire FMS database
3. `api-contract.md` — every REST endpoint, HTTP method, request/response shape, error code, auth header convention
4. `screen-inventory.md` — every UI screen, its route, the five required states (Loading, Empty, Error, Success, Skeleton), and which role can access it

**How cards reference these**
- `api-contract.md §3.2` → section 3.2 of the API contract (the trips endpoint group)
- `table vehicles` → that `CREATE TABLE` in `schema-fms.sql`
- `screen S-07` → that entry in the screen inventory

**If a card is ambiguous**, the answer is in one of these four. If it is not, that is a gap — say so in a card comment rather than guessing.

**Also link `CONVENTIONS.md`** from the repo once FMS-13 creates it. That file answers recurring "how do we usually do X" questions and grows as they come up.

---

### CFG-3: Performance Budgets & Default Thresholds
Cards reference these as "the documented budget" and "the documented default". Measured against a seeded dataset of 200 vehicles, 300 drivers, and 1,000 trips.

**Performance Budgets**
| Operation | Budget |
|:---|:---|
| Dashboard first paint (Fleet Command Center) | Under 2.0 seconds |
| Standard API read (GET /vehicles, /trips list) | p95 under 200ms |
| Standard API write (POST /trips, /fuel-logs) | p95 under 400ms |
| Socket.io GPS location update latency | Under 500ms from client broadcast to map render |
| AI health score batch (200 vehicles) | Under 90 seconds |
| Fuel reconciliation batch (200 vehicles, 1 month) | Under 60 seconds |
| IndexedDB offline queue flush on reconnect | Under 10 seconds for up to 50 queued items |
| Full PR CI pipeline | Under 8 minutes |
| Integration test suite | Under 5 minutes |

**Default Thresholds — all configuration, not hardcoded constants. Tune with evidence.**
| Setting | Default | Card |
|:---|:---|:---|
| Speeding flag threshold | > 80 km/h sustained for 30 seconds | FMS-50 |
| Idling flag threshold | Engine on, 0 km/h for > 5 minutes | FMS-50 |
| AI health score alert cutoff | Score drops below 75/100 | FMS-59 |
| Document expiry warning lead time | 30 days before expiry date | FMS-51 |
| Session auto-logout (inactivity) | 30 minutes | FMS-05 |
| Fuel variance alert threshold | ±20% vs expected consumption for route | FMS-42 |
| IndexedDB max offline queue size | 50 submissions | FMS-37 |

---

### CFG-4: Open Questions & External Blockers
**Open questions** — cards with an `Unknown` line must be resolved before entering `In Progress`, or the developer is guessing.

| Card | Question | Who answers |
|:---|:---|:---|
| FMS-01 | What Ethiopian public holidays to seed in the DB? Per-depot configurable? | Product owner |
| FMS-06 | What is the exact permission matrix per role for each endpoint? | Fleet Manager stakeholder |
| FMS-32 | If a driver's trip runs 10 minutes over into the next scheduled slot, is it a hard block or a soft warning? | Fleet Manager stakeholder |
| FMS-40 | Fuel stored in millilitres — does the UI display in litres with 2 decimal places or whole litres? | Product owner |
| FMS-50 | The 80 km/h speeding threshold — is this national law, operator policy, or configurable per depot? | Compliance Officer |
| FMS-56 | What is the minimum number of historical maintenance records needed to train the AI model meaningfully? | Developer B |
| FMS-62 | What GPS accuracy threshold (in metres) must be met before a ping is accepted as non-noise? | Tech Lead |
| FMS-71 | Which Swagger UI hosting approach — GitHub Pages, inline with the backend, or a separate docs site? | Tech Lead |

**External Blockers — not software. These gate whole waves.**
1. **GPS accuracy on Ethiopian road networks** — HTML5 Geolocation on Android inside a moving minibus may show 50–200m accuracy. Test with a physical device before Wave 4 commits to the approach. Blocks FMS-62.
2. **Ethiopian ITAX or MoR integration** — if a future compliance module is added, the API spec must come from the Ministry directly, not a sample found online. Does not block MVP.
3. **Three real vehicles for UAT** — load testing Socket.io with 200 concurrent connections requires either real devices or a load simulation script. Blocks FMS-66.

---

### CFG-5: FMS Database Schema — Table Ownership Reference

**`track-core` owns**
| Table | Key Columns | Critical Constraints |
|:---|:---|:---|
| `users` | `id`, `email`, `password_hash`, `role_id`, `depot_id`, `is_active` | `UNIQUE(email)`, soft delete via `is_active` |
| `roles` | `id`, `name`, `permissions JSON` | Seeded at migration time, not user-editable |
| `depots` | `id`, `name`, `location`, `is_active` | Soft delete |
| `audit_logs` | `id`, `table_name`, `record_id`, `action`, `old_state JSON`, `new_state JSON`, `user_id`, `correlation_id`, `created_at` | INSERT only — app role has no UPDATE or DELETE |

**`track-dispatch` owns**
| Table | Key Columns | Critical Constraints |
|:---|:---|:---|
| `vehicles` | `id`, `plate_number`, `type`, `capacity`, `depot_id`, `maintenance_flag`, `is_active` | `UNIQUE(plate_number)`, soft delete |
| `drivers` | `id`, `user_id`, `license_number`, `license_expiry`, `depot_id`, `is_active` | `UNIQUE(license_number)`, soft delete |
| `trips` | `id`, `driver_id`, `vehicle_id`, `route_id`, `status ENUM`, `scheduled_start`, `scheduled_end`, `actual_start`, `actual_end` | `status` in `(scheduled, assigned, en_route, completed, cancelled)` |
| `routes` | `id`, `name`, `origin`, `destination`, `distance_km`, `depot_id` | — |
| `driver_attendance` | `id`, `driver_id`, `date`, `status ENUM`, `logged_by` | `UNIQUE(driver_id, date)` |

**`track-maintenance` owns**
| Table | Key Columns | Critical Constraints |
|:---|:---|:---|
| `dvir_reports` | `id`, `vehicle_id`, `driver_id`, `trip_id`, `type ENUM`, `items JSON`, `issues_found`, `submitted_at` | `type` in `(pre_trip, post_trip)` |
| `maintenance_records` | `id`, `vehicle_id`, `technician_id`, `description`, `labour_hours`, `total_cost_cents INT`, `completed_at` | No float — cost in integer cents |
| `maintenance_parts` | `id`, `maintenance_record_id`, `part_id`, `quantity`, `unit_cost_cents INT` | No float |
| `inventory_parts` | `id`, `name`, `stock_quantity`, `reorder_level`, `depot_id` | `CHECK(stock_quantity >= 0)` |
| `incident_reports` | `id`, `driver_id`, `vehicle_id`, `trip_id`, `description`, `severity ENUM`, `submitted_at` | — |

**`track-telemetry` owns**
| Table | Key Columns | Critical Constraints |
|:---|:---|:---|
| `gps_pings` | `id`, `vehicle_id`, `trip_id`, `lat`, `lng`, `speed_kmh`, `bearing`, `accuracy_m`, `recorded_at` | No float on speed — store as integer km/h |
| `fuel_logs` | `id`, `driver_id`, `vehicle_id`, `trip_id`, `fuel_ml INT`, `cost_cents INT`, `odometer_km INT`, `submitted_at` | No float — fuel in integer millilitres, cost in integer cents |
| `telemetry_flags` | `id`, `vehicle_id`, `trip_id`, `flag_type ENUM`, `started_at`, `resolved_at` | `flag_type` in `(speeding, idling, offline)` |
| `notifications` | `id`, `user_id`, `type`, `message`, `read_at`, `created_at` | — |

---

## PART 2: FEATURE CARDS — WAVE 0: FOUNDATION

---

### FMS-00: Docker & Monorepo Setup
`track-core` `wave-0` · Est: M · Deps: None

**Goal**: Give every developer a single command to spin up the entire stack locally — identical environments prevent "works on my machine" failures that will waste days during a time-boxed senior project.

**Where**: Repository root · `docker-compose.yml` · `packages/backend/` · `packages/frontend/` · `packages/ai-service/` · `.github/workflows/ci.yml`

**Layout / Behaviour**:
- Monorepo structure: `packages/backend` (Node.js/Express), `packages/frontend` (React/Vite), `packages/ai-service` (Python Flask).
- `docker-compose.yml` defines four services: `mysql`, `backend`, `frontend`, `ai-service`.
- MySQL service uses a named volume so data persists across `docker-compose down` and `up`.
- Backend waits for MySQL health check before starting (use `depends_on: condition: service_healthy`).
- A single `make dev` command at the root starts all services and tails combined logs.
- Hot reload enabled for both backend (nodemon) and frontend (Vite HMR) without container rebuilds.

**Done when**:
- `docker-compose up` from a clean clone starts all four services with zero manual steps
- `make dev` tails all service logs with colour-coded prefixes
- Editing a `.js` file in backend reloads without a container restart
- Editing a `.tsx` file in frontend hot-reloads the browser
- MySQL data persists after `docker-compose restart`
- A fresh developer can reach the frontend on `http://localhost:5173` and the backend on `http://localhost:3000` within 5 minutes of cloning

**Don't**: Configure production Docker builds here. That is a Wave 4 deployment concern.

**Unknown**: None.

---

### FMS-01: DB Migrations — Core Identity Tables
`track-core` `wave-0` · Est: L · Deps: FMS-00

**Goal**: Lay down the foundational tables that every other table references via foreign key. No other migration can run before these exist.

**Where**: `packages/backend/migrations/001_core_identity.sql` · `table users` · `table roles` · `table depots` (see `schema-fms.sql`)

**Layout / Behaviour**:
- Use `db-migrate` or `node-pg-migrate` equivalent for MySQL. Migration runner must be idempotent.
- `roles` table is seeded at migration time with the eight fixed roles: `admin`, `fleet_manager`, `dispatcher`, `driver`, `technician`, `depot_admin`, `finance_clerk`, `compliance_officer`, `fleet_owner`. These are never created via the API.
- `users.password_hash` stores bcrypt output, never plaintext.
- All three tables have `is_active TINYINT(1) NOT NULL DEFAULT 1` and `created_at`, `updated_at` timestamps.
- `users.depot_id` is nullable — Admins and Fleet Owners are not depot-scoped.
- Migration must be reversible: the `down` migration drops tables in reverse foreign-key order.

**Done when**:
- `migration up` creates all three tables with correct column types and constraints
- `migration down` drops them cleanly without foreign key errors
- A direct SQL `INSERT` with a duplicate `users.email` fails with a unique constraint error
- `roles` table is seeded with all nine roles after the `up` migration
- `users.password_hash` column is `VARCHAR(255)` — no shorter limit that would truncate bcrypt output
- Running `up` twice is idempotent (does not throw an error)

**Don't**: Store permissions as rows — the `roles.permissions` JSON column is the permission store in MVP.

**Unknown**: None.

---

### FMS-02: DB Migrations — Operations Tables
`track-core` `wave-0` · Est: L · Deps: FMS-01

**Goal**: Create the tables for all operational data — vehicles, drivers, trips, fuel, maintenance, inventory, GPS, and audit — with the constraints that prevent double records and enforce data integrity at the database level.

**Where**: `packages/backend/migrations/002_operations.sql` · see `schema-fms.sql` for full table specs

**Layout / Behaviour**:
- `fuel_logs.fuel_ml` is `INT NOT NULL` — no DECIMAL, no FLOAT. Litres entered in UI are multiplied by 1000 before storage.
- `fuel_logs.cost_cents` is `INT NOT NULL` — Ethiopian Birr entered in UI are multiplied by 100 before storage.
- `maintenance_records.total_cost_cents` and `maintenance_parts.unit_cost_cents` are `INT NOT NULL` for same reason.
- `gps_pings.speed_kmh` is `SMALLINT UNSIGNED NOT NULL` — integer km/h, no decimals.
- `audit_logs` has no `UPDATE` or `DELETE` privilege granted to the application database user — enforced at the MySQL user permission level.
- `trips.status` is `ENUM('scheduled','assigned','en_route','completed','cancelled')` — no free-text status.
- `UNIQUE(driver_id, date)` on `driver_attendance` prevents double-logging attendance.
- `CHECK(stock_quantity >= 0)` on `inventory_parts` prevents negative stock.

**Done when**:
- All tables from `schema-fms.sql` exist with correct types after `migration up`
- A direct SQL `INSERT` of `fuel_ml = 1.5` (a float) is rejected by the column type
- A direct SQL `UPDATE audit_logs SET ...` fails with a permissions error
- `trips.status = 'parked'` is rejected by the ENUM constraint
- Inserting a duplicate `(driver_id, date)` into `driver_attendance` fails
- `inventory_parts.stock_quantity = -1` is rejected by the CHECK constraint
- `migration down` runs cleanly in reverse foreign-key order

**Don't**: Add indexes beyond primary and unique keys now. Query-specific indexes are added in Wave 4 after profiling.

**Unknown**: None.

---

### FMS-03: Soft Delete & Audit Middleware
`track-core` `wave-0` · Est: M · Deps: FMS-02

**Goal**: Ensure no historical data is ever permanently destroyed and every mutation is attributable to a specific user — critical for detecting driver fuel theft or unauthorized vehicle decommissioning.

**Where**: `packages/backend/src/middleware/softDelete.js` · `packages/backend/src/middleware/auditLog.js` · `table audit_logs`

**Layout / Behaviour**:
- `softDelete` middleware intercepts all `DELETE /api/*` requests on auditable resources.
- Instead of executing `DELETE FROM [table]`, it runs `UPDATE [table] SET is_active = FALSE WHERE id = ?`.
- `auditLog` middleware runs after every successful `POST`, `PUT`, `PATCH`, `DELETE` response.
- It reads the `before` state (fetched before the mutation) and `after` state (fetched after), serialises both as JSON with money/fuel as integers, and inserts into `audit_logs` within the same database transaction.
- `correlation_id` is a UUID generated per request by the request-logging middleware (FMS-07) and attached to `req.correlationId`.
- The `audit_logs` INSERT must occur inside the same DB transaction as the mutation — if the mutation rolls back, the audit row is never written.
- Fuel and money values in the JSON snapshots are stored as integer minor units, never as formatted strings.

**Done when**:
- `DELETE /api/vehicles/1` leaves the vehicle row in the DB with `is_active = FALSE`, not deleted
- `GET /api/vehicles` returns only `is_active = TRUE` vehicles
- A mutation and its audit log entry commit atomically — killing the process mid-transaction leaves neither
- The audit log JSON snapshot stores `cost_cents: 15000`, not `cost: "150.00 ETB"`
- Every audit row has a non-null `correlation_id`
- A direct `DELETE FROM vehicles` at the DB level still works (only the app middleware is blocked — this is app-level convention, not a DB constraint). This is documented in CONVENTIONS.md.
- `auditLog` middleware does not break if the `before` state fetch returns `null` (new record scenario)

**Don't**: Build the UI for reading audit logs here. That is FMS-30.

**Unknown**: None.

---

### FMS-04: Integer Type Safety for Fuel & Money
`track-core` `wave-0` · Est: S · Deps: FMS-02

**Goal**: Establish a project-wide shared module for fuel and money conversion so float precision errors never corrupt a fuel reconciliation or cost report — a single wrong calculation could incorrectly flag a driver for theft.

**Where**: `packages/backend/src/lib/units.js` · `packages/frontend/src/lib/units.js` · ESLint custom rule

**Layout / Behaviour**:
- `toMillilitres(litres)` → `Math.round(litres * 1000)` returns integer
- `toLitres(ml)` → `(ml / 1000).toFixed(2)` returns string for display only
- `toCents(birr)` → `Math.round(birr * 100)` returns integer
- `toBirr(cents)` → `(cents / 100).toFixed(2)` returns string for display only
- A custom ESLint rule (`no-float-in-money-path`) flags any use of `parseFloat`, `Number()`, or arithmetic division (`/`) on any variable whose name contains `cost`, `fuel`, `birr`, `cents`, or `ml` outside of the `units.js` files.
- Both backend and frontend get this identical `units.js` module — they must stay in sync.

**Done when**:
- `toMillilitres(1.5)` returns `1500` (integer, not `1500.0000000001`)
- `toCents(149.99)` returns `14999` (integer)
- The ESLint rule flags `const cost = fuel_cost / 100` outside `units.js`
- The ESLint rule does not flag `const ml = toMillilitres(litres)` inside `units.js`
- Both `packages/backend/src/lib/units.js` and `packages/frontend/src/lib/units.js` export the same four functions
- A unit test asserts `toMillilitres(0.1) + toMillilitres(0.2) === toMillilitres(0.3)` (the classic float failure case)

**Don't**: Add currency formatting here. Display formatting belongs to the shared UI component `FuelDisplay` built in FMS-11.

**Unknown**: None.

---

### FMS-05: JWT Authentication API
`track-core` `wave-0` · Est: M · Deps: FMS-01, FMS-03

**Goal**: Issue and validate short-lived access tokens and longer-lived refresh tokens so sessions survive a page reload but expire predictably, limiting blast radius if a token is stolen.

**Where**: `POST /api/auth/login` · `POST /api/auth/refresh` · `POST /api/auth/logout` · `packages/backend/src/middleware/authenticate.js` · `table users`

**Layout / Behaviour**:
- `POST /api/auth/login` — accepts `{email, password}`, validates bcrypt, returns `{accessToken, refreshToken, user: {id, role, depotId}}`.
- Access token TTL: 15 minutes. Refresh token TTL: 7 days. Stored as `HttpOnly, Secure, SameSite=Strict` cookies — never in `localStorage`.
- `POST /api/auth/refresh` — reads the refresh cookie, validates it, issues a new access token. Rotating refresh tokens: old one is invalidated on use.
- `POST /api/auth/logout` — clears both cookies and adds the refresh token to a `revoked_tokens` DB table.
- `authenticate` middleware validates the access token on every protected route. Returns `401` with `code: AUTH_TOKEN_EXPIRED` if expired, `401 AUTH_TOKEN_INVALID` if malformed.
- Failed login attempts are logged to `audit_logs` (no before/after state, just `action: LOGIN_FAILED`).
- Auto-logout after 30 minutes of inactivity is enforced client-side (see FMS-09). The server does not track inactivity.

**Done when**:
- `POST /api/auth/login` with correct credentials returns `200` with both cookies set and `HttpOnly` flag visible in response headers
- `POST /api/auth/login` with wrong password returns `401` with `code: AUTH_INVALID_CREDENTIALS` — never reveals whether the email exists
- `POST /api/auth/refresh` with a valid cookie returns a new access token
- Using a revoked refresh token after logout returns `401 AUTH_TOKEN_REVOKED`
- The access token payload contains `userId`, `role`, `depotId` — nothing else
- A failed login is written to `audit_logs` with the attempted email
- `POST /api/auth/login` for a `is_active = FALSE` user returns `403 AUTH_ACCOUNT_DISABLED`

**Don't**: Implement OAuth or SSO. JWT-only in MVP.

**Unknown**: None.

---

### FMS-06: RBAC Middleware & Role Definitions
`track-core` `wave-0` · Est: M · Deps: FMS-05

**Goal**: Ensure that a Driver who knows the API URL cannot read the Finance Clerk's fuel reconciliation data, and a Technician cannot approve a payroll run — access is enforced at the API layer, not just hidden in the UI.

**Where**: `packages/backend/src/middleware/authorize.js` · `packages/backend/src/config/permissions.js` · applied to every route handler

**Layout / Behaviour**:
- `permissions.js` exports a flat map: `{ 'trips:read': ['admin','fleet_manager','dispatcher','driver'], 'trips:write': ['admin','fleet_manager','dispatcher'], ... }`.
- `authorize(permission)` middleware reads `req.user.role` from the JWT payload and checks against the map. Returns `403 FORBIDDEN_INSUFFICIENT_ROLE` if not permitted.
- Depot-scoped resources (vehicles, drivers, trips belonging to a depot) additionally check `req.user.depotId === resource.depotId` — a Dispatcher from Depot A cannot see Depot B's trips.
- `admin` role bypasses depot scoping but not the permission map.
- Role definitions are seeded data, not API-manageable in MVP.

**Done when**:
- A `driver` calling `GET /api/fuel-logs` (a finance_clerk permission) receives `403`
- A `dispatcher` from Depot A calling `GET /api/trips?depotId=B` receives an empty list, not Depot B's trips
- `admin` calling any endpoint returns data regardless of depot
- Removing a permission from `permissions.js` for a role causes that role's requests to return `403` on the next request without redeployment (config is loaded at startup, so a restart is acceptable)
- An unauthenticated request (no token) receives `401`, not `403`
- All eight roles are tested against at least two endpoints each in the RBAC integration test suite

**Don't**: Build a UI for managing permissions. Role-permission mapping is code, not data, in MVP.

**Unknown**: The exact permission matrix per role for every endpoint. Must be defined with the Fleet Manager stakeholder before FMS-06 enters `In Progress`. (See CFG-4.)

---

### FMS-07: Request Logging & Global Error Handler
`track-core` `wave-0` · Est: S · Deps: FMS-00

**Goal**: Give every request a traceable ID and give every error a consistent JSON shape so debugging production issues doesn't require a 30-minute grep session through unstructured logs.

**Where**: `packages/backend/src/middleware/requestLogger.js` · `packages/backend/src/middleware/errorHandler.js` · Winston logger config

**Layout / Behaviour**:
- `requestLogger` runs first on every request. Generates a `UUID v4` correlation ID, attaches it to `req.correlationId`, and sets it as `X-Correlation-ID` response header.
- Logs structured JSON: `{correlationId, method, path, statusCode, durationMs, userId}` on response completion.
- `errorHandler` is the last middleware. Catches all unhandled errors. Returns `{error: {code, message, correlationId}}`.
- Error `code` is always one of the enumerated codes in `api-contract.md`. Generic `INTERNAL_SERVER_ERROR` is the catch-all.
- `4xx` errors log at `warn` level. `5xx` errors log at `error` level with full stack trace.
- In development, stack traces appear in the response body. In production, they do not.

**Done when**:
- Every response has an `X-Correlation-ID` header
- Two requests have different correlation IDs
- An intentional `throw new Error('test')` in a route handler returns `{error: {code: 'INTERNAL_SERVER_ERROR', correlationId: '...'}}` with no stack trace in `NODE_ENV=production`
- The stack trace is present in the response in `NODE_ENV=development`
- A `404` to an unknown route returns `{error: {code: 'NOT_FOUND'}}`, not an HTML Express error page

**Don't**: Use `console.log` anywhere in the codebase after this card is merged. ESLint `no-console` rule is added here.

**Unknown**: None.

---

### FMS-08: React + Vite + Tailwind Frontend Init
`track-core` `wave-0` · Est: S · Deps: FMS-00

**Goal**: Produce a frontend shell that builds deterministically, enforces code style, and is wired into the CI pipeline before any feature code is written.

**Where**: `packages/frontend/` · `vite.config.ts` · `tailwind.config.js` · `.eslintrc.js` · `packages/frontend/src/`

**Layout / Behaviour**:
- Vite with React + TypeScript template.
- Tailwind CSS with a custom `fms` design token set: `colors.fms-primary`, `colors.fms-danger`, `colors.fms-warning`, `colors.fms-success` — defined once in `tailwind.config.js`, used everywhere.
- ESLint with `@typescript-eslint`, `eslint-plugin-react`, and the custom `no-float-in-money-path` rule from FMS-04.
- Absolute imports configured: `@/components`, `@/lib`, `@/hooks` resolve to `packages/frontend/src/`.
- `vite build` produces a deterministic output — no hashes change if source is unchanged.
- Proxy config in `vite.config.ts` forwards `/api` to `http://localhost:3000` in development.

**Done when**:
- `npm run dev` in `packages/frontend` serves the app at `http://localhost:5173`
- `npm run build` completes with zero TypeScript errors and zero ESLint errors
- A component using `const cost = price / 100` (outside `units.js`) fails the ESLint check
- `@/components/Button` resolves correctly without a relative path
- A change to `tailwind.config.js` color is reflected across all usages in a rebuild
- The CI pipeline (FMS-14) runs `npm run build` and fails if it errors

**Don't**: Add any feature components here. This card ends at the Vite welcome screen.

**Unknown**: None.

---

### FMS-09: React Router, Auth Context & Protected Routes
`track-core` `wave-0` · Est: M · Deps: FMS-08, FMS-05

**Goal**: Ensure unauthenticated users cannot see any app screen and authenticated users are routed to the correct experience based on their role, without a backend call on every navigation.

**Where**: `packages/frontend/src/router/` · `packages/frontend/src/context/AuthContext.tsx` · `packages/frontend/src/components/ProtectedRoute.tsx`

**Layout / Behaviour**:
- `AuthContext` holds `{user, accessToken, isLoading}`. On app load, it calls `POST /api/auth/refresh` silently. If it succeeds, the user is logged in. If it fails, the user is sent to `/login`.
- `ProtectedRoute` wraps all authenticated routes. Checks `AuthContext.user`. If null, redirects to `/login` with the attempted URL in state so login can redirect back.
- Role-based route guarding: `<RoleGate roles={['dispatcher', 'fleet_manager']}>` renders `null` (not a disabled element) for unauthorized roles.
- Auto-logout: an `useIdleTimer` hook detects 30 minutes of no user input and calls `POST /api/auth/logout`, then redirects to `/login` with a `reason=idle` query param.
- Silent token refresh: an Axios interceptor catches `401 AUTH_TOKEN_EXPIRED` responses, calls `POST /api/auth/refresh`, and retries the original request once. A second `401` triggers logout.

**Done when**:
- Navigating to `/dashboard` without a session cookie redirects to `/login?redirect=/dashboard`
- After login, the user is redirected to the originally attempted URL
- A `driver` navigating to `/fuel-reconciliation` (a finance_clerk route) sees a blank screen, not an error
- Idle for 30 minutes in a browser tab triggers logout and shows `/login?reason=idle`
- A `401 AUTH_TOKEN_EXPIRED` response automatically refreshes the token and retries the original request transparently
- A second consecutive `401` after refresh logs the user out

**Don't**: Store the access token in `localStorage` or `sessionStorage`. It lives in memory in `AuthContext` only.

**Unknown**: None.

---

### FMS-10: Login Screen UI
`track-core` `wave-0` · Est: S · Deps: FMS-09

**Goal**: The single entry point to the application. Simple, functional, and communicates clearly when something goes wrong without revealing security-sensitive information.

**Where**: `packages/frontend/src/pages/Login.tsx` · `screen S-01` in screen inventory · `POST /api/auth/login`

**Layout / Behaviour**:
- Fields: `Email` (type=email, autocomplete=email), `Password` (type=password, autocomplete=current-password).
- Submit button shows a spinner during the API call and is disabled to prevent double-submit.
- A `401 AUTH_INVALID_CREDENTIALS` response renders: "Invalid email or password." Never "Email not found" or "Wrong password."
- A `403 AUTH_ACCOUNT_DISABLED` response renders: "Your account has been disabled. Contact your administrator."
- The 5 required states from `screen-inventory.md`: Loading (spinner on button), Empty (initial form), Error (inline error message), Success (redirecting), Skeleton (not applicable for login).

**Done when**:
- Submitting with an empty email shows a client-side required field error before any API call
- Submitting shows a spinner on the button and disables it
- A wrong password renders the generic "Invalid email or password" message
- A disabled account renders the specific disabled message
- Successful login redirects to the URL in `?redirect=` query param, or `/dashboard` if none
- The form is accessible: labels are associated with inputs, errors are announced via `aria-live`

**Don't**: Add "Forgot password" or "Sign up" flows. Out of MVP scope.

**Unknown**: None.

---

### FMS-11: Shared UI Component Library
`track-core` `wave-0` · Est: L · Deps: FMS-08

**Goal**: Build these once and correctly. Every screen in the application uses these components. An inconsistency here (a money display showing float rounding artifacts, a table that shifts layout on load) shows up on every screen simultaneously.

**Where**: `packages/frontend/src/components/shared/` · Each component in its own subdirectory with a `.stories.tsx` file

**Components to build**:
- `FuelDisplay` / `MoneyDisplay` — takes `{amountMinorUnits: number, unit: 'ml'|'cents'}`, converts using `units.js`, renders right-aligned formatted string. Never holds a float in state.
- `FuelInput` / `MoneyInput` — user types human-readable value (e.g., `23.5` litres), component converts to integer on blur using `units.js`, emits integer. Rejects more than 3 decimal places for fuel, 2 for money.
- `DataTable` — props: `columns`, `data`, `isLoading`, `isEmpty`, `error`, `onPageChange`. Shows loading skeleton that matches final row height. Cursor-based pagination controls.
- `StatusBadge` — one shared colour vocabulary: `scheduled=grey`, `assigned=blue`, `en_route=yellow`, `completed=green`, `cancelled=red`, `flagged=orange`. Defined in `CONVENTIONS.md`.
- `EmptyState` — icon slot, heading, description, optional action button.
- `ErrorBoundary` — catches React render errors, displays error code, correlation ID (if available), and a "Copy error details" button.
- `ConfirmDialog` — for irreversible actions. Props: `action`, `message`, optionally `requireTyping: string` (user must type a specific word to confirm).

**Done when**:
- `MoneyInput` accepts `"149.99"` and emits `14999` (integer) — no float ever stored in component state
- `MoneyInput` rejects `"149.999"` (more than 2 decimal places) with an inline validation error
- `FuelDisplay` renders `1500` ml as `"1.500 L"`
- `DataTable` loading skeleton rows are the same height as data rows — no layout shift on data arrival
- `StatusBadge` colours match the documented vocabulary exactly — adding a new status without a colour entry fails a snapshot test
- `ConfirmDialog` with `requireTyping="DELETE"` keeps the confirm button disabled until the user types "DELETE" exactly
- `ErrorBoundary` displays correlation ID when available

**Don't**: Build any screen-specific components here. This card ends at the component library only.

**Unknown**: None.

---

### FMS-12: API Import Linter
`track-core` `wave-0` · Est: S · Deps: FMS-00

**Goal**: Prevent a developer working on `track-dispatch` from accidentally importing and querying a `track-maintenance` table directly — cross-module coupling would make it impossible to split services later and creates unpredictable query performance.

**Where**: `.eslintrc.js` · custom ESLint rule `no-cross-module-import` · documented in `CONVENTIONS.md`

**Layout / Behaviour**:
- Rule: files inside `src/modules/dispatch/` may not import from `src/modules/maintenance/` or `src/modules/telemetry/`.
- Cross-module data access must go through a service function exported by the owning module's public API file (`src/modules/maintenance/index.js`).
- The linter is added to the `pre-commit` hook via Husky so violations are caught before they are pushed.

**Done when**:
- A file in `src/modules/dispatch/tripsService.js` doing `import { getRepairRecords } from '../maintenance/repairService'` fails the linter
- The same import through the public API `import { getRepairRecords } from '../maintenance'` passes the linter
- The pre-commit hook blocks a commit containing a linter violation
- The CI pipeline (FMS-14) runs the linter and fails on violation

**Don't**: Enforce this rule across frontend components. It applies to backend service modules only.

**Unknown**: None.

---

### FMS-13: CONVENTIONS.md
`track-core` `wave-0` · Est: S · Deps: FMS-00

**Goal**: Answer "how do we usually do X" questions in writing before someone guesses wrong and introduces a pattern the rest of the codebase has to follow.

**Where**: `CONVENTIONS.md` in the repository root · linked from `README.md`

**Contents to document on creation**:
- Status colour vocabulary for `StatusBadge` (from FMS-11)
- Money and fuel storage rule (integer minor units — from FMS-04)
- Soft delete convention (is_active, not deleted_at — from FMS-03)
- Error code naming convention (SCREAMING_SNAKE_CASE, from `api-contract.md`)
- Module boundary rules (cross-module import policy — from FMS-12)
- File naming: `camelCase` for JS/TS files, `kebab-case` for CSS, `PascalCase` for React components
- API versioning: all endpoints under `/api/v1/` even though there is only one version in MVP
- SQL query style: no ORM, raw SQL in service files, parameterised queries only

**Done when**:
- `CONVENTIONS.md` exists at the repo root and is linked from `README.md`
- All eight sections above are documented
- The file is referenced from at least one card comment or PR description in the same week
- A new developer reading only `CONVENTIONS.md` and the four reference docs can answer: "Where do I store a fuel amount?" without asking

**Don't**: Turn this into a style guide for every possible scenario. Only decisions that have already caused or could cause a disagreement belong here.

**Unknown**: None.

---

### FMS-14: CI Pipeline
`track-core` `wave-0` · Est: S · Deps: FMS-08, FMS-12

**Goal**: Catch broken code before it merges to `main`, so the team never spends a morning untangling a broken shared branch.

**Where**: `.github/workflows/ci.yml` (or equivalent for GitLab/Bitbucket)

**Layout / Behaviour**:
- Triggers on every push to any branch and on every pull request targeting `main`.
- Three jobs run in parallel: `backend-ci`, `frontend-ci`, `migrations-ci`.
- `backend-ci`: install deps → run ESLint → run unit tests (Jest) → run integration tests against a MySQL test container.
- `frontend-ci`: install deps → run ESLint → run TypeScript check → run unit tests (Vitest) → run `vite build`.
- `migrations-ci`: spin up MySQL container → run `migration up` → run `migration down` → run `migration up` again. Asserts idempotency.
- Pipeline must complete in under 8 minutes (see CFG-3 budgets).
- Branch protection rule: `main` requires all three CI jobs to pass and at least one approving review before merge.

**Done when**:
- A broken import in a backend file fails `backend-ci` and blocks the PR
- A TypeScript type error in a frontend file fails `frontend-ci` and blocks the PR
- A non-reversible migration fails `migrations-ci` and blocks the PR
- The full pipeline completes in under 8 minutes on a cold GitHub Actions runner
- Merging to `main` without CI passing is impossible (branch protection enforced)

**Don't**: Add deployment to CI yet. Deployment is a Wave 4 concern.

**Unknown**: None.

---

## PART 2: FEATURE CARDS — WAVE 1: CORE ENTITIES

---

### FMS-15: Vehicle CRUD API
`track-dispatch` `wave-1` · Est: M · Deps: FMS-02, FMS-06

**Goal**: Allow authorised users to register, update, and decommission vehicles, with every change attributed to a named user, so the fleet registry is always auditable and accurate.

**Where**: `GET /api/v1/vehicles` · `GET /api/v1/vehicles/:id` · `POST /api/v1/vehicles` · `PUT /api/v1/vehicles/:id` · `DELETE /api/v1/vehicles/:id` (soft) · `table vehicles` · `api-contract.md §2.1`

**Layout / Behaviour**:
- `GET /api/v1/vehicles` supports query params: `?depotId=`, `?status=active|inactive`, `?maintenanceFlag=true`. Returns paginated list.
- `POST /api/v1/vehicles` requires: `plateNumber`, `type`, `capacity`, `depotId`. Optional: `year`, `make`, `model`.
- `plateNumber` is `UNIQUE` — a duplicate returns `409 CONFLICT_DUPLICATE_PLATE`.
- `DELETE /api/v1/vehicles/:id` sets `is_active = FALSE`. A vehicle with an active trip (status `assigned` or `en_route`) cannot be soft-deleted — returns `409 CONFLICT_VEHICLE_IN_USE`.
- All mutations write to `audit_logs` (FMS-03 middleware handles this automatically).
- Depot-scoped: a `dispatcher` from Depot A cannot modify a vehicle belonging to Depot B (FMS-06 enforces this).

**Done when**:
- `POST /api/v1/vehicles` with a duplicate plate number returns `409 CONFLICT_DUPLICATE_PLATE`
- `DELETE /api/v1/vehicles/:id` for a vehicle on an active trip returns `409 CONFLICT_VEHICLE_IN_USE`
- `DELETE /api/v1/vehicles/:id` for an idle vehicle sets `is_active = FALSE` and the vehicle no longer appears in `GET /api/v1/vehicles` (default active-only list)
- `GET /api/v1/vehicles?maintenanceFlag=true` returns only vehicles with `maintenance_flag = TRUE`
- A `driver` calling `POST /api/v1/vehicles` receives `403 FORBIDDEN_INSUFFICIENT_ROLE`
- Each mutation produces exactly one row in `audit_logs` with the correct `user_id`

**Don't**: Handle document uploads here. Vehicle documents (insurance, registration) are FMS-17.

**Unknown**: None.

---

### FMS-16: Driver CRUD API
`track-dispatch` `wave-1` · Est: M · Deps: FMS-02, FMS-06

**Goal**: Allow depot admins to register and manage driver profiles including license validity, so expired licenses can be caught before a driver is dispatched on a trip.

**Where**: `GET /api/v1/drivers` · `GET /api/v1/drivers/:id` · `POST /api/v1/drivers` · `PUT /api/v1/drivers/:id` · `DELETE /api/v1/drivers/:id` (soft) · `table drivers` · `api-contract.md §2.2`

**Layout / Behaviour**:
- `POST /api/v1/drivers` requires: `userId` (links to a user with role `driver`), `licenseNumber`, `licenseExpiry`, `depotId`.
- `licenseNumber` is `UNIQUE` — duplicate returns `409 CONFLICT_DUPLICATE_LICENSE`.
- `DELETE /api/v1/drivers/:id` is blocked if the driver has an active trip — returns `409 CONFLICT_DRIVER_IN_USE`.
- `GET /api/v1/drivers` supports `?depotId=`, `?licenseExpiringBefore=YYYY-MM-DD` for expiry tracking.
- Depot-scoped: a depot admin cannot see or modify drivers from another depot.

**Done when**:
- `POST /api/v1/drivers` with a duplicate license number returns `409 CONFLICT_DUPLICATE_LICENSE`
- `DELETE` on a driver with an active trip returns `409 CONFLICT_DRIVER_IN_USE`
- `GET /api/v1/drivers?licenseExpiringBefore=2026-12-31` returns only drivers whose licenses expire before that date
- Each mutation writes to `audit_logs`
- A `technician` calling `POST /api/v1/drivers` receives `403`

**Don't**: Handle photo or document uploads. That is FMS-17.

**Unknown**: None.

---

### FMS-17: Document Upload Service
`track-dispatch` `wave-1` · Est: M · Deps: FMS-15, FMS-16

**Goal**: Allow vehicle and driver documents (license scans, insurance certificates, vehicle registration) to be stored centrally with expiry tracking, so the system can alert before a vehicle is operated with an expired certificate.

**Where**: `POST /api/v1/documents` · `GET /api/v1/documents/:id` · `DELETE /api/v1/documents/:id` · `table documents` · local file storage under `uploads/` in MVP (S3-compatible in future)

**Layout / Behaviour**:
- Accepted MIME types (validated by content sniffing, not file extension): `image/jpeg`, `image/png`, `application/pdf`. All others rejected with `415 UNSUPPORTED_MEDIA_TYPE`.
- Max file size: 10 MB. Larger files rejected with `413 PAYLOAD_TOO_LARGE`.
- Required fields: `entityType` (`vehicle`|`driver`), `entityId`, `documentType` (`license`|`insurance`|`registration`|`dvir_photo`), `expiryDate` (nullable).
- Storage key (file path) is never returned to the client. Client gets a signed time-limited URL valid for 1 hour.
- `DELETE /api/v1/documents/:id` is a soft delete — file is not removed from disk in MVP.

**Done when**:
- Uploading a `.txt` file (even renamed to `.pdf`) is rejected with `415` (MIME sniffing catches it)
- Uploading a 15 MB PDF is rejected with `413`
- A successful upload returns a time-limited URL, not a raw file path
- The same URL 2 hours later returns a `403` or `404` (expired link)
- Each upload writes to `audit_logs`
- `GET /api/v1/documents/:id` for a document belonging to another depot returns `404`, not `403` (existence not revealed)

**Don't**: Build the upload UI here. That is FMS-19 (Driver UI) and FMS-18 (Vehicle UI).

**Unknown**: None.

---

### FMS-18: Vehicle Management Dashboard UI
`track-dispatch` `wave-1` · Est: M · Deps: FMS-15, FMS-17, FMS-11

**Goal**: Give Fleet Managers a single place to see the entire fleet's state — registration status, maintenance flags, and active trips — so they can make dispatch decisions without calling the depot.

**Where**: `packages/frontend/src/pages/Vehicles/` · `screen S-04` · Uses `DataTable`, `StatusBadge`, `ConfirmDialog` from FMS-11

**Layout / Behaviour**:
- List view: `DataTable` with columns: Plate, Type, Depot, Status (`active`/`maintenance`/`inactive`), Current Trip (link if assigned), Actions.
- Filter bar: by Depot, by Status, by Maintenance Flag.
- Add Vehicle: slide-in form panel (not a separate page). Validates plate uniqueness client-side with a debounced `GET /api/v1/vehicles?plateNumber=` check.
- Decommission (soft delete): uses `ConfirmDialog` requiring the user to type the plate number.
- Upload Documents: a `+` button on each row opens a file picker. Shows uploaded documents with their expiry dates and a red badge if expired, amber if expiring within 30 days.
- 5 required states: Loading (table skeleton), Empty ("No vehicles registered for this depot"), Error (ErrorBoundary), Success (table populated), Skeleton (row-height placeholder during filter changes).

**Done when**:
- Filter by `maintenanceFlag=true` shows only flagged vehicles without a page reload
- Attempting to decommission a vehicle on an active trip shows the `409 CONFLICT_VEHICLE_IN_USE` error inline in the dialog, not as a toast
- The confirm dialog requires typing the exact plate number before enabling the submit button
- An expired document shows a red badge; expiring within 30 days shows an amber badge
- A `driver` accessing this route sees the `RoleGate` render nothing (no data visible, no "access denied" message)
- The table renders 200 vehicles without horizontal scrollbar on a 1440px wide screen

**Don't**: Build a vehicle detail/edit page. Editing is done inline in the list view for MVP.

**Unknown**: None.

---

### FMS-19: Driver Management Dashboard UI
`track-dispatch` `wave-1` · Est: M · Deps: FMS-16, FMS-17, FMS-11

**Goal**: Give Depot Admins a view of every driver in their depot, their license status, and their document health, so they catch an expiring license before it becomes a compliance violation.

**Where**: `packages/frontend/src/pages/Drivers/` · `screen S-05` · Uses `DataTable`, `StatusBadge` from FMS-11

**Layout / Behaviour**:
- List view: columns: Driver Name, Depot, License Number, License Expiry (with red/amber badge), Status, Active Trip (if any), Actions.
- Same expiry badge logic as FMS-18: red if expired, amber if expiring within 30 days.
- Add Driver: form panel requiring Name, Email (creates user account with `driver` role), License Number, License Expiry, Depot.
- Document upload: same `+` button pattern as FMS-18.
- 5 required states same as FMS-18.

**Done when**:
- A driver with an expired license shows a red "EXPIRED" badge without any additional user action
- A driver with a license expiring in 15 days shows an amber "EXPIRING SOON" badge
- Adding a driver with an already-used license number shows an inline `409` error in the form
- A `dispatcher` (who has read access) sees the list but the "Add Driver" button is hidden via `RoleGate`

**Don't**: Allow editing driver license details inline. License changes require a depot admin action routed through the form panel for audit clarity.

**Unknown**: None.

---

### FMS-20: Depot CRUD API
`track-core` `wave-1` · Est: S · Deps: FMS-01, FMS-06

**Goal**: Allow admins to register and manage the physical depots that own vehicles and drivers, which is the fundamental organisational unit of the system.

**Where**: `GET /api/v1/depots` · `POST /api/v1/depots` · `PUT /api/v1/depots/:id` · `DELETE /api/v1/depots/:id` (soft) · `table depots`

**Layout / Behaviour**:
- `admin` and `fleet_owner` only — no other role can write to this endpoint.
- `DELETE /api/v1/depots/:id` blocked if depot has any `is_active = TRUE` vehicles, drivers, or users — returns `409 CONFLICT_DEPOT_NOT_EMPTY`.
- `GET /api/v1/depots` is accessible to all authenticated roles (everyone needs to know what depots exist for filtering).

**Done when**:
- A `fleet_manager` calling `POST /api/v1/depots` receives `403`
- `DELETE` on a depot with active vehicles returns `409 CONFLICT_DEPOT_NOT_EMPTY`
- A successfully deleted depot's vehicles no longer appear in `GET /api/v1/vehicles` (they are still in DB but their depot is inactive)

**Don't**: Build a depot management UI screen here. Depot management is admin-only and accessed from the Settings area built in Wave 4.

**Unknown**: None.

---

### FMS-21: Driver Attendance API & UI
`track-dispatch` `wave-1` · Est: M · Deps: FMS-16, FMS-06

**Goal**: Replace paper attendance sheets with a digital record so the depot admin can prove driver availability for dispatch and so fleet managers can track absenteeism patterns.

**Where**: `POST /api/v1/attendance` · `GET /api/v1/attendance?driverId=&date=` · `table driver_attendance` · `packages/frontend/src/pages/Attendance/` · `screen S-06`

**Layout / Behaviour**:
- `POST /api/v1/attendance` accepts `{driverId, date, status: 'present'|'absent'|'on_leave'}` and the `logged_by` is taken from `req.user.id`.
- `UNIQUE(driver_id, date)` — attempting to log twice for the same driver on the same date returns `409 CONFLICT_ATTENDANCE_DUPLICATE`. The existing record must be updated via `PUT` instead.
- UI: a grid of driver cards for the current date, each with a three-button toggle (Present / Absent / On Leave). Submitting auto-saves.
- A driver marked `absent` or `on_leave` is visually flagged in the Dispatcher's trip assignment view (FMS-33) — a warning, not a block.

**Done when**:
- `POST /api/v1/attendance` for a driver who already has an attendance record for that date returns `409`
- `PUT /api/v1/attendance/:id` successfully updates the status and writes a new `audit_logs` entry
- A driver marked `absent` today appears with a warning indicator in the Dispatcher Console (FMS-33)
- `GET /api/v1/attendance?date=today` returns all drivers for the logged-in depot admin's depot — no drivers from other depots
- A `dispatcher` cannot write attendance records — `403` on `POST`

**Don't**: Track attendance history or build a monthly report. Raw data is available; reporting is a Wave 3 analytics concern.

**Unknown**: None.

---

### FMS-22: Maintenance Record CRUD API
`track-maintenance` `wave-1` · Est: M · Deps: FMS-02, FMS-06

**Goal**: Create a permanent, auditable log of every repair performed on every vehicle so a vehicle's full mechanical history is available before dispatch, and so the AI model in Wave 3 has real data to train on.

**Where**: `GET /api/v1/maintenance` · `POST /api/v1/maintenance` · `PUT /api/v1/maintenance/:id` · `table maintenance_records` · `table maintenance_parts` · `api-contract.md §2.5`

**Layout / Behaviour**:
- `POST /api/v1/maintenance` requires: `vehicleId`, `description`, `labourHours`, `totalCostCents` (integer). Optional: `parts[]` (array of `{partId, quantity, unitCostCents}`).
- `totalCostCents` is always an integer. A request body containing `"totalCost": 1500.50` must be rejected with `400 VALIDATION_FLOAT_IN_MONEY_PATH`.
- Creating a maintenance record for a vehicle automatically sets `vehicles.maintenance_flag = TRUE`.
- Completing a maintenance record (`PUT /api/v1/maintenance/:id` with `{completedAt: ISO_DATE}`) clears `vehicles.maintenance_flag = FALSE` in the same DB transaction.
- Parts consumption deducts from `inventory_parts.stock_quantity`. If stock goes below zero, the part entry is allowed but a warning is returned in the response body.

**Done when**:
- `POST /api/v1/maintenance` with `"totalCost": 1500.50` (float) returns `400 VALIDATION_FLOAT_IN_MONEY_PATH`
- Creating a maintenance record sets `vehicles.maintenance_flag = TRUE` atomically in the same transaction
- Completing a record sets `maintenance_flag = FALSE` atomically
- Parts consumption correctly decrements `inventory_parts.stock_quantity`
- A part going below zero stock still inserts the record but includes `{warning: 'LOW_STOCK', partId: ...}` in the response
- A `dispatcher` cannot create maintenance records — `403`

**Don't**: Build the technician UI here. That is FMS-26.

**Unknown**: None.

---

### FMS-23: Spare Parts Inventory API
`track-maintenance` `wave-1` · Est: S · Deps: FMS-02, FMS-06

**Goal**: Track spare part stock levels so the Workshop Manager knows when to reorder before a vehicle is grounded waiting for a part.

**Where**: `GET /api/v1/inventory` · `POST /api/v1/inventory` · `PUT /api/v1/inventory/:id` · `POST /api/v1/inventory/:id/adjust` · `table inventory_parts`

**Layout / Behaviour**:
- `POST /api/v1/inventory/adjust` accepts `{quantity: integer, reason: string}` — positive for stock in, negative for stock out (manual adjustment outside maintenance records).
- `CHECK(stock_quantity >= 0)` at DB level means a `adjust -100` on a part with 50 in stock fails with `409 CONFLICT_INSUFFICIENT_STOCK`.
- `GET /api/v1/inventory?belowReorder=true` returns only parts where `stock_quantity <= reorder_level`.

**Done when**:
- `POST /api/v1/inventory/adjust` with a quantity that would make stock negative returns `409 CONFLICT_INSUFFICIENT_STOCK`
- `GET /api/v1/inventory?belowReorder=true` returns only below-threshold parts
- Each stock adjustment writes to `audit_logs` with old and new `stock_quantity`
- A `driver` calling any inventory endpoint receives `403`

**Don't**: Build a purchase order or supplier management system. Reorder is a manual process in MVP.

**Unknown**: None.

---

### FMS-24: Technician Repair Log UI
`track-maintenance` `wave-1` · Est: M · Deps: FMS-22, FMS-23, FMS-11

**Goal**: Give technicians a simple form to log completed repairs and parts used from their desktop, replacing hand-written workshop job cards that get lost or are illegible.

**Where**: `packages/frontend/src/pages/Maintenance/` · `screen S-08` · Uses `MoneyInput`, `DataTable`, `ConfirmDialog` from FMS-11

**Layout / Behaviour**:
- Vehicle selector: searchable dropdown showing only vehicles with `maintenance_flag = TRUE` plus any vehicle (for logging preventive maintenance).
- Cost input: uses `MoneyInput` from FMS-11. Emits integer cents. Displays in ETB with 2 decimal places.
- Parts section: add rows with part name (autocomplete from inventory), quantity, unit cost. Running total computed from parts.
- "Mark as Complete" button triggers `PUT /api/v1/maintenance/:id` with `completedAt`. Shows a `ConfirmDialog` warning that this will clear the vehicle's maintenance flag and make it available for dispatch.
- 5 required states applied.

**Done when**:
- Submitting a cost with more than 2 decimal places shows a client-side validation error before any API call
- "Mark as Complete" shows the `ConfirmDialog` and only clears the maintenance flag after confirmation
- Adding a part whose stock is 0 shows a warning inline (not a block) sourced from inventory data
- The form is accessible: all inputs have labels, errors use `aria-live`

**Don't**: Allow editing a completed maintenance record. Completed records are immutable. Corrections require a new record with a note.

**Unknown**: None.

---

### FMS-25: Spare Parts Inventory Console UI
`track-maintenance` `wave-1` · Est: S · Deps: FMS-23, FMS-11

**Goal**: Give the Depot Admin a live view of stock levels with low-stock items prominently highlighted, so reorders happen proactively rather than when a technician discovers a part is missing during a repair.

**Where**: `packages/frontend/src/pages/Inventory/` · `screen S-09`

**Layout / Behaviour**:
- `DataTable` with columns: Part Name, Stock Quantity, Reorder Level, Status Badge (`ok`/`low`/`out`).
- Filter toggle: "Show low stock only."
- Stock Adjust modal: enter quantity (positive or negative) and a reason string. Uses `ConfirmDialog` for negative adjustments.
- 5 required states applied.

**Done when**:
- Parts with `stock_quantity = 0` show a red "OUT OF STOCK" badge
- Parts between 1 and `reorder_level` show an amber "LOW" badge
- A negative adjustment that would go below zero is rejected with an inline error from the `409` API response
- "Show low stock only" toggle filters the table without a page reload

**Don't**: Show pricing or supplier information. This is a stock count view only.

**Unknown**: None.

---

### FMS-26: Document Expiry Seeding & Scheduled Check
`track-dispatch` `wave-1` · Est: S · Deps: FMS-17

**Goal**: Ensure the system knows about upcoming document expirations immediately when a document is uploaded, not only when someone looks at the UI.

**Where**: `packages/backend/src/jobs/documentExpiry.js` · runs as a cron at 07:00 daily · `table documents` · `table notifications`

**Layout / Behaviour**:
- On upload (`POST /api/v1/documents` with an `expiryDate`), immediately check if `expiryDate` is within 30 days. If so, create a notification record for the depot admin.
- The daily cron at 07:00 scans all documents with `expiryDate` between today and today+30 days and creates or updates notification records.
- Does not create duplicate notifications — uses `UPSERT` on `(entity_type, entity_id, document_type, notification_type)`.

**Done when**:
- Uploading a document with an expiry 15 days from now immediately creates a notification row
- The daily cron does not create a second notification for the same document on the next run
- A document with no expiry date triggers no notification

**Don't**: Build the notification UI display here. That is FMS-53.

**Unknown**: None.

---

### FMS-27: Audit Log Writer (INSERT-only middleware)
`track-core` `wave-1` · Est: M · Deps: FMS-03, FMS-02

**Goal**: Ensure every mutation in the system writes a permanent, unmodifiable record of what changed, who changed it, and when — so any dispute about a data change can be resolved by reading the log, not by guessing.

**Where**: `packages/backend/src/middleware/auditLog.js` · `table audit_logs` · MySQL user permissions

**Layout / Behaviour**:
- The `app` MySQL database user is granted: `SELECT, INSERT` on `audit_logs`. `UPDATE` and `DELETE` privileges are explicitly not granted.
- The middleware captures the `before` state with a `SELECT` before the mutation runs, and the `after` state with a `SELECT` after, within the same DB transaction.
- Both states are serialised to JSON. Money and fuel fields are stored as integers — never formatted strings.
- `correlation_id` is propagated from `req.correlationId` (set by FMS-07).
- For background jobs (cron jobs, queue workers), a `systemCorrelationId` is generated with a `JOB:` prefix.
- `audit_logs` itself is never audited — no recursive logging.

**Done when**:
- A direct `UPDATE audit_logs SET action = 'REDACTED' WHERE id = 1` executed with the app DB user fails with a permissions error
- A mutation and its audit row commit together — a simulated transaction failure leaves neither in the DB
- The `before` JSON for a fuel log contains `fuel_ml: 23000`, not `"23.0 L"`
- Background job mutations include a `JOB:` prefixed `correlation_id`
- `GET /api/v1/audit` (FMS-30) returns the full history of a vehicle with correct `before`/`after` diffs

**Don't**: Allow any API endpoint to update or delete audit log entries. The `REVOKE` is the guarantee.

**Unknown**: None.

---

### FMS-28: Audit Log Reader API
`track-core` `wave-1` · Est: S · Deps: FMS-27

**Goal**: Allow authorised users to query the audit trail to answer "who changed this record, and what did it look like before?" without direct database access.

**Where**: `GET /api/v1/audit` · `table audit_logs` · `api-contract.md §6.1` · roles `admin`, `fleet_owner`, `compliance_officer` only

**Layout / Behaviour**:
- Query params: `?entityType=vehicle&entityId=42`, `?userId=`, `?action=`, `?from=ISO_DATE&to=ISO_DATE`, `?correlationId=`.
- Cursor-based pagination (not offset) — large organisations may have thousands of audit entries.
- Money renders in response as formatted strings (e.g., `"150.00 ETB"`) for readability — but the stored value in `old_state`/`new_state` remains integer.
- Response includes `{id, tableName, recordId, action, oldState, newState, userId, userName, correlationId, createdAt}`.

**Done when**:
- `GET /api/v1/audit?entityType=vehicle&entityId=5` returns the full change history for vehicle 5 in reverse chronological order
- `GET /api/v1/audit?correlationId=abc` returns all entries from one request (e.g., a trip assignment that touched both the trip and the audit log in one transaction)
- Cursor pagination correctly pages through 500 audit entries without skipping or duplicating rows
- A `dispatcher` calling `GET /api/v1/audit` receives `403`
- Money in the response body displays as `"150.00 ETB"`, not as `15000`

**Don't**: Build the UI for the audit log here. That is FMS-30.

**Unknown**: None.

---

### FMS-29: Audit Log UI
`track-core` `wave-1` · Est: M · Deps: FMS-28, FMS-11

**Goal**: Give compliance officers and fleet owners a searchable, readable view of the full change history without needing to query the database directly.

**Where**: `packages/frontend/src/pages/AuditLog/` · `screen S-10` · Uses `DataTable` from FMS-11

**Layout / Behaviour**:
- Filter bar: Entity Type (dropdown), Entity ID (text), Actor (user selector), Date Range, Correlation ID.
- Table: Timestamp, Actor, Action, Entity, Correlation ID. Row expands to show a side-by-side `before`/`after` diff with only changed fields highlighted.
- Money values render formatted (`"150.00 ETB"`), never as raw integers.
- The diff renders as readable field labels, not raw JSON keys. (`"Fuel Amount"` not `"fuel_ml"`). Display labels are defined in a `fieldLabels.js` map.
- Read-only — no edit, delete, or export action in MVP.

**Done when**:
- Clicking a row expands to show only fields that changed, with old and new values side by side
- `fuel_ml` displays as `"Fuel Amount: 23.000 L → 25.000 L"` not `"fuel_ml: 23000 → 25000"`
- Money renders formatted in the diff view
- Filtering by `correlationId` shows all changes from one request (e.g., a trip assignment that updated both `trips` and `vehicles`)
- A `fleet_manager` accessing this page sees a blank RoleGate (no content, no "access denied")

**Don't**: Allow sorting or reordering of audit entries. Reverse chronological is the only meaningful order.

**Unknown**: None.

---

## PART 2: FEATURE CARDS — WAVE 2: OPERATIONS & TRACKING

---

### FMS-30: Trip CRUD API
`track-dispatch` `wave-2` · Est: M · Deps: FMS-15, FMS-16, FMS-06

**Goal**: Create the scheduling records that connect a driver, a vehicle, and a route for a specific time window — the core operational unit of the entire system.

**Where**: `GET /api/v1/trips` · `POST /api/v1/trips` · `PUT /api/v1/trips/:id` · `DELETE /api/v1/trips/:id` (soft cancel) · `table trips` · `api-contract.md §3.1`

**Layout / Behaviour**:
- `POST /api/v1/trips` requires: `driverId`, `vehicleId`, `routeId`, `scheduledStart`, `scheduledEnd`. Status defaults to `scheduled`.
- `scheduledEnd` must be after `scheduledStart` — returns `400 VALIDATION_INVALID_DATE_RANGE` if not.
- `DELETE /api/v1/trips/:id` sets `status = 'cancelled'` — does not delete the row.
- `GET /api/v1/trips` supports: `?status=`, `?driverId=`, `?vehicleId=`, `?date=YYYY-MM-DD`, `?depotId=`.
- All query params are additive (AND logic, not OR).

**Done when**:
- `POST /api/v1/trips` with `scheduledEnd` before `scheduledStart` returns `400 VALIDATION_INVALID_DATE_RANGE`
- `DELETE /api/v1/trips/:id` sets status to `cancelled` — the row still exists in the DB
- `GET /api/v1/trips?status=assigned&driverId=5` returns only assigned trips for driver 5
- Each mutation writes to `audit_logs`
- A `driver` can only `GET` their own trips — `GET /api/v1/trips?driverId=other` returns empty list, not `403`

**Don't**: Apply the business rule validation (BR-1, BR-2) in this card. That is FMS-31.

**Unknown**: None.

---

### FMS-31: Trip Assignment Business Rules Engine (BR-1 & BR-2)
`track-dispatch` `wave-2` · Est: L · Deps: FMS-30

**Goal**: Prevent dispatchers from creating physically impossible or unsafe assignments — a driver cannot be in two buses simultaneously, and a flagged vehicle cannot carry passengers. This is the most safety-critical logic in the system.

**Where**: `packages/backend/src/modules/dispatch/assignmentRules.js` · invoked by `POST /api/v1/trips/:id/assign` · `api-contract.md §3.2`

**Layout / Behaviour**:
- `POST /api/v1/trips/:id/assign` accepts `{driverId, vehicleId}` and runs both rules before any DB write.
- **BR-1 (Driver Overlap)**: Query all trips for `driverId` where `status IN ('assigned', 'en_route')` and `(scheduledStart, scheduledEnd)` overlaps with the new trip's window. A 0-minute gap is treated as an overlap. Returns `409 CONFLICT_DRIVER_OVERLAP` with `{conflictingTripId, conflictWindow}` in the response body.
- **BR-2 (Vehicle Maintenance Flag)**: Check `vehicles.maintenance_flag`. If `TRUE`, return `409 CONFLICT_VEHICLE_FLAGGED` with the open maintenance record ID in the response body.
- Both checks run in a single DB transaction. If BR-1 passes and BR-2 fails, the assignment is rejected and the driver's availability is not disturbed.
- A successful assignment changes trip `status` to `assigned` and emits a Socket.io event `trip_assigned` (consumed by FMS-47).
- The assignment is also written to `audit_logs`.

**Done when**:
- Assigning a driver who has an overlapping active trip returns `409 CONFLICT_DRIVER_OVERLAP` with the conflicting trip ID
- Assigning a driver with a trip ending at 09:00 to a trip starting at 09:00 returns `409` (0-minute gap is an overlap)
- Assigning a vehicle with `maintenance_flag = TRUE` returns `409 CONFLICT_VEHICLE_FLAGGED` with the maintenance record ID
- A trip where BR-1 would pass but BR-2 fails results in the assignment being rejected — the driver's other trips are unaffected
- Two concurrent assignment requests for the same driver and same overlapping slot produce one `200` and one `409` (optimistic lock or `SELECT FOR UPDATE`)
- A successful assignment emits `trip_assigned` on the Socket.io server

**Don't**: Add a "force assign" override flag for admins. If the business wants an override, it must be a separate, explicitly audited endpoint.

**Unknown**: If a driver's trip runs 10 minutes over its `scheduledEnd`, is the next scheduled trip a hard block or a soft warning? Must be answered by the Fleet Manager stakeholder before this card enters `In Progress`. (See CFG-4.)

---

### FMS-32: Trip Lifecycle State Machine
`track-dispatch` `wave-2` · Est: M · Deps: FMS-31

**Goal**: Enforce that trips progress through states in only the allowed order, preventing a cancelled trip from being re-activated or a completed trip from going back to en_route.

**Where**: `packages/backend/src/modules/dispatch/tripStateMachine.js` · `PUT /api/v1/trips/:id/status` · `table trips`

**Layout / Behaviour**:
- Valid transitions: `scheduled → assigned` (via FMS-31 assignment) · `assigned → en_route` (driver starts trip) · `en_route → completed` (driver ends trip) · `assigned → cancelled` · `scheduled → cancelled`.
- Illegal transitions return `409 CONFLICT_INVALID_STATE_TRANSITION` with `{currentState, attemptedState, allowedTransitions}`.
- `en_route → completed` records `actual_end = NOW()` and triggers the fuel log prompt (FMS-40) as a notification.
- `completed` and `cancelled` are terminal states. Any write attempt on a terminal-state trip returns `409`.

**Done when**:
- `PUT /api/v1/trips/:id/status` with `{status: 'en_route'}` on a `scheduled` trip (skipping `assigned`) returns `409 CONFLICT_INVALID_STATE_TRANSITION`
- Setting a `completed` trip to any status returns `409`
- `en_route → completed` records `actual_end` timestamp
- The `409` response body lists the `allowedTransitions` from the current state

**Don't**: Implement GPS-based automatic state transitions. Trip status is always manually set by the driver in MVP.

**Unknown**: None.

---

### FMS-33: Dispatcher Trip Console UI
`track-dispatch` `wave-2` · Est: L · Deps: FMS-31, FMS-32, FMS-11

**Goal**: Give dispatchers a single screen where they can see all unassigned routes, all available drivers, all idle vehicles, and make assignments — without switching tabs or opening spreadsheets.

**Where**: `packages/frontend/src/pages/Dispatch/` · `screen S-07` · Uses `DataTable`, `StatusBadge`, `ConfirmDialog` from FMS-11

**Layout / Behaviour**:
- Split-panel layout: left panel shows unassigned/scheduled trips for today. Right panel shows available drivers and vehicles.
- Driver availability colour: green (present & idle), amber (present but near end of another trip), grey (absent/on leave — sourced from attendance data FMS-21), red (currently en route).
- Vehicle availability: green (idle), red (maintenance_flag = TRUE), grey (en route).
- Assignment flow: dispatcher selects a trip, then clicks a driver, then clicks a vehicle. A "Confirm Assignment" panel slides in showing the trip window, driver's next trip, and vehicle status. Confirming calls `POST /api/v1/trips/:id/assign`.
- BR-1 / BR-2 errors from the API render inline in the assignment panel — not as a toast that disappears.
- Realtime: the panel updates every 30 seconds via polling in MVP (Socket.io live updates are Wave 3).

**Done when**:
- A driver marked absent (FMS-21) shows a grey badge and a tooltip "Absent today" — clicking still allows assignment (warning, not block)
- A vehicle with `maintenance_flag = TRUE` shows a red badge and selecting it shows the open maintenance record in the assignment panel
- A `409 CONFLICT_DRIVER_OVERLAP` from the API renders the conflicting trip details inline, not as a generic error toast
- Assigning successfully moves the trip from the left panel to an "Assigned" state in real time (or within 30s of the poll)
- A `driver` accessing this route sees the `RoleGate` render nothing

**Don't**: Build real-time WebSocket updates for this screen now. Polling every 30 seconds is sufficient for Wave 2. WebSocket is FMS-49.

**Unknown**: None.

---

### FMS-34: Driver Mobile PWA Shell & Service Worker
`track-maintenance` `wave-2` · Est: L · Deps: FMS-08

**Goal**: Make the driver-facing screens installable and offline-capable, because Ethiopian route buses frequently pass through areas with no internet coverage and a driver cannot wait for connectivity to submit a DVIR.

**Where**: `packages/frontend/public/manifest.json` · `packages/frontend/src/service-worker.ts` · Vite PWA plugin config

**Layout / Behaviour**:
- `manifest.json`: `name: "FMS Driver"`, `short_name: "FMS"`, `start_url: "/driver"`, `display: standalone`, `theme_color: fms-primary`. Include 192x192 and 512x512 icon variants.
- Service Worker (Workbox via Vite PWA plugin): precaches the Driver app shell (HTML, CSS, JS bundles). Network-first strategy for API calls. Cache-first for static assets.
- Offline fallback page: a simple HTML page that says "You are offline. Your submissions will be sent when you reconnect." Displayed when both the network and cache miss.
- Install prompt: an `useInstallPrompt` hook listens for the `beforeinstallprompt` event and stores it. A banner in the Driver Home (FMS-35) uses this hook to show an "Install App" button.

**Done when**:
- Opening `/driver` on Chrome Android shows an "Add to Home Screen" prompt or allows the in-app install banner
- After installation, the app opens in `standalone` mode (no browser chrome)
- With airplane mode enabled, the Driver Home loads from cache without a network request
- With airplane mode enabled, navigating to a cached route does not show a browser error page
- The offline fallback page displays when the user navigates to an uncached route while offline
- The service worker logs a `CACHE_HIT` or `NETWORK_RESPONSE` to the browser console for every request (in development mode only)

**Don't**: Cache the main admin dashboard in the service worker. Only `/driver*` routes are PWA-cached.

**Unknown**: None.

---

### FMS-35: Driver Mobile Home View
`track-dispatch` `wave-2` · Est: M · Deps: FMS-34, FMS-32

**Goal**: Give drivers a simple, large-text mobile view of today's assignment so they know where to be and can update their trip status with one tap — without needing to navigate a complex admin interface.

**Where**: `packages/frontend/src/pages/Driver/Home.tsx` · `screen S-11` · `GET /api/v1/trips?driverId=me&date=today`

**Layout / Behaviour**:
- Full-screen card: Route Name, Origin → Destination, Scheduled Departure Time, Vehicle Plate Number.
- Status action button: shows the next valid transition from the state machine. E.g., `assigned` → big green "START TRIP" button. `en_route` → big red "END TRIP" button.
- "No trip today" empty state: "You have no scheduled trips today. Contact your dispatcher."
- PWA install banner: shown once per device until dismissed (stored in `localStorage`).
- All text is large (min 18px) and high contrast — driver is reading on a moving vehicle.

**Done when**:
- A driver with a trip assigned today sees the route details on login
- "START TRIP" calls `PUT /api/v1/trips/:id/status` with `{status: 'en_route'}` and the button changes to "END TRIP" on success
- "END TRIP" calls the status update and the screen transitions to the "End of Trip" checklist prompt (linking to FMS-37 DVIR)
- A driver with no trip today sees the empty state message
- The screen renders correctly at 375px width (iPhone SE size) with no horizontal overflow

**Don't**: Show previous trips or trip history on this screen. This is "today only."

**Unknown**: None.

---

### FMS-36: DVIR API (Daily Vehicle Inspection Report)
`track-maintenance` `wave-2` · Est: M · Deps: FMS-02, FMS-06

**Goal**: Create a digital record of every pre-trip and post-trip inspection so vehicle defects are caught before they become accidents, and so there is a paper trail if a defect is reported after an incident.

**Where**: `POST /api/v1/dvir` · `GET /api/v1/dvir?vehicleId=&tripId=` · `table dvir_reports` · `api-contract.md §4.1`

**Layout / Behaviour**:
- `POST /api/v1/dvir` accepts: `vehicleId`, `tripId`, `type: 'pre_trip'|'post_trip'`, `items: [{name, passed: boolean, notes: string}]`, `issuesFound: boolean`.
- If `issuesFound = true`, automatically sets `vehicles.maintenance_flag = TRUE` and creates a notification for the Depot Admin and Technician (via FMS-26 notification pattern).
- Idempotent on `(vehicleId, tripId, type)` — a duplicate submission (e.g., offline queue replay) returns the original record, not a duplicate.
- `submittedAt` is the timestamp the driver submitted, which may differ from `createdAt` if submitted from the offline queue.

**Done when**:
- A DVIR with `issuesFound = true` sets `vehicles.maintenance_flag = TRUE` in the same DB transaction
- Submitting the same `(vehicleId, tripId, type)` twice returns the original record with `{created: false}` in the response
- `GET /api/v1/dvir?vehicleId=5` returns all DVIRs for vehicle 5, most recent first
- A `finance_clerk` calling `POST /api/v1/dvir` receives `403`
- `type` values other than `pre_trip` and `post_trip` return `400 VALIDATION_INVALID_ENUM`

**Don't**: Auto-lock a vehicle that fails a DVIR. The flag is set but a Technician must review and clear it.

**Unknown**: None.

---

### FMS-37: Driver Mobile DVIR Form (Offline-First)
`track-maintenance` `wave-2` · Est: XL · Deps: FMS-34, FMS-36

**Goal**: Allow drivers to complete vehicle inspection checklists even when their bus is at a depot with no WiFi, and guarantee the data reaches the server once connectivity is restored — so no inspection is ever skipped just because of a network failure.

**Where**: `packages/frontend/src/pages/Driver/DVIR.tsx` · `screen S-12` · `IndexedDB` via `idb` library · Service Worker background sync

**Layout / Behaviour**:
- Checklist items (pre-trip): Tyres, Brakes, Lights, Windscreen, Horn, Fuel Level, Engine Oil, Coolant, Fire Extinguisher, First Aid Kit. Each is a pass/fail toggle with an optional notes field.
- "Submit" action: if `navigator.onLine`, calls `POST /api/v1/dvir` immediately. If offline, serialises the form data to `IndexedDB` with a `status: 'pending'` key.
- Offline queue indicator: a persistent yellow "2 items pending sync" badge in the Driver app header when the queue has items.
- Background sync: Service Worker listens for the `sync` event (`dvir-sync` tag). On `online`, it reads all pending items from IndexedDB, posts them in sequence to the API (not in parallel — one failure should not block others), and removes successfully submitted items.
- If the JWT token has expired while offline, the sync pauses, the user sees a "Please log in to sync" banner, and the queue is preserved.
- Maximum queue size: 50 items (CFG-3 default). If exceeded, the submit button is disabled with "Too many pending submissions. Please sync before continuing."

**Done when**:
- Submitting a DVIR form in airplane mode saves it to IndexedDB and shows the "pending sync" badge
- Turning off airplane mode triggers the background sync within 10 seconds and the badge disappears
- 10 DVIRs submitted offline all arrive at the server in order after reconnection
- A replay of the same offline submission does not create a duplicate (idempotency key in IndexedDB payload)
- An expired token stops the sync, shows the "Please log in" banner, and preserves the queue
- With 51 items queued, the submit button is disabled with the documented message

**Don't**: Cache the full vehicle list for offline use. The DVIR checklist is static (hard-coded items). The only offline data is the submission queue.

**Unknown**: None.

---

### FMS-38: Incident Report API & Driver Form
`track-maintenance` `wave-2` · Est: M · Deps: FMS-36, FMS-34

**Goal**: Create a first-notice-of-incident record from the driver's perspective, immediately and from wherever they are, so the time between incident and official record is minimised.

**Where**: `POST /api/v1/incidents` · `GET /api/v1/incidents` · `table incident_reports` · `packages/frontend/src/pages/Driver/IncidentReport.tsx` · `screen S-13`

**Layout / Behaviour**:
- API: `POST /api/v1/incidents` requires `vehicleId`, `tripId`, `description` (text), `severity: 'minor'|'major'|'critical'`.
- A `severity: 'critical'` incident immediately sets `vehicles.maintenance_flag = TRUE` and creates high-priority notifications for Fleet Manager and Depot Admin.
- UI: a simple form (large text area, severity selector) accessible from the Driver Home via a red "REPORT INCIDENT" button.
- Offline-first: follows the same IndexedDB queue pattern as FMS-37.

**Done when**:
- A `severity: 'critical'` incident sets `maintenance_flag = TRUE` in the same transaction
- An incident report submitted offline syncs successfully when connectivity is restored
- A `fleet_manager` can retrieve incident reports via `GET /api/v1/incidents?vehicleId=5`
- A `driver` calling `GET /api/v1/incidents` only receives their own incident reports

**Don't**: Build incident management or resolution tracking. This card covers initial reporting only.

**Unknown**: None.

---

### FMS-39: Fuel Log API
`track-telemetry` `wave-2` · Est: M · Deps: FMS-02, FMS-06, FMS-04

**Goal**: Record every fuel purchase with the data needed to calculate cost-per-km and detect anomalies — fuel theft is one of the most common forms of fleet fraud and requires hard data to prosecute.

**Where**: `POST /api/v1/fuel-logs` · `GET /api/v1/fuel-logs` · `table fuel_logs` · `api-contract.md §5.1`

**Layout / Behaviour**:
- Required fields: `vehicleId`, `tripId`, `fuelMl` (integer millilitres), `costCents` (integer cents), `odometerKm` (integer).
- `fuelMl` must be a positive integer. A request body with `"fuelLitres": 23.5` is invalid — the client must convert before sending.
- `costCents` must be a positive integer.
- A float in either field returns `400 VALIDATION_FLOAT_IN_MONEY_PATH`.
- `odometerKm` must be greater than the vehicle's last recorded odometer reading — returns `409 CONFLICT_ODOMETER_REGRESSION` if not.
- Idempotent on `(vehicleId, tripId)` per trip in MVP — one fuel log per trip.

**Done when**:
- `POST /api/v1/fuel-logs` with `"fuelMl": 23500.5` (float) returns `400 VALIDATION_FLOAT_IN_MONEY_PATH`
- `POST /api/v1/fuel-logs` with an `odometerKm` lower than the vehicle's last reading returns `409 CONFLICT_ODOMETER_REGRESSION`
- A second fuel log for the same trip returns the original record with `{created: false}`
- `GET /api/v1/fuel-logs?vehicleId=5&from=2026-01-01&to=2026-03-01` returns only logs within the date range
- A `dispatcher` calling `POST /api/v1/fuel-logs` receives `403` (this is a driver or finance_clerk action only)

**Don't**: Calculate cost-per-km in this API. That is the reconciliation concern of FMS-40.

**Unknown**: Fuel stored in millilitres — does the UI display in litres with 2 decimal places or whole litres rounded? Must be confirmed. (See CFG-4.)

---

### FMS-40: Driver Mobile Fuel Entry Form (Offline-First)
`track-telemetry` `wave-2` · Est: M · Deps: FMS-39, FMS-34, FMS-04

**Goal**: Allow drivers to log fuel purchases from their phone at a fuel station, even if the station is in a coverage dead zone, so the record is accurate and not recreated from memory back at the depot.

**Where**: `packages/frontend/src/pages/Driver/FuelEntry.tsx` · `screen S-14`

**Layout / Behaviour**:
- Fields: Fuel Amount (user types in litres, e.g., `23.5` — `FuelInput` from FMS-11 converts to `23500` ml on submit), Cost in ETB (user types `350.00` — `MoneyInput` from FMS-11 converts to `35000` cents), Current Odometer (km, integer input).
- "Litres" label with the display value shown below the input for confirmation before submit.
- Offline-first: same IndexedDB queue pattern as FMS-37. Uses the same "pending sync" badge.
- Prompts automatically when the driver ends a trip (FMS-35 "END TRIP" button navigates here after confirmation).

**Done when**:
- Typing `23.5` in the fuel amount field and submitting sends `{fuelMl: 23500}` to the API — confirmed by inspecting the network request
- Typing a negative number in the fuel field shows a client-side validation error before any API call
- Submitting offline saves to IndexedDB and syncs when online
- The odometer field rejects non-integer input (e.g., `45002.5` shows a validation error)

**Don't**: Show cost-per-km calculations on this form. This is a data entry screen only.

**Unknown**: Same unknown as FMS-39 regarding litre display format.

---

### FMS-41: Fuel Reconciliation API
`track-telemetry` `wave-2` · Est: L · Deps: FMS-39

**Goal**: Calculate the expected fuel consumption for each vehicle based on distance driven and flag vehicles where the actual fuel purchased deviates significantly, so fraud is surfaced automatically rather than buried in spreadsheets.

**Where**: `GET /api/v1/fuel-reconciliation?vehicleId=&from=&to=` · background cron job (monthly) · `api-contract.md §5.2`

**Layout / Behaviour**:
- For each vehicle in the date range, calculates: `expected_ml = total_distance_km * vehicle.fuel_efficiency_ml_per_km`, `actual_ml = SUM(fuel_logs.fuel_ml)`, `variance_pct = ((actual_ml - expected_ml) / expected_ml) * 100`.
- A `variance_pct` outside ±20% (CFG-3 threshold) creates a `telemetry_flags` entry of type `fuel_variance`.
- `vehicle.fuel_efficiency_ml_per_km` is a column on the `vehicles` table set during vehicle registration — required field.
- The endpoint returns per-vehicle reconciliation data. The Finance Clerk UI (FMS-42) renders this.
- Integer arithmetic only — `variance_pct` is stored as an integer rounded to nearest whole percent.

**Done when**:
- A vehicle with actual fuel 25% above expected shows a `fuel_variance` flag in `telemetry_flags`
- A vehicle with actual fuel within 15% shows no flag
- `variance_pct` is computed and stored as an integer — no floating-point in the calculation path
- The monthly cron runs for 200 vehicles and completes within 60 seconds (documented budget)
- `GET /api/v1/fuel-reconciliation?vehicleId=5&from=2026-01-01&to=2026-01-31` returns the reconciliation for vehicle 5 for January

**Don't**: Auto-generate a report or alert managers automatically from this endpoint. Notifications are handled by FMS-51.

**Unknown**: None.

---

### FMS-42: Finance Fuel Reconciliation Dashboard UI
`track-telemetry` `wave-2` · Est: M · Deps: FMS-41, FMS-11

**Goal**: Give Finance Clerks a single screen where they can review all fleet fuel costs for a period, identify the highest-variance vehicles, and download a summary — replacing the monthly Excel reconciliation spreadsheet.

**Where**: `packages/frontend/src/pages/Fuel/Reconciliation.tsx` · `screen S-15` · Uses `DataTable`, `FuelDisplay`, `MoneyDisplay` from FMS-11

**Layout / Behaviour**:
- Date range selector and depot filter at the top.
- Summary band: total fuel purchased (litres), total fuel cost (ETB), fleet average variance %.
- `DataTable`: columns: Vehicle Plate, Depot, Expected (L), Actual (L), Variance %, Cost (ETB), Flag.
- Rows with variance outside ±20% show a red "FLAG" badge. Within ±10% shows green "OK". Between shows amber "WATCH".
- Sort by Variance % descending by default (worst outliers first).
- Download as CSV: a simple client-side CSV export of the table data.
- 5 required states applied.

**Done when**:
- Vehicles with > 20% variance show in red at the top of the default sort
- `FuelDisplay` renders `23000` ml as `"23.000 L"` — never as a float arithmetic result
- `MoneyDisplay` renders `35000` cents as `"350.00 ETB"`
- CSV export downloads a file with the correct data within 2 seconds
- A `driver` accessing this route sees `RoleGate` render nothing

**Don't**: Allow Finance Clerks to edit fuel logs from this screen. Editing fuel data requires going to the source record.

**Unknown**: None.

---

## PART 2: FEATURE CARDS — WAVE 3: ADVANCED FEATURES & AI

---

### FMS-43: Socket.io Server & Telemetry Event Contracts
`track-telemetry` `wave-3` · Est: M · Deps: FMS-07

**Goal**: Establish the real-time communication channel and define the exact event shapes that the GPS broadcaster (FMS-62) emits and the map (FMS-44) consumes, so both sides can be developed in parallel without breaking each other.

**Where**: `packages/backend/src/realtime/socketServer.js` · `packages/backend/src/realtime/events.js` · `api-contract.md §7` (WebSocket events section)

**Layout / Behaviour**:
- Socket.io server mounted on the same Express HTTP server, at `/socket.io`.
- Authentication: client must pass `{auth: {token: accessToken}}` on connection. Server validates the JWT. Unauthenticated connections are rejected immediately.
- Namespaces: `/telemetry` for GPS data (requires `driver` or `dispatcher` role), `/notifications` for alert events (all authenticated roles).
- Event contracts (defined in `events.js` and documented in `api-contract.md §7`):
  - `location_update` (client → server): `{tripId, lat, lng, speedKmh: integer, bearing: integer, accuracyM: integer}`
  - `vehicle_position` (server → client broadcast): `{vehicleId, tripId, lat, lng, speedKmh, bearing, lastSeen: ISO_timestamp}`
  - `trip_assigned` (server → client): `{tripId, driverId, vehicleId}`
  - `alert_created` (server → client): `{alertType, entityId, message, severity}`
- `location_update` events are rate-limited to one per 10 seconds per connection. Events arriving faster are silently dropped.
- Every `location_update` is persisted to `gps_pings` table asynchronously (fire and forget — do not block the acknowledgement).

**Done when**:
- A client connecting without a valid JWT is disconnected immediately with a `401` close reason
- A `driver` connecting to `/notifications` namespace is accepted
- A `driver` receiving a `location_update` event at faster than 10/minute rate has excess events silently dropped
- `location_update` payload with a float `speedKmh` (e.g., `65.5`) is rejected with a socket error event — only integers accepted
- A `vehicle_position` broadcast is received by all connected clients in the `/telemetry` namespace within 500ms (documented budget) of the `location_update`
- A `gps_pings` row is inserted for every accepted `location_update`

**Don't**: Build the map UI here. That is FMS-44 and FMS-45.

**Unknown**: None.

---

### FMS-44: Leaflet.js Map Integration
`track-telemetry` `wave-3` · Est: M · Deps: FMS-43, FMS-08

**Goal**: Render OpenStreetMap tiles in the browser and provide the foundation map component that the Fleet Command Center (FMS-45) places vehicle markers on.

**Where**: `packages/frontend/src/components/FleetMap/` · Leaflet.js + react-leaflet

**Layout / Behaviour**:
- `FleetMap` component accepts: `vehicles: [{vehicleId, lat, lng, status, speedKmh}]`, `onVehicleClick: (vehicleId) => void`.
- Renders OpenStreetMap tiles (no API key required).
- Each vehicle is a custom marker icon: green for `en_route`, amber for `idling` (flag from FMS-50), red for `breakdown` flag, grey for `offline` (last ping > 2 minutes ago).
- Marker tooltip on hover: Plate Number, Speed, Last Seen.
- Map auto-fits bounds to show all active vehicles on initial load.
- No network request is made for tile loading unless the map is visible in the viewport (lazy load).

**Done when**:
- The map renders OpenStreetMap tiles without a blank screen at standard zoom levels over Addis Ababa
- A vehicle marker with `speedKmh = 0` for > 5 minutes shows an amber marker (idling)
- A vehicle with no ping in the last 2 minutes shows a grey marker
- Clicking a marker calls `onVehicleClick` with the correct `vehicleId`
- The map component does not make any tile network requests when not mounted or when scrolled out of viewport

**Don't**: Connect the map to Socket.io directly. The parent component (FMS-45) manages the socket connection and passes `vehicles` as a prop.

**Unknown**: None.

---

### FMS-45: Fleet Command Center (Live Map UI)
`track-telemetry` `wave-3` · Est: L · Deps: FMS-44, FMS-43

**Goal**: Give dispatchers a live operational picture of the entire fleet so they can respond to delays, breakdowns, or speeding events within seconds rather than calling each driver.

**Where**: `packages/frontend/src/pages/FleetCommandCenter/` · `screen S-16` · Uses `FleetMap` from FMS-44, `StatusBadge` from FMS-11

**Layout / Behaviour**:
- Full-width layout: map occupies 70% of the screen. A sidebar on the right shows active trips as a scrollable list.
- Sidebar trip card: Plate Number, Driver Name, Route, Current Speed, Status Badge, time since last ping.
- Clicking a sidebar card pans the map to that vehicle's marker and shows a popup.
- Socket.io connection to `/telemetry` namespace. On each `vehicle_position` event, the corresponding marker moves and the sidebar card updates.
- "Last seen" timer counts up in real time. If no ping for > 2 minutes, the vehicle shows as `offline` (grey marker, sidebar card shows "OFFLINE" in red).
- A `speeding` flag from FMS-50 makes the marker pulse red and adds a "SPEEDING" badge to the sidebar card.
- Dashboard first paint must be under 2 seconds (documented budget) with 200 vehicles loaded.

**Done when**:
- The page loads and shows all active vehicles on the map within 2 seconds (200-vehicle dataset)
- A `vehicle_position` socket event moves the vehicle's marker on the map within 500ms (documented budget)
- A vehicle with no ping for 2 minutes turns grey without a page refresh
- A speeding flag causes the marker to pulse red and the sidebar card shows the "SPEEDING" badge
- Closing the browser tab closes the Socket.io connection gracefully (confirmed via server-side disconnect log)
- A `driver` accessing this route sees `RoleGate` render nothing

**Don't**: Show all historical GPS pings on the map. Only the current position per vehicle.

**Unknown**: None.

---

### FMS-46: Telemetry Rules Engine (Speeding & Idling)
`track-telemetry` `wave-3` · Est: M · Deps: FMS-43

**Goal**: Automatically detect and flag dangerous or wasteful driving behaviour from the live GPS stream so a dispatcher can intervene without manually watching every vehicle simultaneously.

**Where**: `packages/backend/src/realtime/rulesEngine.js` · runs on each `location_update` event · `table telemetry_flags`

**Layout / Behaviour**:
- **Speeding rule**: if `speedKmh > 80` (CFG-3 threshold) for 3 consecutive pings (30 seconds sustained), create a `telemetry_flags` entry with `flag_type = 'speeding'`. Emit `alert_created` to the `/notifications` namespace.
- **Idling rule**: if `speedKmh = 0` for 30 consecutive pings (5 minutes), create a `telemetry_flags` entry with `flag_type = 'idling'`. Emit `alert_created`.
- **Auto-resolve**: if a speeding flag is active and `speedKmh <= 80` for 3 consecutive pings, set `telemetry_flags.resolved_at = NOW()` and emit `alert_resolved`.
- In-memory state per vehicle (map of `{vehicleId: {consecutivePings, flagId}}`). Lost on server restart — acceptable for MVP.
- Only one active (unresolved) flag of each type per vehicle at a time — if a speeding flag is already open, do not create another.

**Done when**:
- Three consecutive `location_update` events with `speedKmh = 90` create exactly one speeding flag
- Two consecutive `location_update` events with `speedKmh = 90` create zero flags
- A speeding flag is auto-resolved when three consecutive pings show `speedKmh <= 80`
- An `alert_created` Socket.io event is emitted to `/notifications` when a flag is created
- Only one speeding flag per vehicle can be open at a time — a second does not create a duplicate row
- The rules engine processes 200 concurrent vehicle events without dropping any (load test in FMS-66)

**Don't**: Persist the in-memory consecutive-ping counters to the DB. State resets on restart — fine for MVP.

**Unknown**: The 80 km/h threshold — is this national law, operator policy, or configurable per depot? (See CFG-4.)

---

### FMS-47: Cron Jobs — Expiry & Maintenance Alerts
`track-telemetry` `wave-3` · Est: M · Deps: FMS-26, FMS-22

**Goal**: Proactively notify relevant users of upcoming deadlines so they are not surprised by an expired document or an overdue maintenance service the day it becomes a problem.

**Where**: `packages/backend/src/jobs/` · node-cron · `table notifications` · `api-contract.md §8`

**Alert types and rules**:
- **Document expiry** (runs daily 07:00): scan `documents` where `expiryDate` between today and today+30 days. Notify `depot_admin` and `fleet_manager` of the depot. Severity: amber at 30 days, red at 7 days.
- **License expiry** (runs daily 07:00): same logic for `drivers.licenseExpiry`. Notify `depot_admin`.
- **Maintenance overdue** (runs daily 08:00): scan vehicles where `maintenance_flag = TRUE` and `maintenance_records.created_at < NOW() - 48 hours` (flag open but no completed record in 48 hours). Notify `fleet_manager` and `technician`.

**Done when**:
- The document expiry cron creates a notification for a document expiring in 15 days when run
- Re-running the cron does not duplicate the notification (UPSERT logic)
- A document expiring in 5 days creates a red-severity notification; 20 days creates amber
- A maintenance flag open for 49 hours creates an "overdue" notification
- All three crons complete for a 200-vehicle, 300-driver dataset within 30 seconds total

**Don't**: Send emails or SMS in MVP. Notifications are in-app only (FMS-53 renders them).

**Unknown**: None.

---

### FMS-48: Notification Inbox API
`track-telemetry` `wave-3` · Est: S · Deps: FMS-02

**Goal**: Give users a queryable list of all alerts and notifications sent to them, with read/unread state, so no alert is silently missed.

**Where**: `GET /api/v1/notifications` · `PUT /api/v1/notifications/:id/read` · `PUT /api/v1/notifications/read-all` · `table notifications`

**Layout / Behaviour**:
- `GET /api/v1/notifications` is scoped to `req.user.id` — users only see their own notifications.
- Supports `?unread=true` filter.
- `PUT /api/v1/notifications/:id/read` sets `read_at = NOW()`.
- Unread count is also emitted via `notification_count_update` Socket.io event on the `/notifications` namespace whenever a new notification is created for the user.

**Done when**:
- `GET /api/v1/notifications` for User A never returns User B's notifications
- After `PUT /api/v1/notifications/:id/read`, `read_at` is set and `?unread=true` no longer returns it
- A new notification emits `notification_count_update` to the user's socket room within 1 second
- `PUT /api/v1/notifications/read-all` marks all of the user's unread notifications as read in one operation

**Don't**: Allow deleting notifications. The inbox is an append-only record in MVP.

**Unknown**: None.

---

### FMS-49: Global Notification Inbox UI
`track-telemetry` `wave-3` · Est: M · Deps: FMS-48, FMS-43

**Goal**: Surface alerts to users in real time without requiring them to navigate away from their current task, so a speeding alert reaches the dispatcher within seconds.

**Where**: `packages/frontend/src/components/NotificationInbox/` · Used in the main app `TopBar` · `screen S-17`

**Layout / Behaviour**:
- A bell icon in the top navigation bar. Red badge with unread count (max displays "99+").
- Clicking opens a slide-down panel: list of notifications with icon (severity-appropriate), message, time ago, and "Mark as read" action.
- "Mark all as read" button at the top of the panel.
- Real-time: connects to `/notifications` Socket.io namespace. On `notification_count_update` event, the badge count updates without a page refresh.
- Clicking a notification with an `entityLink` (e.g., `/vehicles/5`) navigates to that entity.

**Done when**:
- A new alert created server-side increments the bell badge count in real time (without a page refresh) within 1 second
- "Mark all as read" clears the badge to 0 and all list items show as read
- Clicking a notification with an entity link navigates to the correct page
- Unread notifications are visually distinct from read ones (bolder text or left border)
- The panel renders correctly on a 375px mobile screen

**Don't**: Show notification history older than 30 days in the panel. Older items are accessible via the full audit log.

**Unknown**: None.

---

### FMS-50: Analytics Aggregation API
`track-telemetry` `wave-3` · Est: L · Deps: FMS-32, FMS-41

**Goal**: Produce pre-aggregated fleet performance metrics so the Analytics Dashboard (FMS-51) does not run expensive GROUP BY queries on every page load.

**Where**: `GET /api/v1/analytics/utilisation` · `GET /api/v1/analytics/costs` · `GET /api/v1/analytics/driver-performance` · `api-contract.md §9`

**Metrics to compute**:
- **Fleet Utilisation**: for each vehicle, `utilised_hours / available_hours * 100` per week. `available_hours = 8 * work_days`. `utilised_hours = SUM(actual_end - actual_start)` for completed trips.
- **Cost per km**: `SUM(fuel_logs.cost_cents) / SUM(trip distance_km)` per vehicle per month. Integer arithmetic — stored in `cost_per_km_cents_per_km`.
- **Driver on-time rate**: `COUNT(trips where actual_start <= scheduled_start + 10 min) / COUNT(trips) * 100`.
- All aggregations are cached in a `analytics_cache` table, refreshed by a nightly cron at 01:00.
- The API reads from `analytics_cache`, not from raw tables. Max allowed age of cache: 25 hours.

**Done when**:
- `GET /api/v1/analytics/utilisation` responds within 200ms for a 200-vehicle depot (reading from cache)
- A vehicle with 8 hours of trips in an 8-hour workday shows `utilisation: 100`
- `cost_per_km_cents_per_km` is an integer — no float in the calculation path
- The nightly cron updates `analytics_cache` for 200 vehicles within 90 seconds
- If the cache is older than 25 hours (cron missed a run), the API returns `{stale: true}` in the response

**Don't**: Expose raw `GROUP BY` queries via the API. All analytics go through the cache.

**Unknown**: None.

---

### FMS-51: Analytics Dashboard UI
`track-telemetry` `wave-3` · Est: L · Deps: FMS-50, FMS-11

**Goal**: Give Fleet Owners and Fleet Managers a single visual overview of fleet health, efficiency, and cost that tells the story of the month without requiring them to interpret raw data.

**Where**: `packages/frontend/src/pages/Analytics/` · `screen S-18` · Chart.js via `react-chartjs-2`

**Layout / Behaviour**:
- Top KPI band: Total Fleet Utilisation %, Total Fuel Cost (ETB), Average Cost per KM (ETB/km), Fleet-wide On-time Rate %.
- Fleet Utilisation chart: stacked bar chart, one bar per vehicle, segmented by `en_route` vs `idle`.
- Cost Trends chart: line chart, monthly fuel cost per vehicle over the last 6 months.
- Driver Performance table: `DataTable` with Driver Name, Trips Completed, On-time Rate %, Average Fuel (L/trip). Sortable by on-time rate descending.
- If `{stale: true}` is in the API response, a yellow banner "Analytics data was last updated over 24 hours ago" appears at the top.
- 5 required states applied.

**Done when**:
- The KPI band shows values sourced from the API — not computed client-side
- `MoneyDisplay` renders all monetary values — no raw integer rendered to the user
- A `{stale: true}` response shows the yellow stale data banner
- The utilisation bar chart renders 200 vehicles without crashing the browser tab (virtual DOM windowing via Chart.js canvas)
- A `driver` accessing this route sees `RoleGate` render nothing

**Don't**: Allow date range filtering on the Analytics Dashboard in Wave 3. That is a Wave 4 enhancement.

**Unknown**: None.

---

### FMS-52: AI Synthetic Training Dataset
`track-maintenance` `wave-3` · Est: M · Deps: None

**Goal**: Generate a realistic synthetic dataset with enough variation to train a meaningful predictive model, because the FMS will not have months of real operational data at the time of the senior project defence.

**Where**: `packages/ai-service/scripts/generate_training_data.py` · output: `packages/ai-service/data/training_data.csv`

**Dataset specification**:
- 500 synthetic vehicles, each with 24 months of monthly records.
- Features per record: `mileage_km` (monthly), `engine_hours`, `days_since_last_service`, `num_fault_reports`, `fuel_variance_pct`, `age_years`.
- Target variable: `failure_within_30_days` (boolean). Correlation rules: `days_since_last_service > 90 AND num_fault_reports >= 3` → 80% failure probability. High mileage + old vehicle → 60% probability. Otherwise → 5%.
- Output: `training_data.csv` with 12,000 rows (500 vehicles × 24 months).
- Seed is fixed (`random.seed(42)`) so the dataset is reproducible.

**Done when**:
- `python generate_training_data.py` completes in under 60 seconds
- The output CSV has exactly 12,000 rows
- The `failure_within_30_days` column has approximately 15–25% positive rate (realistic class imbalance)
- Running the script twice produces identical CSV output (seed is fixed)
- A data validation script confirms no null values in any column

**Don't**: Use real vehicle data even if it becomes available — privacy implications. Synthetic only.

**Unknown**: What is the minimum number of records needed for the model to produce meaningful predictions? Developer B must assess before training. (See CFG-4.)

---

### FMS-53: AI Predictive Maintenance Model (Python)
`track-maintenance` `wave-3` · Est: L · Deps: FMS-52

**Goal**: Train a model that can assign a Health Score (0–100) to any vehicle given its recent operational data, turning raw telemetry into an actionable risk number that a Fleet Manager can understand without a data science background.

**Where**: `packages/ai-service/train.py` · `packages/ai-service/models/health_model.pkl` · `packages/ai-service/evaluate.py`

**Layout / Behaviour**:
- Algorithm: `RandomForestClassifier` from scikit-learn. Chosen for interpretability — feature importances can be explained to an academic evaluator.
- Features: same 6 features as the training dataset.
- Target: `failure_within_30_days`.
- Health Score derivation: `health_score = round((1 - failure_probability) * 100)`. An 80% probability of failure = score of 20.
- Train/test split: 80/20, stratified by target.
- Evaluation metrics logged to `evaluate.py` output: Precision, Recall, F1, ROC-AUC. Minimum acceptable: F1 ≥ 0.70 on test set.
- Trained model serialised with `joblib.dump()` to `models/health_model.pkl`.

**Done when**:
- `python train.py` runs without errors and produces `health_model.pkl`
- `python evaluate.py` prints F1 ≥ 0.70 on the test set
- A vehicle with `days_since_last_service = 100, num_fault_reports = 5` scores below 30 (high risk)
- A vehicle with `days_since_last_service = 10, num_fault_reports = 0` scores above 85 (healthy)
- The model file size is under 50 MB (joblib default compression)

**Don't**: Use a deep learning model. A Random Forest is sufficient for the data volume and must be explainable in a 20-minute defence presentation.

**Unknown**: Same as FMS-52.

---

### FMS-54: Python AI Microservice (Flask API)
`track-maintenance` `wave-3` · Est: M · Deps: FMS-53

**Goal**: Expose the trained model as an HTTP API so the Node.js backend can query health scores without running Python itself, and so the model can be updated independently of the backend.

**Where**: `packages/ai-service/app.py` · `POST /predict` · Dockerised alongside the main stack in `docker-compose.yml`

**Layout / Behaviour**:
- `POST /predict` accepts: `{features: {mileage_km, engine_hours, days_since_last_service, num_fault_reports, fuel_variance_pct, age_years}}`.
- Returns: `{healthScore: integer, failureProbability: float, riskLevel: 'low'|'medium'|'high'}`. `failureProbability` is a float here — it is display-only, never stored in the DB.
- `riskLevel`: `low` if `failureProbability < 0.25`, `medium` if < 0.60`, `high` if ≥ 0.60`.
- Auth: the Node.js backend sends a shared secret in `X-Internal-Token` header. Requests without it return `401`.
- Model is loaded once at startup from `models/health_model.pkl`, not on every request.

**Done when**:
- `POST /predict` with valid features returns `{healthScore: 82, failureProbability: 0.18, riskLevel: 'low'}`
- `POST /predict` with a missing feature returns `400 MISSING_FEATURE` with the missing field named
- A request without `X-Internal-Token` returns `401`
- The service starts in under 5 seconds (model loading time)
- Inference for a single vehicle completes in under 200ms (documented budget)
- 10 concurrent requests are handled without timeout

**Don't**: Expose this service to the public internet. It is internal-only, reachable only within the Docker network.

**Unknown**: None.

---

### FMS-55: Node.js ↔ AI Service Integration & Nightly Batch
`track-maintenance` `wave-3` · Est: M · Deps: FMS-54, FMS-22

**Goal**: Run a nightly batch that scores every active vehicle and stores its health score so the dashboard can display it without a real-time model call on every page load.

**Where**: `packages/backend/src/jobs/aiHealthScore.js` · nightly cron 02:00 · `table vehicles` (add `health_score INT` and `health_score_updated_at` columns) · `POST /predict` on AI service

**Layout / Behaviour**:
- The nightly cron queries all `is_active = TRUE` vehicles and for each, fetches the last 30 days of telemetry from `gps_pings`, `fuel_logs`, and `maintenance_records` to build the feature vector.
- Calls `POST /predict` on the AI service for each vehicle sequentially (not in parallel — to avoid hammering the Flask server).
- Updates `vehicles.health_score` and `vehicles.health_score_updated_at` in the DB.
- If a vehicle's score drops below 75 (CFG-3 threshold), creates a `notifications` entry for the `fleet_manager` and `technician`.
- Completes for 200 vehicles within 90 seconds (documented budget).

**Done when**:
- After the cron runs, `vehicles.health_score` is populated for all active vehicles
- A vehicle scoring 60 generates a notification for the technician
- A vehicle scoring 80 generates no notification
- The cron completes for 200 vehicles within 90 seconds
- If the AI service is unreachable, the cron logs the error and continues with the next vehicle — it does not crash the entire batch

**Don't**: Call the AI service in real time on `GET /api/v1/vehicles/:id`. Only the batch updates scores. The score in the DB is what the UI shows.

**Unknown**: None.

---

### FMS-56: Predictive Maintenance Health Score UI
`track-maintenance` `wave-3` · Est: M · Deps: FMS-55, FMS-11

**Goal**: Surface the AI health scores to Fleet Managers and Technicians in a readable format so they can prioritise which vehicles to service next, not based on mileage alone but on the model's risk prediction.

**Where**: `packages/frontend/src/pages/PredictiveMaintenance/` · `screen S-19` · Health score added to Vehicle Detail panel

**Layout / Behaviour**:
- A new "Health" column in the Vehicle Management Dashboard (FMS-18) showing a coloured score badge: ≥ 85 green, 75–84 amber, < 75 red.
- Clicking a vehicle opens a detail panel with: Health Score gauge (0–100), Risk Level badge, Last Scored timestamp, and a breakdown of the top 3 contributing features (e.g., "Days since last service: HIGH IMPACT").
- If `health_score_updated_at` is > 25 hours ago, the score shows with a grey "STALE" overlay.
- A "View Maintenance History" link goes to the vehicle's maintenance records.

**Done when**:
- A vehicle with score 60 shows a red badge in the vehicle list
- A vehicle with a stale score (> 25 hours old) shows a grey "STALE" overlay instead of the colour badge
- The feature breakdown shows the correct top 3 features (sourced from `feature_importances_` exported from FMS-53)
- A `dispatcher` sees the health score badge (read-only) but not the feature breakdown detail panel (restricted by RoleGate to `fleet_manager` and `technician`)

**Don't**: Allow users to manually set or override the health score. The score is model-only.

**Unknown**: None.

---

## PART 2: FEATURE CARDS — WAVE 4: POLISH, SECURITY & TESTING

---

### FMS-57: PWA Geolocation Broadcaster
`track-telemetry` `wave-4` · Est: M · Deps: FMS-34, FMS-43

**Goal**: Replace the simulated GPS data in FMS-43 with a driver's real smartphone location, so the Fleet Command Center shows actual vehicles moving on real roads — making the live demo at the defence convincing.

**Where**: `packages/frontend/src/hooks/useGeolocation.ts` · used in `packages/frontend/src/pages/Driver/Home.tsx` · emits to Socket.io `/telemetry` namespace

**Layout / Behaviour**:
- `useGeolocation` hook: calls `navigator.geolocation.watchPosition()` when the driver's trip status becomes `en_route`.
- On each position callback: if `accuracy > 100m` (CFG-4 threshold), the ping is discarded and a console warning logged. If accuracy ≤ 100m, emit `location_update` to the Socket.io server.
- Rate limiting enforced client-side: emits at most once every 10 seconds. If `watchPosition` fires more frequently, events are buffered and only the latest is sent on the next 10-second window.
- Stops broadcasting on `completed` or `cancelled` trip status.
- If permission is denied: shows a banner "Location access denied. Your position will not be shown on the dispatch map." Does not crash. Trip continues normally.
- Battery consideration: `watchPosition` options: `{enableHighAccuracy: false, maximumAge: 10000, timeout: 5000}` — trades some accuracy for battery life.

**Done when**:
- A driver's phone in motion shows a moving marker on the Fleet Command Center map (FMS-45)
- A position ping with `accuracy > 100m` does not emit a socket event (confirmed via server-side ping count)
- Denying location permission shows the banner and does not break the Driver Home
- Stopping the trip (`completed`) stops geolocation polling — confirmed by checking `navigator.geolocation.clearWatch` was called
- The socket emits at most 6 events per minute regardless of how frequently `watchPosition` fires

**Don't**: Store the raw `watchPosition` readings in the DB. Only accepted pings (accuracy ≤ 100m) are stored in `gps_pings`.

**Unknown**: What GPS accuracy threshold in metres — 50m, 100m, or 200m — is acceptable for Ethiopian urban roads? Must be tested on a physical device before this card merges. (See CFG-4.)

---

### FMS-58: IndexedDB Background Sync & Reconnect Flush
`track-maintenance` `wave-4` · Est: M · Deps: FMS-37, FMS-40

**Goal**: Ensure the offline queue is reliably flushed when connectivity restores, including edge cases like an expired token during offline period, so drivers never lose a submitted form to a silent sync failure.

**Where**: `packages/frontend/src/service-worker.ts` · `packages/frontend/src/lib/offlineQueue.ts`

**Layout / Behaviour**:
- The Service Worker registers a Background Sync tag `fms-offline-queue` when an item is added to IndexedDB.
- On `sync` event: read all pending items from IndexedDB sorted by `queuedAt` ascending. For each item, attempt `fetch`. On success, remove from IndexedDB. On failure, leave in queue (the browser will retry the Background Sync automatically).
- If the server returns `401 AUTH_TOKEN_EXPIRED`: abort the flush, write a `syncError` entry to IndexedDB with `reason: 'expired_token'`, and emit a `syncError` message to the main thread (for FMS-37 to display the login banner).
- If the server returns `409` (e.g., duplicate DVIR): mark the item as `conflict` in IndexedDB and remove it from the pending queue — it will not retry.
- The main thread listens to the Service Worker's `message` event and updates the "pending sync" badge count accordingly.

**Done when**:
- 5 DVIRs submitted offline sync in order when connectivity restores, with correct `queuedAt` timestamps
- A `409` response from the server on replay marks the item as `conflict` and removes it from the pending badge count
- An expired token stops the sync, emits `syncError` to the main thread, and the Driver Home shows the login banner
- After logging in again, the sync resumes from where it stopped (the queue is intact)
- The "pending sync" badge reaches 0 after all items successfully sync

**Don't**: Clear the IndexedDB queue on logout. The queue persists across sessions — a driver who logs out and back in should still see their pending items.

**Unknown**: None.

---

### FMS-59: Security Audit — RBAC Bypass Tests
`track-core` `wave-4` · Est: L · Deps: FMS-06

**Goal**: Prove that the RBAC implementation cannot be bypassed by a user who knows the API endpoints — because a disgruntled driver who knows Express routes must not be able to read the Finance Clerk's reconciliation data.

**Where**: `packages/backend/tests/security/rbacAudit.test.js` · runs in CI pipeline

**Layout / Behaviour**:
- For every protected API endpoint documented in `api-contract.md`, a test asserts: (1) a request without any auth token returns `401`. (2) A request with a token for each non-permitted role returns `403`. (3) A request with a permitted role returns the correct `2xx`.
- Depot-scoping tests: a user from Depot A calling an endpoint scoped to Depot B returns either `404` or empty data, never Depot B's data.
- The test suite is generated from the permissions map (`permissions.js`) automatically — adding a new endpoint without updating `permissions.js` fails the test suite.

**Done when**:
- Every endpoint in `api-contract.md` has at least one RBAC test asserting `401` for unauthenticated and `403` for a non-permitted role
- A `driver` calling `GET /api/v1/fuel-reconciliation` returns `403` in the test
- A `dispatcher` from Depot A calling `GET /api/v1/trips?depotId=B` returns an empty list, not Depot B's trips
- Adding a new route to the backend without a corresponding entry in `permissions.js` fails the CI pipeline
- The RBAC test suite completes in under 60 seconds

**Don't**: Test business logic in these tests. RBAC tests assert only status codes and data scoping, not response body content.

**Unknown**: None.

---

### FMS-60: Optimistic Locking for Trip Assignment
`track-dispatch` `wave-4` · Est: M · Deps: FMS-31

**Goal**: Prevent two dispatchers from assigning the same driver to overlapping trips simultaneously, which the business rule check (FMS-31) could miss in a race condition between the check and the write.

**Where**: `packages/backend/src/modules/dispatch/assignmentRules.js` · `table trips` (add `version INT DEFAULT 0`) · `api-contract.md §3.2`

**Layout / Behaviour**:
- Add `version` column to `trips` table.
- Assignment endpoint reads the current `version`, performs the BR-1 and BR-2 checks, then does a conditional update: `UPDATE trips SET status = 'assigned', version = version + 1 WHERE id = ? AND version = ?`.
- If the `UPDATE` affects 0 rows (version changed since the check), return `409 CONFLICT_CONCURRENT_MODIFICATION`.
- The `version` is returned in `GET /api/v1/trips/:id` responses so clients can pass it back on write operations (in a future iteration).

**Done when**:
- Two simultaneous assignment requests for the same driver and overlapping slot produce exactly one `200` and one `409 CONFLICT_CONCURRENT_MODIFICATION`
- A simulated race condition test (two concurrent requests with artificial 100ms sleep between BR check and write) reliably produces the correct outcome
- The `version` field appears in `GET /api/v1/trips/:id` response

**Don't**: Apply optimistic locking to every table. Only the `trips` assignment path has concurrent access risk that justifies it.

**Unknown**: None.

---

### FMS-61: Load Testing Suite
`track-core` `wave-4` · Est: L · Deps: FMS-43, FMS-45

**Goal**: Prove the system can handle realistic concurrent load before the senior project defence, so a live demo with 5 people opening the Fleet Command Center simultaneously does not crash the server.

**Where**: `packages/backend/tests/load/` · Artillery or k6 load test scripts

**Test scenarios**:
1. **Socket.io concurrent connections**: 200 simulated vehicles broadcasting `location_update` every 10 seconds for 5 minutes. Assert: zero dropped events, server CPU < 80%.
2. **API throughput**: 50 concurrent users making `GET /api/v1/trips`, `GET /api/v1/vehicles`, `POST /api/v1/fuel-logs` requests for 2 minutes. Assert: p95 response time meets documented budgets.
3. **Dashboard load**: 20 concurrent users loading the Fleet Command Center. Assert: first meaningful paint data (from API) under 2 seconds.

**Done when**:
- Scenario 1: zero socket events dropped in a 5-minute run with 200 simulated vehicles
- Scenario 2: `GET /api/v1/trips` p95 under 200ms, `POST /api/v1/fuel-logs` p95 under 400ms under 50-user load
- Scenario 3: the analytics cache query returns in under 200ms under 20-user concurrent load
- Load test results are saved as a JSON report artifact in CI
- If any metric fails the documented budget, the load test CI job fails

**Don't**: Run load tests against the production DB. Load tests run against a seeded test DB only.

**Unknown**: None.

---

### FMS-62: Unit Tests for BR-1 & BR-2 Assignment Rules
`track-dispatch` `wave-4` · Est: M · Deps: FMS-31

**Goal**: Prove through unit tests that the business rule engine correctly handles all edge cases of the scheduling logic, so a future developer cannot accidentally change the overlap calculation without breaking a test.

**Where**: `packages/backend/tests/unit/assignmentRules.test.js`

**Test cases to cover**:
- BR-1 — exact overlap (Trip A 09:00–10:00, Trip B 09:30–11:00) → should block
- BR-1 — adjacent no-gap (Trip A 09:00–10:00, Trip B 10:00–11:00) → should block (0-minute gap is an overlap)
- BR-1 — adjacent with gap (Trip A 09:00–10:00, Trip B 10:01–11:00) → should allow
- BR-1 — fully contained (Trip A 09:00–12:00 contains Trip B 10:00–11:00) → should block
- BR-1 — no conflict (Trip A 09:00–10:00, Trip B 12:00–13:00) → should allow
- BR-2 — vehicle with `maintenance_flag = TRUE` → should block with maintenance record ID
- BR-2 — vehicle with `maintenance_flag = FALSE` → should allow
- BR-1 + BR-2 both failing → should return BR-1 error first (order of checks matters)

**Done when**:
- All 8 test cases above pass
- 0-minute gap case correctly blocks
- The test file runs in under 5 seconds (pure unit tests with no DB)
- Adding these tests is required before FMS-60 (optimistic locking) can merge

**Don't**: Test the HTTP layer in this file. These are pure unit tests of the rule functions with mock DB results.

**Unknown**: None.

---

### FMS-63: E2E Workflow Test
`track-core` `wave-4` · Est: L · Deps: FMS-69 (all features complete)

**Goal**: Prove the critical end-to-end user journey works as an integrated system — from a driver submitting a fault to a technician fixing the vehicle and a dispatcher successfully re-assigning it — because this is the sequence the defence evaluators will be walked through.

**Where**: `packages/backend/tests/e2e/` or Playwright scripts in `packages/frontend/tests/e2e/`

**Workflow to test (the "Golden Path")**:
1. Driver logs in on mobile → submits DVIR with `issuesFound: true` for Vehicle 7
2. Vehicle 7's `maintenance_flag` becomes `TRUE`
3. Technician logs in → sees Vehicle 7 flagged on the Maintenance board
4. Technician creates a maintenance record for Vehicle 7 → marks it complete
5. Vehicle 7's `maintenance_flag` becomes `FALSE`
6. Fleet Manager receives a notification that Vehicle 7 is available
7. Dispatcher opens Trip Console → sees Vehicle 7 is available (no maintenance flag)
8. Dispatcher assigns Driver 3 + Vehicle 7 to Route 5 → trip status becomes `assigned`
9. Driver 3 starts trip → status becomes `en_route` → GPS coordinates appear on the Fleet Command Center map
10. Driver 3 ends trip → status becomes `completed` → Fuel Entry prompt appears

**Done when**:
- All 10 steps of the golden path complete without any errors or manual intervention
- The test runs in a seeded test environment (not production data)
- The full test completes in under 5 minutes
- If any step fails, the error message identifies which step and includes the correlation ID

**Don't**: Try to automate the Playwright steps for mobile DVIR in Wave 4. Steps 1–2 can be API-driven in the E2E test; visual automation of the PWA is optional.

**Unknown**: None.

---

### FMS-64: Screen State Audit
`track-core` `wave-4` · Est: M · Deps: All UI cards

**Goal**: Verify that every screen in `screen-inventory.md` correctly handles all five required states (Loading, Empty, Error, Success, Skeleton), so no screen shows a blank white page or an unhandled JavaScript error when a real user encounters an edge case.

**Where**: `screen-inventory.md` checklist · Visual review + Jest snapshot tests for each shared component state

**Layout / Behaviour**:
- Walk through every screen listed in `screen-inventory.md`.
- For each screen: (1) introduce a network delay and verify the Loading skeleton appears. (2) Clear the test data and verify the Empty state renders the `EmptyState` component with correct text. (3) Disconnect the backend and verify the ErrorBoundary renders with a correlation ID. (4) Restore and verify Success state.
- Log any screen that shows a raw `undefined`, blank white area, or unformatted error in a bug tracker card.

**Done when**:
- All screens in `screen-inventory.md` are checked against the 4 testable states (Success is always assumed correct if the screen works)
- Zero screens show a blank white area under any simulated failure condition
- All `ErrorBoundary` instances display a correlation ID
- Findings documented as a checklist in the `screen-inventory.md` file with pass/fail per screen

**Don't**: Fix the bugs found in this audit within this card. Create new bug cards for each finding.

**Unknown**: None.

---

### FMS-65: API Documentation (OpenAPI / Swagger)
`track-core` `wave-4` · Est: M · Deps: FMS-07

**Goal**: Generate living API documentation from the actual Express route handlers so the documentation cannot be out of sync with the implementation — critical for the defence presentation and for future contributors.

**Where**: `packages/backend/src/docs/swagger.js` · `swagger-jsdoc` + `swagger-ui-express` · served at `GET /api-docs`

**Layout / Behaviour**:
- Every endpoint in `api-contract.md` has a corresponding JSDoc `@openapi` annotation in its route file.
- Swagger UI served at `/api-docs` in development only (`NODE_ENV !== 'production'`).
- Generated `docs/swagger.json` is committed to the repo and checked in CI — if the generated file differs from the committed file, CI fails. This prevents undocumented endpoints.
- Authentication: the Swagger UI "Authorize" button accepts a Bearer token so testers can try endpoints directly.

**Done when**:
- `GET /api-docs` renders the Swagger UI with all endpoints grouped by tag (matching track names)
- Using the "Try it out" button on `POST /api/v1/auth/login` with valid credentials returns a `200` and sets the auth cookie
- A new route added without a JSDoc annotation causes `make docs-check` to fail in CI
- `docs/swagger.json` is committed and matches the live API

**Don't**: Document internal service-to-service endpoints in the public Swagger. Internal routes are excluded.

**Unknown**: Swagger hosting approach — GitHub Pages, inline, or separate docs site. (See CFG-4.)

---

### FMS-66: User Guide, README & Defence Presentation
`track-core` `wave-4` · Est: L · Deps: All feature cards

**Goal**: Produce the written deliverables that a senior project evaluator will read, so the engineering quality evident in the code is equally evident in the documentation.

**Where**: `README.md` · `docs/USER_GUIDE.md` · `docs/DEFENCE_NOTES.md`

**Contents of README.md**:
- Project overview (one paragraph)
- Architecture diagram (system components and their interactions)
- Tech stack with version numbers
- Setup instructions (`git clone` → `make dev` → working in 5 minutes)
- Link to `CONVENTIONS.md`, `api-contract.md`, and `screen-inventory.md`

**Contents of USER_GUIDE.md**:
- One section per user role (Admin, Dispatcher, Driver, Technician, Finance Clerk)
- Step-by-step for each role's primary workflow with screenshots
- "Troubleshooting" section covering the 5 most common user errors

**Contents of DEFENCE_NOTES.md**:
- The Golden Path demo script (mirrors FMS-63 E2E test, but narrated for a non-technical audience)
- Answers to the 10 most likely evaluator questions about design decisions
- Performance budget results from FMS-61 load tests

**Done when**:
- A new developer can run the system from README.md alone without asking any questions
- USER_GUIDE.md has a dedicated section for each of the 8 user roles
- DEFENCE_NOTES.md includes actual load test numbers from FMS-61
- All three documents pass a markdown linter

**Don't**: Include code snippets in the User Guide. Screenshots only. Code belongs in the README and `api-contract.md`.

**Unknown**: None.

---

*End of FMS Engineering Board Specification — 73 feature cards + 5 reference cards = 78 total*
