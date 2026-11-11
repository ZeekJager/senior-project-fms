# A trip's actual distance (FMS-145)

Card: FMS-145 (SE-189). Closes FR-8, FR-12 and FR-18 of the Requirement Validation Report. Code:

- `packages/backend/src/modules/trip/`: `domain/distance.ts` (the measurement, pure), `application/distance.service.ts`
  (when it runs), `TripService.end`, and `TripRepository`'s candidates;
- the positions in the integration module: `TrackingRepository.tripTrack` and `tripTrackCounts`, exported as
  `trackingLookups` and connected to the trip module in `src/modules/index.ts`;
- `scripts/backfill-trip-distance.ts`.

Migration 066.

Before this card nothing wrote `trip.trips.actual_distance_km`: only the seed did. Every reader of it worked in tests and
demos and read zero on a trip run through the system:

- fuel reconciliation, expected fuel and cost per km ([fuel-reconciliation.md](fuel-reconciliation.md));
- the analytics distance KPI and the vehicles' utilisation ([analytics.md](analytics.md));
- the driver performance and trip history reports ([reports.md](reports.md));
- the predictive model's mileage and fuel-variance inputs ([ml-dataset.md](ml-dataset.md)).

## When a trip is measured

| When | What |
|---|---|
| The trip ends (`POST /trips/{id}/end`, or `/status` with `completed`) | Measured in the same transaction and the same audited update as the end. `TripCompleted` carries `actual_distance_km` and `actual_distance_source` |
| Every hour, the `trip-distance` job | Trips completed in the last 8 days that were never measured, or that have more positions now than they were measured from, measured again. Up to 2,000 trips a run, newest first |
| Once, `npm run backfill:trip-distance -w fms-backend` | Every completed trip with no distance that was never measured: the trips that ended before this card |

**Late positions.** A driver's phone that lost its signal sends the positions it buffered when it reconnects, even after
the trip has ended, and each is stored under the trip it was recorded in (FMS-124). Ingestion accepts positions up to 7
days old ([gps-ingestion.md](gps-ingestion.md)), so the job looks back 8 days. A trip records how many positions it was
measured from (`actual_distance_points`); when the count grows, the job measures it again. One with the same count is
skipped without reading its positions.

**What is never touched.** A distance with no measurement time was entered before trips were measured, by the seed or an
import. Neither the job nor the backfill changes it. Its `actual_distance_source` is null.

## How a trip is measured

The positions are the vehicle's stored pings recorded between the trip's `actual_start` and `actual_end`, stored under
that trip or under none. Pings of another trip, or outside the window, do not count. Up to 100,000 positions are read,
enough for a ping every 2 seconds for over two days.

1. **The vehicle's own odometer**, when its readings bracket the trip. That means readings sent by the vehicle's GPS device
   or telematics provider (not a phone, not a signed-in user: [meter-readings.md](meter-readings.md)), the first within 5
   minutes of the start and the last within 5 minutes of the end. The distance is the difference. Readings that go
   backwards (beyond a 0.1 km rounding step), or imply more than 180 km/h, are not trusted.
2. **Otherwise, the GPS track**: the sum of the steps from one position to the next.
   - **Glitches dropped:** a position that is an impossible jump (over 180 km/h implied) from both its neighbours is left
     out; at either end, from its one neighbour while the next two agree.
   - **Standing still counts nothing:** GPS drifts while a vehicle is parked, so a step whose two ends both report 0 km/h
     is not counted.
   - **Gaps count as the straight line:** a gap with no positions (no signal) counts as the straight line across it, so
     a track with gaps comes out short, never long.
3. **Otherwise, none.** With fewer than two positions the trip has no distance (`no_positions`). It is still recorded as
   measured (`actual_distance_measured_at`, `actual_distance_points = 0`), so the backfill does not try it again; the job
   still does for 8 days, in case positions arrive.

A trip is never given its planned distance as if it had driven it. A trip that never ran its route must not look as if
it did.

The result is rounded to the metre, as the column keeps it (`NUMERIC(12,3)`).

## Data

`trip.trips` (migration 066):

| Column | Meaning |
|---|---|
| `actual_distance_km` | How far the trip went. Null: not measured, nothing to measure from, or never set |
| `actual_distance_source` | `odometer` or `gps`; null with no distance, or with a distance entered before trips were measured |
| `actual_distance_points` | How many positions it was measured from |
| `actual_distance_measured_at` | When it was last measured, a distance found or not; null: never measured |

A source needs a distance (`chk_trip_distance_source`). The count and the time are set together
(`chk_trip_distance_measured`). The API returns `actual_distance_km` and `actual_distance_source` on every `Trip`.

## The backfill

```bash
npm run backfill:trip-distance -w fms-backend
```

It measures in batches of 500, one transaction per trip, and prints its progress and then the counts: by odometer, by
GPS track, and with no positions. It is safe to run again: a trip it measured, with a distance or without, is not
measured again. Positions are kept for the retention period
([driver-data-protection.md](driver-data-protection.md)), so trips older than that have none and stay without a
distance.

The nightly analytics refresh recomputes the last 35 days. Trips the backfill fills before that appear in the KPIs from
the next rebuild of the cache. The reports, fuel reconciliation and the model read the trips directly, so they see the
distance at once.

## Tests

- **Unit** (`src/modules/trip/domain/distance.test.ts`):
  - the track sums its steps; drift while parked counts nothing; a glitch is dropped mid-track and at either end;
  - a gap counts as the straight line; an impossible step counts nothing;
  - the odometer brackets the trip or is not used;
  - a phone's or a user's odometer is not a reading;
  - a meter going backwards, or implying an impossible speed, is not trusted;
  - only positions inside the trip count, in time order;
  - fewer than two positions give no distance, with the reason.
- **Integration** (`test/integration/trip-distance.test.ts`):
  - ending a trip measures it from a phone's track: in the response, `TripCompleted` and the end's single audit row;
  - from the vehicle's own odometer, but not a phone's;
  - only positions of the trip, or of none, inside its window;
  - no positions: no distance, but measured;
  - the driver performance report counts a trip ended through the API;
  - late positions measured in by the job, and a second run changing nothing;
  - the backfill measuring a trip once, and leaving a seeded distance alone.
