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

### Every test is rolled back

Each integration test runs inside one database transaction that is rolled back when the test ends, so nothing it writes survives, audit rows included. The app's own transactions become savepoints inside it, so transactional code behaves as in production.

Rules that follow from this:

- **Do database setup in `beforeEach` or in the test**, never in `beforeAll`: data written there would not be rolled back, so the harness refuses it.
- **Don't run database calls in parallel inside a test** (`Promise.all` over queries); they share one connection.
- **Tests can't see data committed by another connection**, and can't test two concurrent connections (for example a race between two dispatchers). Such a test needs its own setup; ask before adding one.

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

## Coverage

Coverage is reported (text summary in the CI log, HTML report as the `backend-coverage` / `frontend-coverage` artifacts) but has no minimum yet.
