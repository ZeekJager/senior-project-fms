# The load of a job on each trip (FMS-153)

Each trip records what it carries, and the API works out what the job asks of its driver: its **job load**, `light`, `standard` or `heavy`, with the reasons behind it. Two jobs can now be told apart, for example a 20 km city run and a loaded 400 km haul overnight. The driver fit suggestion (FMS-154) and the trip risk model (FMS-155) build on it.

## Cargo

A trip has two cargo fields (migration 071, `trip.trips`):

| Field | Values | Default |
|---|---|---|
| `cargo_kind` | `general`, `fragile`, `hazardous`, `refrigerated`, `passengers` | `general` |
| `cargo_weight_kg` | above 0, at most 100,000, two decimals | none (`null`) |

- **Optional.** Most trips have no cargo recorded, and a trip without any is `general` with no weight. The driver never enters cargo: the dispatcher does.
- **When it is set.** On `POST /trips` and with `PATCH /trips/{id}`, while the trip is `draft`, `scheduled` or `assigned`. Once the trip is under way, completed or cancelled, a change is `409 CONFLICT_INVALID_STATE_TRANSITION` (`reason: trip_en_route`, `trip_completed` or `trip_cancelled`).
- **Passengers.** For `passengers`, the weight is the passengers' weight, about 75 kg each.
- **Never above the vehicle's payload.** A vehicle can record what it carries: `payload_capacity_kg` on `POST`/`PATCH /vehicles`, in kg. When both are known, the cargo is never more:
  - Changing the cargo of an assigned trip to more than its vehicle carries is `400 VALIDATION_FAILED`, `{ field: "cargo_weight_kg", reason: "over_payload" }`.
  - Assigning a trip to a vehicle that carries less than its cargo is `400 VALIDATION_FAILED`, `{ field: "vehicle_id", reason: "over_payload" }`. An approval of a held assignment (FMS-151) checks it again. It is a safety rule, so it is never held for approval.
  - Exactly the payload is allowed. Nothing is checked against a vehicle with no payload recorded.
- **Audit and events.** Each change is an audited update of the trip and publishes `TripUpdated` with `changed_fields` (`cargo_kind`, `cargo_weight_kg`).

## The job load

The job load is never typed and never stored. Every trip the API returns has `job_load` and `job_load_reasons`, worked out on each read from the trip as it is then. A change of the route, the times, the stops, the cargo or the assigned vehicle shows at once. The rule is one pure function, `jobLoad()` in `packages/backend/src/modules/trip/domain/job-load.ts`. Its thresholds are `JOB_LOAD_RULES` there, and this table follows them.

| Input | Reason | Threshold | Points |
|---|---|---|---|
| Planned distance | `long_haul` | 300 km or more | 2 |
| | `regional` | 100 km or more | 1 |
| Planned driving time: the route's estimate, else the scheduled window | `long_day` | 9 h or more | 2 |
| | `long_hours` | 4 h or more | 1 |
| Stops | `many_stops` | 6 or more | 1 |
| Scheduled hours between 22:00 and 06:00, Addis Ababa time | `night` | 2 h or more | 1 |
| The cargo's share of the assigned vehicle's payload | `near_payload` | 90% or more | 2 |
| | `loaded` | 60% or more | 1 |

- **Rungs.** Each input gives at most one reason: the higher rung when it is met, else the lower one.
- **Level.** The points add up: 0 is **light**, 1 or 2 is **standard**, 3 or more is **heavy**.
- **Order.** `job_load_reasons` lists the biggest first, then in the table's order. It is empty for a light job with nothing to count.
- **Unknown inputs count as nothing.** Without a vehicle, or without a recorded payload, the cargo's share is unknown, so the trip loads from its route and times alone.
- **Examples.** A 20 km city run at 09:00 is light, with no reasons. A 400 km haul from 20:00 to 03:00 with its truck at 96% is heavy: `long_haul`, `near_payload`, `long_hours`, `night` (6 points).
- **The cargo's kind is not an input.** It is recorded so that FMS-154 and FMS-155 can compare like with like.
- **Hazardous cargo.** Whether it needs a licence class the driver record does not hold yet (Ethiopian regulation) is open. If it does, that becomes an eligibility rule (FMS-76), carded separately.

## The console (S-07)

- **The trip list:** each trip shows its job load as a badge (*Light job*, *Standard job*, *Heavy job*).
- **The assignment panel:** the job load, its reasons in words (*Long haul, 300 km or more · Night driving*) and what the trip carries (*7,600 kg · Refrigerated*, or *No cargo recorded*). A trip under way shows the same without the button.
- **New trip:** the drawer asks *What it carries*: the cargo (*General goods* by default) and an optional weight in kg.
- **Change cargo:** opened from the panel by someone with `trip:write`. It sends only what changed, with the version on screen (`If-Match`). A weight above the vehicle's payload is shown on the weight field.
- **Vehicles (S-04):** the vehicle form has an optional *Payload* in kg.

## Seed

- **Payloads.** Every seeded vehicle has its model's payload, from a 400 kg car to a 25 t truck.
- **Cargo.** Buses carry passengers. Trucks and vans carry goods: about a third of the trucks at or near their payload, the rest a lighter share. Cars rarely carry anything, and a trip with no vehicle yet sometimes carries goods.
- **Every load.** The budget profile has more than 50 trips of each load (`scripts/seed/plan.test.ts`).
- **Its own generator.** The cargo is drawn from a generator of its own, so every other seeded row is the same as before.

## Tests

- **`src/modules/trip/domain/job-load.test.ts`:** each threshold, night hours across midnight and several nights, the payload share, and the ordering of reasons.
- **`test/integration/trip-cargo.test.ts`:**
  - a trip without cargo is `general` and loads from its route alone;
  - cargo is recorded on create and changed before the start, audited and published;
  - cargo over the vehicle's payload is refused (400), on a change and on assignment;
  - the job load follows each input;
  - cargo values are checked, and fixed once the trip is under way.
- **`test/integration/vehicles.test.ts`:** the payload capacity.
- **Frontend:** `DispatchPage.test.tsx` (the badge, the panel, the new-trip cargo, *Change cargo*) and `Vehicles/helpers.test.ts` (the payload field).
