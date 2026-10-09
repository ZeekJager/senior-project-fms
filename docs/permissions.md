# Role and permission matrix

Generated from the role grants seeded in `packages/backend/migrations/001_core_identity.sql`. Do not edit by hand: run
`npm run -s permissions:doc -w fms-backend > docs/permissions.md` after changing a grant. A test fails when this file is stale.

51 permissions, 9 roles. `x` means the role holds the permission.

| Permission | admin | fleet_manager | dispatcher | depot_admin | technician | driver | finance_clerk | compliance_officer | fleet_owner |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `alert:ack` | x | x | x | x |  |  |  |  |  |
| `alert:read` | x | x | x | x | x |  |  | x | x |
| `alert:resolve` | x | x | x |  |  |  |  |  |  |
| `analytics:read` | x | x | x |  |  |  | x | x | x |
| `assignment:read` | x | x | x | x |  |  |  | x |  |
| `assignment:write` | x | x | x | x |  |  |  |  |  |
| `attendance:read` | x | x | x | x |  | x |  | x |  |
| `attendance:write` | x | x |  | x |  | x |  |  |  |
| `audit:read` | x | x |  |  |  |  |  | x | x |
| `command:read` | x | x | x | x |  |  |  |  | x |
| `depot:read` | x | x | x | x | x |  |  | x | x |
| `depot:write` | x |  |  |  |  |  |  |  | x |
| `document:delete` | x | x |  |  |  |  |  |  |  |
| `document:read` | x | x | x | x | x | x |  | x |  |
| `document:write` | x | x |  | x | x | x |  |  |  |
| `driver:delete` | x | x |  | x |  |  |  |  |  |
| `driver:read` | x | x | x | x |  |  |  | x | x |
| `driver:write` | x | x |  | x |  |  |  |  |  |
| `dvir:read` | x | x |  | x | x | x |  | x |  |
| `dvir:write` | x | x |  | x | x | x |  |  |  |
| `ev:read` | x | x |  | x |  |  |  |  | x |
| `ev:write` | x | x |  | x |  |  |  |  |  |
| `fuel-anomaly:read` | x | x |  | x |  |  | x | x |  |
| `fuel-anomaly:write` | x | x |  |  |  |  | x |  |  |
| `fuel:read` | x | x |  | x |  | x | x | x | x |
| `fuel:write` | x | x |  | x |  | x | x |  |  |
| `incident:read` | x | x | x | x | x | x |  | x |  |
| `incident:write` | x | x |  | x | x | x |  |  |  |
| `integration:execute` | x | x |  |  |  |  |  |  |  |
| `integration:read` | x | x |  |  |  |  |  |  |  |
| `inventory:read` | x | x |  | x | x |  |  |  |  |
| `inventory:write` | x | x |  | x | x |  |  |  |  |
| `maintenance:execute` | x | x |  |  | x |  |  |  |  |
| `maintenance:read` | x | x |  | x | x |  |  | x | x |
| `maintenance:write` | x | x |  | x | x |  |  |  |  |
| `notification:read` | x | x | x | x | x | x | x | x | x |
| `prediction:read` | x | x |  | x | x |  |  | x | x |
| `roles:read` | x | x |  |  |  |  |  | x |  |
| `route:read` | x | x | x | x |  | x |  | x | x |
| `route:write` | x | x | x | x |  |  |  |  |  |
| `tracking:ingest` | x |  |  |  |  |  |  |  |  |
| `tracking:read` | x | x | x | x |  |  |  | x | x |
| `trip:assign` | x | x | x |  |  |  |  |  |  |
| `trip:execute` | x | x | x |  |  | x |  |  |  |
| `trip:read` | x | x | x | x |  | x |  | x | x |
| `trip:write` | x | x | x |  |  |  |  |  |  |
| `users:read` | x | x |  |  |  |  |  | x |  |
| `users:write` | x |  |  |  |  |  |  |  |  |
| `vehicle:delete` | x | x |  | x |  |  |  |  |  |
| `vehicle:read` | x | x | x | x | x | x |  | x | x |
| `vehicle:write` | x | x |  | x |  |  |  |  |  |
