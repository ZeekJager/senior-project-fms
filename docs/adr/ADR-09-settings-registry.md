# ADR-09: A Typed Settings Registry Over the Existing Stores

- **Status:** Accepted
- **Date:** 2026-11-24
- **Card:** FMS-157 (SE-201)

## Context

Settings were two hard-coded sets. FMS-80 made 7 whole numbers in `settings.settings`, each declared in code. The driving rules' 15 thresholds lived in `tracking.rule_thresholds`, one fleet row plus a row per depot that differs. A new parameter meant a migration, code and a deployment. FMS-157 asks for parameters an administrator adds, types and rules for them, enable and disable, history and restore, role-based access, change everywhere within 60 s, and no change in behaviour for the existing ones, whose tests must pass unchanged.

## Decision

- **A registry, `settings.definitions`.** It has one row per parameter: key, label, category, type (10 types), a typed default and rules in jsonb, enabled, system, secret, an optional extra permission, and `version`, bumped by every change, which serves as the ETag. Custom parameters are rows. System parameters are declared in code by the module whose rule they tune and kept in step on start; they are never deleted and their definitions never edited.
- **Values stay where they live.** `settings.settings.value` becomes jsonb, with a `secret_value` the audit trail redacts. The thresholds stay in the fleet's row of `tracking.rule_thresholds`. The integration module registers a *store* through which the registry reads, writes and shows them, and the store keeps the cross-field rules. Each depot's own row still overrides the fleet's, every reader and audit row stays as it was, and disabling a threshold makes every reader answer with its default.
- **One validator in two copies.** `parameter-types.ts` is dependency-free and copied byte for byte into the frontend; a test fails when the copies differ, as `units.ts` already does. A small JSON Schema subset is checked, and any other keyword is refused when the parameter is defined, so nothing is silently ignored.
- **Propagation over the outbox.** Every change publishes a `Setting*` event in its own transaction. The relay puts it on Redis, and each instance drops its cached copy when it arrives, within about a second. The 30-second cache remains the fallback.
- **Concurrency is 412.** A stale `If-Match` on a parameter answers `412 PRECONDITION_FAILED`, as the card asks and RFC 9110 defines, where the older resources answer 409.

## Alternatives

- **Move the thresholds into `settings.settings`**: one store, but each depot's override would need a scope column. The trip risk facts view and every threshold reader would change, and so would the audit rows the FMS-80 tests check.
- **Keep the 7 settings' `value` integer and add a jsonb column for the rest**: no migration of a column type, but it doesn't meet "stored as typed jsonb", and two columns mean two ways to read a value. The one direct SQL write in the tests (the fuel reconciliation's, an integer literal) now passes its value as JSON.
- **A full JSON Schema validator (ajv)** in both packages: complete, but a new runtime dependency in the browser and the API, for a feature that needs a handful of keywords.
- **A new shared workspace package for the validator**: the cleanest sharing, but the development images build each package from its own folder, so every Dockerfile and the CI image builds would change.
- **Redis keyspace notifications, or a dedicated channel**: each needs its own publisher. The outbox already publishes every event on Redis after commit, so a rolled-back change can't announce itself.

## Consequences

- Code reads any parameter with `settings.get(key)`; a custom one exists the moment it is added.
- A system parameter's label, rules and default change only with the code, and the migration's copy must agree (a test brings them in step and expects nothing to change).
- A definition's version moving on when its value changes, and the start-up sync, are the two unaudited writes; both record only what audited writes already do.
- Secrets are masked everywhere but stored in clear in the database; a secret store is later work.
- A second administrator's approval for production changes (the card's open question) isn't built; a reason and the history are.
