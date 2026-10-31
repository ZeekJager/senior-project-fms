# Preventive service programs and service due (FMS-129)

Card: FMS-129 (SE-173). Code:

- `packages/backend/src/modules/maintenance/`: `domain/service-program.ts` (the rules, as pure functions), `application/service-program.service.ts`, `infrastructure/service-program.repository.ts` and `api/service-program.routes.ts`;
- the vehicles and their meters from fleet: `serviceRefs` (`infrastructure/service-due.queries.ts`);
- the alert rules for `ServiceDue` and `ServiceOverdue` in `packages/backend/src/modules/alert/domain/rules.ts`;
- the screens: Service programs (S-23, `packages/frontend/src/pages/ServicePrograms/`), Service due in the repair log (S-08), the vehicle's history (S-22) and the dispatch console (S-07).

Migration 049. API: api-contract §10.4.

Before this card, a vehicle was serviced when someone remembered. A **service program** now says how often the vehicles it covers are serviced. The fleet sees which vehicles are due or overdue, and the dispatcher sees it before assigning one.

## Programs

A program has a name, the vehicles it covers, its intervals and a checklist.

- **Which vehicles.** A program is fleet-wide (`depot_id: null`) or for one depot. It can also name a vehicle type, a fuel type, a make and a model; each one left out matches any. Make and model are compared without regard to case or surrounding spaces, and a model needs its make. A program covers every vehicle in service (not retired) that matches all it names.
- **Intervals: whichever comes first.** Kilometres (`interval_km`), days (`interval_days`) and engine hours (`interval_engine_hours`). At least one is required; any combination is allowed. The service falls due at whichever measure comes first.
- **Lead windows.** Each interval has a lead window in the same measure (`lead_km`, `lead_days`, `lead_engine_hours`), smaller than the interval. Within the window the service is **due**; past the interval it is **overdue**. A lead window left out is a tenth of its interval, rounded (1,000 km for 10,000 km). When an interval changes, its lead window is kept while it still fits.
- **Checklist.** `tasks`: up to 30 task names (each up to 200 characters, each listed once), shown with the service so the workshop knows what it covers.
- **Names.** One active program of a name per depot, and one fleet-wide (`409 CONFLICT_DUPLICATE` otherwise, compared without regard to case).
- **Retiring.** `is_active: false` retires a program: its vehicles are no longer due under it. It is kept, with the repairs that carried it out, and can be brought back. Programs are never deleted.

**Who.** Reading programs needs `maintenance:read`. Defining and changing them needs `service-program:write`: admin, fleet manager and depot admin. Technicians hold `maintenance:write` to log repairs, not to set the fleet's service policy. A depot admin's programs are their depot's: they see fleet-wide programs but cannot create or change them (`403`, `fleet_wide_not_allowed`). Another depot's program is `404`.

## Service due

For each vehicle and each program covering it, `maintenance.service_due` holds:

- what the count starts from (`since`);
- when each measure falls due (`next_due`);
- the readings it was judged on;
- the status: `upcoming`, `due` or `overdue`.

**What the count starts from.**

- **The last service under the program:** the latest completed preventive repair carrying it out. The starting point is:
  - its completion time;
  - its odometer as entered, or else the highest trusted odometer reading at that time;
  - the engine hours at that time.
- **No service on record:** the vehicle's first odometer reading (FMS-126), or 0 km at registration if it has none. To start the count from a service done before the system knew about it, log that service as a completed preventive repair for the program, with its completion date and odometer.

**The readings.** The vehicle's odometer, which follows its highest trusted reading (meter-readings.md), and its highest engine-hour reading. Engine hours count from 0 at the first device reading. A vehicle with no engine-hour readings (phone-only) is not judged on hours, so its other measures decide.

**The status.** For each measure the program counts:

- **overdue** once the reading reaches the next due point;
- **due** once it is within the lead window;
- **upcoming** otherwise.

Time is measured from the start of the count in whole days of 24 hours. The service is as urgent as its most urgent measure. `due_by` names the measures at that status.

Example: a vehicle at 9,600 km, under a program of 10,000 km with a 500 km lead window and no service on record (first reading 0 km), is **due**: 400 km remain.

**When it is computed.** All on the writer's transaction:

- **The `service-due` job (01:30, after the engine-hours job):** every vehicle in service under every active program, 250 vehicles per transaction. It removes rows that no longer apply: a vehicle retired, moved or re-typed, or a program narrowed.
- **Creating or changing a program:** that program's vehicles.
- **Completing a preventive repair for a program:** that vehicle under that program. Its count starts again from the repair, so it is `upcoming` at once.

Between runs, a vehicle that drives into its lead window shows it after the next run. Every row carries `computed_at`.

## Events and alerts

Moving into `due` or `overdue` from a less urgent status publishes `ServiceDue` or `ServiceOverdue`, once per move. The vehicle's event order is kept (aggregate `vehicle:<id>`).

- Recomputing a status that did not move publishes nothing.
- A vehicle that is serviced and later falls due again publishes again.
- Moving back to `upcoming` (after a service) publishes nothing.

The payload: `vehicle_id`, `depot_id`, `program_id`, `program_name`, `status`, `previous_status` (null for a first computation), `due_by`, `next_due_km`, `next_due_at`, `next_due_engine_hours`, `odometer_km`, `engine_hours`.

**The alert engine** turns both into a `service_due` alert about the vehicle, for technicians and depot admins:

| Event | Severity |
|---|---|
| `ServiceDue` | medium |
| `ServiceOverdue` | high |

They share one source per vehicle and program, with a 31-day window. So a service that falls overdue raises the same alert to high and retitles it ("A-service overdue: AA-1234"), rather than opening a second. The alert says which measures and against what readings.

## Repairs carry out programs

A repair (`POST` and `PATCH /maintenance-records`) takes `service_program_id`. It must be:

- **preventive work:** otherwise `400`, `needs_preventive`;
- **an active program:** otherwise `references_missing_record`;
- **a program covering the vehicle:** otherwise `program_not_applicable`.

The record returns `service_program: {id, name}`. While the repair is open, the vehicle's service due shows it as `open_record`, so a booked service is visible before it is done. Completing it starts the program's count again.

## The dispatch board

`GET /dispatch/availability` gives each vehicle `service_due`: `null`, or its most urgent `status` (`due` or `overdue`) and each program due or overdue with its `due_by`.

It is a warning, never a block. An overdue vehicle can still be assigned, and its availability is unchanged. The console shows an overdue vehicle with a red "Service overdue" warning naming the programs, and a due one with a quieter "Service due".

## API

| Method + path | Permission | |
|---|---|---|
| `GET /service-programs` | `maintenance:read` | Paged, by name. `status` (`active` default, `retired`, `all`), `depot_id` (that depot's programs and the fleet-wide ones). Each with `vehicles`: the caller's vehicles it covers, by status. |
| `POST /service-programs` | `service-program:write` | `ServiceProgramCreate` -> `201 ServiceProgram`. `depot_id` left out: the caller's depot, or fleet-wide for one who sees every depot. |
| `GET /service-programs/{id}` | `maintenance:read` | `ServiceProgram` |
| `PATCH /service-programs/{id}` | `service-program:write` | The fields sent, `is_active` to retire or restore; `If-Match`. |
| `GET /service-due` | `vehicle:read` | Paged `ServiceDue[]`, most urgent first (then the longest at it). `status`: comma-separated, `due,overdue` by default. Also `vehicle_id`, `program_id`, `depot_id`. |
| `GET /vehicles/{id}/service-due` | `vehicle:read` | Every program covering the vehicle, most urgent first. |

`ServiceDue`:

- `vehicle_id`, `registration_number`, `depot_id`;
- `program` (`id`, `name`, `tasks`);
- `status`, `due_by`;
- `last_service` (`maintenance_record_id`, `completed_at`, or null);
- `since`, `next_due` and `readings` (`odometer_km`, `at` and `engine_hours` as each applies);
- `remaining`: km and engine hours from the readings, whole days from now; negative when overdue;
- `open_record`;
- `status_changed_at`, `computed_at`.

## Tests

`test/integration/service-programs.test.ts` covers:

- the card's example (9,600 km on 10,000 km with a 500 km lead window is due);
- due by days and by engine hours; a vehicle without engine-hour readings not judged on them; a program naming a vehicle type;
- `ServiceDue` and `ServiceOverdue` once per move across repeated runs, and the one alert raised to high;
- a repair carrying the program:
  - corrective work and a program that does not cover the vehicle refused;
  - booked work shown;
  - completion starting the count again, and the job agreeing;
- who defines programs (depot admin, fleet-wide, technician, another depot);
- the editor's rules, a duplicate name, a changed interval recomputed, retiring, and a stale `If-Match`;
- the dispatch board's warning, without a block.

`domain/service-program.test.ts` unit-tests whichever-comes-first, once-per-move, matching and the default lead.

The data-scope audit samples a depot B program.
