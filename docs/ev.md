# EV fleet management (FMS-96)

Card FMS-96 (SE-140), architecture §13 (EV Fleet Management Module) and §27 (external charging hardware). Electric
vehicles are managed like the rest of the fleet: their battery state, their charging sessions and the charging
stations. Code in `packages/backend/src/modules/ev/`; tables in the `ev` schema (migration 009). The data comes from
the synthetic generator and the simulated charging provider (FMS-97, decision D-06); the screens are FMS-99.

## Who

`ev:read`: administrators, fleet managers, depot admins and fleet owners. `ev:write`: the first three
([permissions.md](permissions.md)). Battery logs and sessions are a vehicle's: the caller sees and changes those of
vehicles in their depots. Stations are shared by every depot.

## The API

| Call | Needs | Does |
|---|---|---|
| `POST /ev/battery-logs` | `ev:write` | A battery observation: state of charge (%), and optionally health (%), temperature, voltage, current, estimated range |
| `GET /ev/battery-logs` | `ev:read` | The caller's vehicles' observations, or one vehicle's (`vehicle_id`), between `from` and `to`, newest first |
| `GET /ev/charging-stations` | `ev:read` | The stations, by name, with location, connector and power |
| `POST /ev/charging-sessions` | `ev:write` | A session, `planned` or started now (`in_progress`), at a station or not |
| `PATCH /ev/charging-sessions/{id}` | `ev:write` | Its figures (energy, cost, state of charge at start and end, times, station) and its status |
| `GET /vehicles/{id}/charging-sessions` | `ev:read` | A vehicle's sessions, newest first |
| `GET /vehicles/{id}/battery-summary` | `ev:read` | The latest state, the state-of-charge trend and the health (below) |

**Only electric vehicles** (`fuel_type: electric`) take battery logs or charging sessions, or have a battery summary:
any other is `400`, `not_electric`. A retired vehicle takes neither (`409`, `vehicle_retired`). Money is whole cents.

## A charging session's states

```text
planned ──► in_progress ──► completed
   │              └───────► failed
   └──► cancelled
```

- Any other move, and any change to a completed, failed or cancelled session, is
  `409 CONFLICT_INVALID_STATE_TRANSITION`; its detail lists `allowed_transitions`, which every session also returns.
- Starting sets `started_at` (now, unless given); completing or failing sets `ended_at`. An end before the start is
  `400 VALIDATION_INVALID_DATE_RANGE`.
- A vehicle charges in one session at a time: starting a second is `409 CONFLICT_VEHICLE_IN_USE`, `already_charging`,
  with the session in the way as `record_id`.
- A provider's own session id (`external_session_id`) is unique (`409 CONFLICT_DUPLICATE`).

## The battery summary

`GET /vehicles/{id}/battery-summary?days=30` (1 to 365):

- `latest`: the newest observation (state of charge, health, range, when), or `null`;
- `soc_trend`: one point per Addis Ababa day with observations, oldest first: average, minimum, maximum and how many;
- `health`: the battery's state of health now, at the start of the period, and the `change` between them (a negative
  change is wear);
- `charging`: the sessions completed in the period, the energy they took and what they cost.

## Audit and events

Every write is one audited change. Events, ordered on the vehicle:

| Event | When | Payload |
|---|---|---|
| `BatteryLogged` | A battery observation is recorded | `battery_log_id`, `vehicle_id`, `state_of_charge`, `battery_health`, `estimated_range_km`, `recorded_at` |
| `ChargingSessionStarted` | A session starts | the session: `charging_session_id`, `vehicle_id`, `station_id`, `status`, times, energy, cost, states of charge |
| `ChargingSessionCompleted` | It completes | the same |
| `ChargingSessionFailed` | It fails | the same |
