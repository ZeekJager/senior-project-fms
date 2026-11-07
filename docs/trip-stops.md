# Trip stops, live state and track replay (FMS-95)

Card FMS-95 (SE-139). FMS-136 (SE-180) gave the GPS history and the trip's track on a map. This card adds:

- a 30-day limit on that history, and an audit of every read;
- stops marked done by the driver, which reach the console as they happen;
- a trip's live state in one read;
- a replay of the track on the map.

Code:

- `packages/backend/src/modules/trip/`:
  - `application/trip.service.ts` (`completeStop`, `live`);
  - `infrastructure/trip.repository.ts` (`lockStop`, `completeStop`);
  - `api/trip.routes.ts`.
- `packages/backend/src/modules/integration/`:
  - `domain/track-history.ts` (`trackWindow`);
  - `application/track-history.service.ts`;
  - `infrastructure/tracking.repository.ts` (`currentPosition`, given to trip in `src/modules/index.ts`).
- Migration 062 (`trip_stops.completed_at`, `completed_by`).
- The driver app's stop list: `packages/frontend/src/pages/Driver/Home.tsx`.
- The replay: `packages/frontend/src/components/TripMap/TripMap.tsx`.

Contract: §7.2 (*Stops and live state*) and §11.1 (*GPS history*). Screens: S-11 and S-22.

## A stop's states

| Status | Set by | Means |
|---|---|---|
| `planned` | the trip's creation, copied from the route | Not reached yet |
| `arrived` | GPS (FMS-86, [eta.md](eta.md)): the vehicle came within 150 m while the trip was under way | The vehicle was there; `actual_arrival` is when |
| `completed` | the driver, or dispatch for them, with `POST /trips/{trip_id}/stops/{stop_id}/complete` | The work there is done; `completed_at` and `completed_by` say when and who |
| `skipped` | (not set by the API yet) | Passed by on purpose |

GPS and the driver need not agree. A stop can be done without the vehicle being seen there: no signal, a stop without coordinates, or one more than 150 m from where the truck parks. It can also be reached and never marked done. Both count:

- **Reached.** A stop is reached when it has an `actual_arrival`. Marking a stop done sets `actual_arrival` to the same moment if GPS had not, so the arrival estimate counts the stop as passed and stops routing to it. `TripStopCompleted.reached_by_gps` tells the two cases apart.
- **GPS after completion.** GPS only ever marks stops with no `actual_arrival` (`markStopsReached`), so a completed stop never goes back to `arrived`.

## Marking a stop done

`POST /trips/{trip_id}/stops/{stop_id}/complete`, with an empty body or `{ "notes": "..." }` (1-500 characters, kept on the stop for dispatch).

- **Who.** `trip:execute`. A driver only on their own trips; staff in their depots. Another driver's trip, another depot's, an unknown stop, or an id that is not a UUID: `404`.
- **When.** Only while the trip is `en_route`. A trip not started, completed or cancelled gives `409 CONFLICT_INVALID_STATE_TRANSITION` (`reason: trip_not_under_way`).
- **Repeat.** A stop already completed answers `200` with the stop as it is and `meta.changed: false`. Nothing is written or published, so a double tap or a retry after a lost answer is harmless. `Idempotency-Key` replays the first answer too.
- **Written.** In one transaction, with the trip and the stop locked:
  - the stop's `status`, `completed_at`, `completed_by`, `actual_arrival` (when unset), `eta` (cleared) and `notes`, audited as an `UPDATE` of `trip.trip_stops`;
  - the event `TripStopCompleted` (`trip_id`, `stop_id`, `sequence_number`, `name`, `depot_id`, `driver_id`, `vehicle_id`, `completed_at`, `reached_by_gps`).

**On the console.** The real-time gateway sends `TripStopCompleted` as `trip.updated` with `change: "TripStopCompleted"` ([realtime.md](realtime.md)). This one is not quiet, unlike `TripEtaUpdated`, so the browser marks stale what shows the trip and re-reads it: the dispatch board, the trip in the command center's driver panel, and the trip lists. The trip module's other subscribers (fleet's trip assignments, the live map and overview caches) receive it with every other trip event. The trip is re-read; nothing about it changed for them.

## Live state

`GET /trips/{trip_id}/live` (`trip:read`, the same scope as `GET /trips/{trip_id}`) answers "where is this trip now" in one read:

- **`position`.** The vehicle's newest position (`tracking.vehicle_current_location`), only while the trip is under way. It is `stale` when more than 2 minutes old: the phone or device has stopped reporting.
- **`next_stop`.** The first stop still `planned`, with its estimate.
- **`stops`.** `total`, `reached` (an `actual_arrival`) and `completed`.
- **`eta`.** The trip's estimate (FMS-86).
- **Also.** `actual_start`, `scheduled_end` and `as_of` (the server's time).

The trip module cannot import the integration module, which imports it, so the position lookup is given to trip in `src/modules/index.ts` (`provideTripPositions`). Without it, `position` is `null`.

## The GPS history's limit and audit

`GET /vehicles/{vehicle_id}/tracking` (FMS-136) reads at most **30 days** per request (`trackWindow`). A month of pings is about 2.6 million rows at one ping a second, so a larger range is asked for in parts.

| `from` | `to` | Window |
|---|---|---|
| none | none | The 30 days to now |
| given | none | `from` to 30 days later, or to now if that is sooner |
| none | given | 30 days before `to`, to `to` |
| given | given | As given: more than 30 days is `400 VALIDATION_INVALID_DATE_RANGE`, `reason: range_too_long`; `to` at or before `from` is the same code, `reason: before_from` |

Each page is still at most 1,000 points, with `meta.next_cursor` to the next. The trip map (S-22) asks for a trip's span, from its start to its end (or now), up to 5 pages.

**Audit.** Where a vehicle was says where its driver was, so every page read is an audit entry:

- action `tracking.history_read` on `fleet.vehicles`;
- who read it, and the correlation id;
- `details`: `vehicle_id`, `from`, `to`, `points` (on the page) and `continued` (whether the page followed a cursor).

## Driver app: the stop list (S-11)

While the trip is under way, the trip card lists its stops in order instead of folding them away:

- **Each stop.** Its number, or a tick once done, and its name. Then what it is: *Done at 09:10*, *You reached it at 09:04* (GPS), *Next stop* or *Ahead*.
- **The next stop.** The first not done is marked (`aria-current="step"`), with the main *Done* button.
- **Done.** Each stop not done has one: a 48 px target, *Saving…* while it is sent. It needs signal, as starting and ending do: the server records the time.
- **After.** The answer updates the trip on screen at once, and today's trips are read again. A refusal says why under the list. A trip no longer under way refreshes the day.

Before the trip starts, the stops stay folded under *N stops on the way*, as before.

## Vehicle page: the track replay (S-22)

The trip panel's map takes each point's time (`times`) and shows a replay bar over the map's top-left corner:

- **Play.** Moves a dot along the track from the start, in at most 200 steps of 100 ms, so about 20 seconds whatever the number of points. *Pause* stops it.
- **The slider.** Puts the dot at any point, with that point's time (Addis Ababa) beside it and as the slider's spoken value.
- **What shows.** The part driven so far is solid, the rest faint. At the end, or with the slider at the last point, the whole track shows again with no dot.

A track with fewer than two points, or without times, has no replay.

## Tests

- **Unit:**
  - `integration/domain/track-history.test.ts`: the window's defaults, 30 days read, 31 refused;
  - the real-time contract (`TripStopCompleted` is `trip.updated`).
- **Integration (`test/integration/trip-stops.test.ts`):**
  - marking done: the row, the audit, the event, GPS's arrival kept, the repeat unchanged;
  - who may, and who gets `404` or `403`;
  - not under way is `409`; a long note or unknown field is `400`;
  - live state: position, stale, next stop, counts; nothing when not under way; another driver's `404`;
  - the history: 31 days refused, 30 read a page at a time, each page audited; the defaults;
  - every answer checked against `docs/openapi.yaml`.
- **Integration, also:** `vehicle-tracking.test.ts` (paging, bounds, scope) and `realtime-scope.test.ts` (the event reaches only its depot).
- **Components:**
  - `Driver/Home.test.tsx`: the list, the next stop, Done, a refusal;
  - `TripMap/TripMap.test.tsx`: the slider, Play and Pause, no replay without times;
  - `RealtimeProvider.test.tsx`: a stop completion re-reads the trips.
