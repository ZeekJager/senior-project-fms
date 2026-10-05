# Fleet Management System - Complete PostgreSQL Migration Set

This directory is the **replacement PostgreSQL baseline** for the Fleet Management System database architecture.

## Architecture mapping

| Migration | PostgreSQL schema(s) | Architectural responsibility |
|---|---|---|
| 001 | `shared`, `auth` | Shared types, identity, JWT session support, RBAC |
| 002 | `fleet` | Depots, vehicles, drivers, assignments, attendance, DVIR |
| 003 | `trip` | Routes, trips, stops |
| 004 | `fuel` | Fuel logs and fuel anomalies |
| 005 | `maintenance` | Maintenance, inventory, inventory movements, ML predictions |
| 006 | `integration` | GPS devices, external providers, synchronization, fuel-card integration |
| 007 | `tracking` | Current location, historical GPS pings, telemetry flags |
| 008 | `alert` | Alerts, acknowledgement, notifications, incidents |
| 009 | `ev` | Battery telemetry, charging stations, charging sessions |
| 010 | `audit` | Append-only audit logging |
| 011 | `analytics` | Performance indexes and reporting/read views |
| 012 | (grants) | Runtime privileges for the `fms_app` role; audit table stays INSERT/SELECT only |

## Important

This set is designed for a **new PostgreSQL database** and intentionally supersedes the earlier `public.*` implementation and the MySQL `schema-fms.sql` file.

The bundle in `bundle/fms_install_all.sql` is the concatenated Up sections for a one-shot install; regenerate it whenever a migration changes.

Do **not** run these migrations on top of the old `public.*` tables without first performing a data migration.

## Database technology

- PostgreSQL
- Transactional system of record: PostgreSQL
- Cache / Pub/Sub: Redis (outside this SQL migration set)
- Read scaling: PostgreSQL streaming/read replica (deployment concern, outside this SQL migration set)
- ORM: Prisma or Sequelize

## Module boundaries

The PostgreSQL schemas are aligned with the modular-monolith boundaries:

```text
shared.*
  └── common database primitives

auth.*
  └── identity / RBAC

fleet.*
  └── driver / vehicle / depot operations

trip.*
  └── routes / trips / stops

fuel.*
  └── fuel records / anomalies

maintenance.*
  └── maintenance / parts / predictive maintenance

integration.*
  └── external adapters / telemetry device registry

tracking.*
  └── GPS / current location / telemetry flags

alert.*
  └── alerts / notifications / incidents

ev.*
  └── EV battery / charging

audit.*
  └── immutable audit history

analytics.*
  └── reporting projections / read views
```

## Notes on application ownership

A shared PostgreSQL deployment does not mean modules should query each other's tables arbitrarily. The Node.js modular monolith should enforce module ownership at repository/service boundaries.

Examples:

- Trip logic uses the Trip repository and a defined Vehicle/Driver application interface rather than issuing arbitrary SQL against `fleet.*` tables.
- Alert logic may reference source events from other modules using `source_module`, `source_event_type`, and `source_record_id`, because that is a polymorphic reference and cannot be represented by one normal foreign key.
- Predictive maintenance is calculated by the separate Python/FastAPI service; prediction results are persisted in `maintenance.maintenance_predictions` by the core application.

## High-volume tracking

`tracking.gps_pings` is range-partitioned by `recorded_at` and currently has a `DEFAULT` partition. When data volume warrants it, monthly partitions can be added and data moved out of the default partition.

## Backup / recovery

The database architecture expects:

- nightly full backups
- continuous WAL archiving
- encrypted backup storage
- tested restore procedures
- a PostgreSQL read replica for analytics/read-heavy workloads

Exact RPO/RTO values should come from the final SRS.

## Migration runner

The files use the same `-- +migrate Up` / `-- +migrate Down` markers as the previous migration set. Run them in numeric order.
