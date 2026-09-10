# Fleet Management System (FMS) - MVP Specification

## 1. Project Overview
A web-based Fleet Management System (FMS) designed specifically for Ethiopian transport operators (like SMTSE and ACBSE). The system digitizes operations, maintenance, telemetry, and reporting, replacing paper-based processes and disparate spreadsheets.

## 2. Phase Definitions
- **Wave 0 (Foundation):** Infrastructure, database, authentication, and core UI shared components.
- **Wave 1 (Core Entities):** CRUD operations for Vehicles, Drivers, Depots, Attendance, and Maintenance.
- **Wave 2 (Operations):** Trip assignments, dispatch rules (BR-1, BR-2), offline-first PWA for drivers, DVIR, and fuel logging.
- **Wave 3 (Advanced & AI):** Real-time GPS mapping (Socket.io), speeding/idling telemetry flags, and AI predictive maintenance scoring.
- **Wave 4 (Polish):** Security hardening, optimistic locking, PWA real geolocation, and load/E2E testing.

## 3. Scope
### Explicitly In Scope (MVP)
- Role-based access control (RBAC) with 9 distinct roles.
- Strict data auditing (append-only audit logs for all mutations).
- Trip conflict prevention (0-minute overlap blocking).
- Offline-capable Driver PWA (IndexedDB sync) for DVIR and Fuel logging.
- Real-time GPS vehicle tracking via Command Center Map.
- Automated anomaly detection (fuel variance > 20%, speeding > 80km/h).
- AI-driven predictive maintenance scoring (Random Forest classifier).

### Explicitly Out of Scope
- Native iOS/Android apps (using web PWA instead).
- Hardware GPS integration (using driver smartphones via HTML5 Geolocation).
- Automated SMS/Email notifications (using in-app notifications).
- External accounting system integration (e.g., Peachtree/Quickbooks).
- Direct payroll calculations.
- Public/customer-facing booking portal.

## 4. User Roles & Access
1. **Admin:** Full system access, bypasses depot scoping. Manages global configurations.
2. **Fleet Manager:** High-level operational overview across the entire fleet. Reviews analytics, sets performance thresholds.
3. **Dispatcher:** Scoped to specific depots. Assigns vehicles/drivers to trips. Uses the live Fleet Command Center map.
4. **Driver:** Uses the mobile PWA only. Logs DVIR, fuel, incidents, and updates trip status.
5. **Maintenance Technician:** Receives flagged vehicles, logs repairs, clears maintenance flags, consumes inventory.
6. **Depot Admin:** Manages depot-level drivers, vehicles, and spare parts inventory. Tracks attendance.
7. **Finance/Fuel Clerk:** Reviews fuel logs, manages fuel reconciliation, exports cost data.
8. **Compliance Officer:** Reviews audit logs, speeding/idling violations, and document expirations.
9. **Fleet Owner:** Executive dashboard access. Read-only view of analytics, health scores, and audit trails.
