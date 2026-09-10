# FMS Engineering Board Specification (Deel Methodology)

This document defines the absolute source of truth for how the Fleet Management System (FMS) engineering team operates. It enforces the strict, production-level conventions extracted from the Deel methodology.

---

## 1. The Workflow (Jira Columns)
Cards flow strictly left to right. No bypassing columns.
*   **Reference**: Not for tasks. Holds the master documentation cards (Specs, Budgets, Unknowns).
*   **Backlog**: Triage area. Cards lack full definitions or are blocked by business decisions.
*   **Ready**: Card is fully scoped (Goal, Where, Done when, Don't) and has no external blockers.
*   **In progress**: Developer actively writing code.
*   **In review**: PR is open, passing CI, and awaiting peer review.
*   **Blocked**: A technical or external blocker stops work. Requires a comment explaining *why*.
*   **Done**: Merged to `main` and satisfies the Universal Definition of Done.

---

## 2. The "Reference" Pillar

Do not copy-paste API payloads or database schemas into Jira cards. Cards reference these master documents by name (e.g., `schema-fms.sql table trips`, `api-contract.md A.3.1`).

1.  **`fms-mvp-spec.md`** — Scope, what is explicitly out, phase definitions.
2.  **`schema-fms.sql`** — The single source of truth for the entire MySQL database.
3.  **`api-contract.md`** — Every REST endpoint, JSON payload shape, and standardized error code.
4.  **`screen-inventory.md`** — List of every UI view and its 5 required states (Loading, Empty, Error, Success, Skeleton).

---

## 3. Universal "Definition of Done"
This applies to *every single card*. It is never repeated on individual cards.

1.  **Tests pass**, including the exact edge case the card was written to prevent.
2.  **Migrations are reversible**; tested `down` then `up` locally.
3.  **No `float64` anywhere in fuel or money paths**. Use integers (e.g., store ETB in cents, fuel in milliliters).
4.  **Audit entry written** for every mutation (`created_by`, `updated_by` and audit log insertion).
5.  **Soft Deletes strictly enforced**. `DELETE` statements are forbidden on core entities; use `is_active = false`.
6.  **Error codes** perfectly match `api-contract.md`.
7.  **Code reviewed** and merged.

---

## 4. Performance Budgets & Default Thresholds

**Performance Budgets**
| Operation | Budget |
| :--- | :--- |
| Dashboard first paint | Under 2.0 seconds |
| API writes (e.g., fuel log) | p95 under 50ms |
| Socket.io GPS update latency | Under 500ms from client broadcast |
| Fuel vs. Mileage Reconciliation Batch | Under 2 minutes for 500 vehicles |
| Predictive AI model inference | Under 200ms per vehicle request |
| Full PR CI Pipeline | Under 8 minutes |

**Default Thresholds (Configurable later)**
| Setting | Default | Card |
| :--- | :--- | :--- |
| Telemetry Speeding Flag | > 80 km/h for 30 consecutive seconds | FMS-42 |
| Telemetry Idling Flag | > 5 minutes with engine on, 0 speed | FMS-43 |
| AI Maintenance Risk Alert | Health Score drops below 75/100 | FMS-50 |
| Auto-logout (Inactive Session) | 30 minutes | FMS-06 |

---

## 5. Engineering Tracks (Jira Components)
Ownership is divided into tracks. One developer owns a track end-to-end (DB, API, UI, Tests).
*   `track-core`: Auth, RBAC, Users, Depots, Audit Logs.
*   `track-dispatch`: Trips, Routes, Vehicle/Driver Assignments.
*   `track-maintenance`: Repairs, DVIRs, Inventory, Predictive AI.
*   `track-telemetry`: GPS Socket.io, Maps, Fuel reconciliation.

---

## 6. Card Anatomy & Exemplar Backlog

Below are examples of how FMS features are broken down using the strict Deel card methodology. 

### FMS-10: Soft Delete & Audit Middleware
`` `track-core` `wave-0` · Est: M · Deps: None ``

**Goal**: Ensure no historical data is ever destroyed, and every change is attributable to a specific user to prevent fuel/inventory fraud.
**Where**: Global Express middleware, `AuditLogs` table.
**Layout / Behaviour**: 
*   Intercept all `PUT`/`PATCH`/`DELETE` requests.
*   Convert `DELETE` to `UPDATE is_active = false`.
*   Write JSON diff of `old_state` and `new_state` to `AuditLogs` asynchronously.
**Done when**:
*   A `DELETE` request on `/api/vehicles/1` leaves the vehicle in DB but marks it inactive.
*   The audit log records the exact User ID who made the request and the timestamp.
*   A direct DB `DELETE` triggers a strict linter warning.
**Don't**: Build a UI for the audit log yet (that is FMS-11).
**Unknown**: Do we purge audit logs after 5 years, or keep them forever? (Who answers: Compliance Officer).

---

### FMS-24: Assign Driver to Trip (Conflict Engine)
`` `track-dispatch` `wave-2` · Est: L · Deps: FMS-12, FMS-15 ``

**Goal**: Prevent dispatchers from creating physical impossibilities (overlapping schedules or unsafe vehicles).
**Where**: `POST /api/trips/{id}/assign`, screen `Dispatch Console (C4)`.
**Layout / Behaviour**: 
*   When dispatcher selects a driver, query active trips.
*   When dispatcher selects a vehicle, query maintenance flags.
**Done when**:
*   Assigning a driver who has an active, non-completed trip returns `409 Conflict` (BR-1).
*   Assigning a vehicle with `maintenance_flag = true` returns `409 Conflict` (BR-2).
*   Successful assignment updates trip status to `assigned` and emits socket event `trip_assigned`.
**Don't**: Build an auto-assignment "smart" algorithm. Dispatch is manual only.
**Unknown**: Does the driver get notified via SMS the millisecond the assignment is saved, or later? (Who answers: Fleet Manager).

---

### FMS-38: Offline-First DVIR Submission
`` `track-maintenance` `wave-2` · Est: XL · Deps: FMS-30 ``

**Goal**: Drivers in remote areas without internet must still be able to complete their Daily Vehicle Inspection Reports.
**Where**: Driver Mobile PWA, `IndexedDB`, Service Worker.
**Layout / Behaviour**: 
*   If `navigator.onLine` is false, save the DVIR JSON payload to IndexedDB.
*   UI shows a yellow "Sync Pending" badge.
*   Service worker listens for `online` event and flushes the IndexedDB queue to `POST /api/dvir`.
**Done when**:
*   Driver can open the app in airplane mode and submit a form.
*   The form successfully hits the backend once airplane mode is turned off.
*   If the token expires while offline, the sync gracefully pauses, prompts for login, then resumes.
**Don't**: Try to cache the entire vehicle history offline. Only cache the submission queue.

---

### FMS-45: HTML5 Live Geolocation Broadcaster
`` `track-telemetry` `wave-3` · Est: M · Deps: FMS-44 ``

**Goal**: Prove the real-time map works without buying $500 OBD-II hardware by using the driver's smartphone GPS.
**Where**: Driver Mobile PWA, `navigator.geolocation`, Socket.io client.
**Layout / Behaviour**: 
*   When a trip is marked `En Route`, request continuous location permissions.
*   Emit `location_update` via WebSockets every 10 seconds containing `[lat, lng, speed, bearing]`.
**Done when**:
*   Browser prompts for location permission and handles denial gracefully.
*   Socket emits exactly every 10 seconds (no spamming the server).
*   If speed > 80km/h, the backend catches the socket event and increments the speeding counter.
**Don't**: Keep broadcasting after the trip is marked `Completed` (battery drain risk).
**Unknown**: What accuracy threshold (in meters) should we require before rejecting a GPS ping as noise? (Who answers: Tech Lead).

---

### FMS-51: AI Predictive Maintenance Threshold Engine
`` `track-maintenance` `wave-3` · Est: L · Deps: FMS-50 ``

**Goal**: Turn the raw 0-100 score from the Python AI model into actionable Jira-style alerts for the technicians.
**Where**: Node.js Cron Job, Python ML Service API.
**Layout / Behaviour**: 
*   Run a nightly batch job at 02:00 AM.
*   Send the last 30 days of telemetry (mileage, engine hours) to the Python service for every active vehicle.
*   If Python returns a score < `75`, trigger a `Predictive Maintenance Alert`.
**Done when**:
*   Batch job successfully processes 500 vehicles in under 2 minutes (Performance Budget).
*   Vehicles scoring 74 generate an alert routed to the Maintenance Technician queue.
*   Vehicles scoring 76 do nothing.
**Don't**: Over-complicate the Python model yet. Stick to a simple scikit-learn regression based on synthetic mileage/fault data to prove the pipeline works.
