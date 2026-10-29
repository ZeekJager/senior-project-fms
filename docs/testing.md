# Testing

Both apps use [Vitest](https://vitest.dev). `npm test` at the repo root runs every workspace's tests; CI runs the same tests with coverage (see [ci.md](ci.md)).

| Command | What it runs |
|---|---|
| `npm test` | Everything, in both apps |
| `npm test -w fms-backend` | Backend unit + integration tests |
| `npm run test:unit -w fms-backend` | Backend unit tests only (no database needed) |
| `npm run test:integration -w fms-backend` | Backend integration tests only |
| `npm test -w fms-frontend` | Frontend component tests |
| `npm run test:watch -w <app>` | Watch mode while you work |
| `npm run test:coverage -w <app>` | Coverage report in `packages/<app>/coverage/index.html` |

## Backend

### Where tests go

- **Unit tests** sit next to the code as `src/**/*.test.ts`. They must not touch the database.
- **Integration tests** go in `test/integration/*.test.ts`. They run against a real PostgreSQL through the real app (use `supertest` with `createApp()` for HTTP).

### The test database

Integration tests never use your development database. On every run, the global setup:

1. drops and recreates **`fms_test`** (any name ending in `_test` via `TEST_DB_NAME`; other names are refused),
2. applies every migration with the same code `make migrate` uses,
3. after the run, fails if any table has more rows than right after migrating.

Settings come from your environment, or from the repo-root `.env` that `make env` creates, with host defaults for a running `make dev` stack (`DB_HOST=localhost`, `DB_PORT=5432`). So with the stack up, `npm test` needs no extra setup. To use another server, set `DB_HOST`, `DB_PORT`, `DB_ADMIN_PASSWORD`, `DB_PASSWORD` and `JWT_SECRET`.

Uploaded documents go to local disk in a temporary folder (`STORAGE_DRIVER=local`), cleared before and after each run. The S3 adapter's own test, `test/integration/s3-storage.test.ts`, is skipped unless `S3_TEST_ENDPOINT` points at an S3-compatible server (MinIO, RustFS) with a bucket named `fms-test` (or `S3_TEST_BUCKET`); set `S3_TEST_ACCESS_KEY_ID` and `S3_TEST_SECRET_ACCESS_KEY` too. CI does not run it.

### Access control is tested from the registry (FMS-59)

`route-access.test.ts`, `data-scope.test.ts` and `realtime-scope.test.ts` call every route and every forwarded socket event, as every role, so a new route or event needs no access test of its own. They fail when a route without a permission is not on the reviewed lists, when a forwarded event has no sample, or when anything of depot B reaches a depot A user ([auth.md](auth.md#the-access-audit-fms-59)). `data-scope.test.ts` runs the small seed, about 25 seconds.

### Every test is rolled back

Each integration test runs inside one database transaction that is rolled back when the test ends, so nothing it writes survives, audit rows included. The app's own transactions become savepoints inside it, so transactional code behaves as in production.

Rules that follow from this:

- **Do database setup in `beforeEach` or in the test**, never in `beforeAll`: data written there would not be rolled back, so the harness refuses it.
- **Don't run database calls in parallel inside a test** (`Promise.all` over queries); they share one connection.
- **Tests can't see data committed by another connection**, and can't test two concurrent connections (for example a race between two dispatchers). Such a test needs its own setup; ask before adding one.

**Races** (`test/integration/trip-assignment-race.test.ts`, FMS-31): the file creates its own database (`<test db>_race`), migrates it with the same code, and drops it afterwards. It builds the service on its own `Pool` there, so each call gets its own connection and commits, as in production. Its own database is needed because committed audit rows can never be deleted (append-only), and the run fails if the test database gains rows. Copy that file's setup for another race test.

### Factories

`test/support/factories.ts` creates valid rows in one line. Unique fields get random values; pass overrides for anything the test cares about.

```ts
import { createDepot, createDriver, createUser, createVehicle } from '../support/factories';

const depot = await createDepot();
const dispatcher = await createUser({ roles: ['dispatcher'], depot });
const admin = await createUser({ roles: ['admin'] });           // not depot-scoped
const canLogIn = await createUser({ roles: ['driver'], password: 'Test-Pass-1' }); // real argon2id hash
const truck = await createVehicle({ depot });
const ev = await createVehicle({ depot, fuel_type: 'electric', fuel_efficiency_ml_per_km: null });
const { user, driver } = await createDriver({ depot });
```

Without `password`, users get a placeholder hash that never verifies, which skips the hashing cost. Pass one only when the test logs in.

Add a factory here when a second test needs the same kind of row.

For a whole dataset rather than a few rows (demos, load tests), use the seed generator: [seed-data.md](seed-data.md).

### Domain events

A service writes its events into the outbox inside the test's transaction (FMS-73), and nothing reacts until the relay delivers them. `test/support/events.ts` has two helpers:

```ts
import { deliverEvents, publishedEvents } from '../support/events';

await api.delete(`/vehicles/${id}`, cookie);
expect((await publishedEvents('VehicleRetired')).map((e) => e.payload)).toEqual([{ vehicle_id: id, depot_id }]);

await deliverEvents(); // consumers react: the driver-account copy, the cache, the expiry check on upload
```

- `publishedEvents(...types)` reads what the test published, oldest first.
- `deliverEvents()` runs relay passes on the test's connection until nothing is left.

Unit tests of a service over fakes pass a `RecordingEventBus` (`src/shared/events/recording-event-bus.ts`). It records the events and the client they were published on, so a test can check they went out inside the transaction.

### Dates: the Addis Ababa day (FMS-123)

The API judges dates by the operating day in Addis Ababa (UTC+3, `operatingToday()`): document and licence expiry, attendance, a window's first day. A test that compares with a date must use the same day, or it passes in the morning and fails in the evening:

- **Build dates with `addisDate(days, from?)`** from `test/support/dates.ts`, never with `toISOString().slice(0, 10)`. From 21:00 UTC the UTC date is a day behind Addis Ababa, so a document "31 days" out lands at 30.
- **A window ahead of now can start tomorrow.** From 21:00 in Addis Ababa (18:00 UTC), a window 3 hours ahead begins the next day. Pass its start as `from` (`addisDate(0, new Date(start))`), or use a fixed window on a fixed date.

### Assignment rules (FMS-31, FMS-62)

The rules that decide whether a driver and vehicle may be put on a trip are tested in three places, each for what it can prove:

| What | Where | How |
|---|---|---|
| The order of the checks, what each refusal says, that a refusal writes and publishes nothing, the expired-licence block, warnings | `src/modules/trip/application/trip.service.assign.test.ts` | Unit: `TripService` over fakes. Runs in well under a second. |
| Fleet's reading of availability (which reason becomes which refusal) | `src/modules/trip/domain/assignment.test.ts` | Unit: a pure function. |
| The interval arithmetic of BR-1 (driver) and BR-3 (vehicle): exact, partial, contained, around, the 0-minute gap that counts as an overlap, the 1-minute gap that does not, which statuses hold a trip | `test/integration/trip-overlap.test.ts` | Database: the range query `TripRepository.overlapping`. |
| The same rule end to end, and the exclusion constraints that backstop it | `test/integration/trip-assignment.test.ts`, `trip-assignment-race.test.ts` | HTTP, with real concurrency. |

The overlap decision is SQL (`tstzrange(..., '[]')`), not a function, so a unit test with a faked repository could only check its own stub. That is why the interval cases run against PostgreSQL. A unit test here answers "does the service do the right thing with that answer", never "is that the right answer".

## Frontend

Component tests sit next to the component as `*.test.tsx` and run in `jsdom` with [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/). Query the page the way a user sees it (`getByRole`, `getByLabelText`), not by class names.

The API is mocked with [MSW](https://mswjs.io). Any request without a mock fails the test, so a test can never call a real backend. Add a mock inside the test; it is removed after that test:

```ts
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';

server.use(
  http.get('/api/v1/vehicles', () => HttpResponse.json({ data: [], meta: { request_id: 'r-1' } })),
);
```

Mocks that most tests need can go in `src/test/msw/handlers.ts`.

jsdom has no IndexedDB: `src/test/setup.ts` adds [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) and gives each test an empty one, so the driver app's offline queue (FMS-81) starts empty in every test.

## Coverage

Coverage is reported (text summary in the CI log, HTML report as the `backend-coverage` / `frontend-coverage` artifacts) but has no minimum yet.
