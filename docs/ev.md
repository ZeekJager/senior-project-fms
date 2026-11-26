# EV fleet management (FMS-96)

Card FMS-96 (SE-140), architecture §13 (EV Fleet Management Module) and §27 (external charging hardware). Electric
vehicles are managed like the rest of the fleet: their battery state, their charging sessions and the charging
stations. Code in `packages/backend/src/modules/ev/`; tables in the `ev` schema (migration 009). The data comes from
the synthetic generator and the simulated charging provider ([below](#synthetic-data), FMS-97, decision D-06); the
screens are FMS-99.

## Who

`ev:read`: administrators, fleet managers, depot admins and fleet owners. `ev:write`: the first three
([permissions.md](permissions.md)). Battery logs and sessions are a vehicle's: the caller sees and changes those of
vehicles in their depots. Stations are shared by every depot.

## The API

| Call | Needs | Does |
|---|---|---|
| `POST /ev/battery-logs` | `ev:write` | A battery observation: state of charge (%), and optionally health (%), temperature, voltage, current, estimated range, energy used per km since the previous reading |
| `GET /ev/battery-logs` | `ev:read` | The caller's vehicles' observations, or one vehicle's (`vehicle_id`), between `from` and `to`, newest first |
| `GET /ev/charging-stations` | `ev:read` | The stations, by name, with location, connector and power |
| `POST /ev/charging-sessions` | `ev:write` | A session, `planned` or started now (`in_progress`), at a station or not |
| `PATCH /ev/charging-sessions/{id}` | `ev:write` | Its figures (energy, cost, state of charge at start and end, times, station) and its status |
| `GET /vehicles/{id}/charging-sessions` | `ev:read` | A vehicle's sessions, newest first |
| `GET /ev/fleet` | `ev:read` | The electric vehicles in service, or one depot's (`depot_id`), lowest charge first, each with its newest reading and the session charging it now ([the EV dashboard](#the-ev-dashboard), FMS-99) |
| `GET /ev/charging-sessions` | `ev:read` | The fleet's sessions newest first, by `status`, `vehicle_id` and start (`from`, `to`) (FMS-99) |
| `GET /vehicles/{id}/battery-summary` | `ev:read` | The latest state, the state-of-charge trend and the health (below) |

**Only electric vehicles** (`fuel_type: electric`) take battery logs or charging sessions, or have a battery summary:
any other is `400`, `not_electric`. A retired vehicle takes neither (`409`, `vehicle_retired`). Money is whole cents.

**Every record says where it came from** (`source`, migration 084): `manual` (typed in, the default), `provider` (a
charging provider's webhook) or `synthetic` (fabricated, [below](#synthetic-data)). A caller may send `source:
synthetic` on a battery log or a session; `provider` is the webhook's alone (`400`). The screens show a "Synthetic
data" badge on synthetic records (FMS-99).

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
| `BatteryLogged` | A battery observation is recorded | `battery_log_id`, `vehicle_id`, `state_of_charge`, `battery_health`, `estimated_range_km`, `source`, `recorded_at` |
| `ChargingSessionStarted` | A session starts | the session: `charging_session_id`, `vehicle_id`, `station_id`, `status`, times, energy, cost, states of charge, `source` |
| `ChargingSessionCompleted` | It completes | the same |
| `ChargingSessionFailed` | It fails | the same |

A provider's session event has no actor, and its event id is fixed by the session and the status it reached, so it
is published once however often the provider reports it.

## Synthetic data

Card FMS-97 (SE-141), decision D-06: there is no real EV data source, so the EV module is built, tested and shown on
fabricated data, and every fabricated record is marked `synthetic`.

### The generator

```bash
docker exec fms_backend npm run seed -- --with-ev --reset             # the small profile and 90 days of EV data
docker exec fms_backend npm run seed -- --size=budget --with-ev --reset
```

`--with-ev` adds, after the rest of the seed ([seed-data.md](seed-data.md)), 90 days of data for each seeded electric
vehicle, ending at the anchor. `scripts/seed/ev.ts` plans it as plain data with its own seeded generator, so the same
seed and anchor give the same data (the seed's fingerprint covers it), and the rest of the seed is unchanged by it.

- **Stations.** The simulated network's eight stations around Addis Ababa (`SIM-ST-01` to `SIM-ST-08`, in
  `scripts/simulator/ev-charging.ts`): CCS2, Type 2 and GB/T, 22 to 150 kW, each with its tariff. There is no station
  API, so they are inserted with `auditedMutation`, as the simulated provider's.
- **Profiles.** Each EV model of the seed catalogue has a usable capacity (kWh), a consumption (Wh/km), the most it
  takes from a charger (kW), its pack voltage and its daily duty:

  | Model | kWh | Wh/km | kW | km a day |
  |---|---|---|---|---|
  | BYD e6 | 71.7 | 180 | 60 | 90–190 |
  | BYD T3 | 50.3 | 205 | 40 | 70–150 |
  | Volkswagen ID.4 | 77 | 175 | 125 | 80–170 |
  | Yutong E12 | 350 | 1,000 | 150 | 100–170 |

- **Readings.** Three a day (06:00, 12:00 and 17:00, Addis Ababa): state of charge, battery health, temperature,
  voltage, current, estimated range and the energy used per km since the previous reading (none at 06:00, after the
  night's charge). Sundays are light days. A worn battery uses a little more per km.
- **Sessions.** In the evening when the charge is low, or would not cover the next day's longest duty, mostly at the
  vehicle's home station, until 90–100% (80–90% on a fast charger). Energy, duration and cost follow from the profile
  and the station. A heavy vehicle only charges at 60 kW or more. A failed session stops after a few minutes, and the
  vehicle tries another station 15 to 30 minutes later.
- **Scenarios.** The first four EVs take one each, so every profile has them all; the rest are mostly normal:

  | Scenario | What it shows |
  |---|---|
  | `fast_degradation` | Battery health falls about ten points over the 90 days (about one normally) |
  | `low_charge` | Driven hard and charged late: below 15% again and again |
  | `unreliable_charging` | Three evenings in ten the session fails, then succeeds elsewhere |
  | `normal` | About 3% of sessions fail |

The readings and sessions go **through the EV API** (`POST /ev/battery-logs`, then `POST /ev/charging-sessions` and
`PATCH` to complete or fail it), with `source: synthetic`, so validation, audit and events apply. Like the rest of the
seed, it refuses `NODE_ENV=production`.

### The simulated charging provider

The integration gateway's provider `simulated` (type `ev_charging`, migration 084) is a charging network that does
not exist. Its adapter is the FMS EV charging adapter (`fms-ev-charging.adapter.ts`), the one any real network without
its own adapter also gets, so a real network replaces the simulator without a change to this module
([integrations.md](integrations.md)). Its webhooks are signed like a real provider's, with
`INTEGRATION_SIMULATED_WEBHOOK_SECRET` (`make env` generates it; leave it out of production, where the URL then
answers `404`). It is added switched off.

```bash
docker exec fms_backend npm run simulate:ev                                # a session every 5 s for 60 s
docker exec fms_backend npm run simulate:ev -- --rate 30 --duration 0      # until Ctrl+C
docker exec fms_backend npm run simulate:ev -- --duplicates 0.2 --replays 0.1 --failures 0.25 --charge 30
```

`scripts/simulate-ev.ts` switches the provider on, adds its stations if the seed has not, and plugs free electric
vehicles in: a `session_started` delivery, then after `--charge` seconds `session_completed` or `session_failed`.
Like a real provider it is not perfect: `--duplicates` of the deliveries are sent twice with the same event id,
`--replays` again under a new one, and a delivery the API does not take (a network error, `429`, `5xx`) is retried
three times with backoff. It ends by checking that every session it reported is stored once, as synthetic.

### The charging webhook

`POST /api/v1/webhooks/ev/{code}`, signed and checked as every webhook is ([integrations.md](integrations.md#webhooks)).
The FMS EV charging format is one session event a delivery, with the whole session as the provider sees it:

```json
{ "event_id": "sim-6f1c…", "type": "session_completed", "occurred_at": "2026-11-26T18:40:00+03:00",
  "session": { "session_id": "sim-s-91d2…", "vehicle_id": "<the vehicle's FMS id>", "station_id": "SIM-ST-03",
               "started_at": "2026-11-26T17:30:00+03:00", "ended_at": "2026-11-26T18:40:00+03:00",
               "energy_kwh": 41.2, "cost_cents": 39140, "start_soc": 18, "end_soc": 80 } }
```

`type` is `session_started`, `session_completed` or `session_failed`. The gateway answers `202` once the delivery is
stored; this module's consumer (`ev.charging-webhooks`) then applies it on the event's transaction, as the system:

- **By the provider's session id** (`external_session_id`): the first delivery creates the session, at the provider's
  station when it knows it (`external_station_id`; otherwise none), as `synthetic` from the simulated network and
  `provider` from any other.
- **Only forward.** A later delivery moves it on (`in_progress`, then `completed` or `failed`) with its figures. A
  redelivery (the same event id: the gateway answers `duplicate: true`), a replay under a new id, or a start that
  arrives after the end changes nothing; a replay may only fill in figures still empty. The end arriving first creates
  the session already ended.
- **Never twice.** An advisory lock on the session id makes two deliveries of a new session (its start and end
  together) take turns, and the column is unique.
- **Skipped**, and logged as `ev.provider_session_skipped` with the reason: a vehicle that does not exist
  (`vehicle_unknown`), is not electric, or is retired, for a new session.

The relay delivers within 200 ms when idle ([events.md](events.md)), so a reported session is on the vehicle's
sessions, and the EV dashboard, within a second or two of the provider's delivery.

## The EV dashboard

Card FMS-99 (SE-143), screen S-40 at `/ev` (*EV fleet* in the menu), for everyone with `ev:read`: administrators,
fleet managers, depot admins and fleet owners.

- **The list,** lowest charge first (`GET /ev/fleet`): plate, make and model, depot, the charge as a bar, the
  battery's health, and what it is doing now: *Charging*, *Low* (below 20%, amber) or *Critical* (below 10%, red),
  else *Ready*. Vehicles with no reading come last; a reading over a day old is amber. The figures above it count
  the EVs, those charging now, those low and those with no reading.
- **Charging now:** each session under way, longest first, with its station, the charge it started at and how long
  it has charged.
- **Charging stations:** the network on the map (`StationLayer` on `FleetMap`): filled where an EV charges now,
  dashed out of service, the name, power and connector on hover. With `tracking:read` the EVs' positions are on it
  too. The live map (S-16) draws the stations for those with `ev:read`.
- **Session history** (`GET /ev/charging-sessions`): every session newest first, filtered to *Charging*,
  *Completed* or *Failed*, with station, start, charge, energy and cost.
- **Live.** The socket's `ev.charging-session.updated` and `ev.battery.logged` ([realtime.md](realtime.md)) make the
  screen read the list and the sessions again; without the socket it reads them every 30 seconds.
- **Synthetic data.** Every synthetic reading and session carries the *Synthetic data* badge, and the title once
  when any of them is ([below](#synthetic-data)).
- **The low line** is 20%, the default of the battery alert's `ev_low_soc_pct` (FMS-98).
