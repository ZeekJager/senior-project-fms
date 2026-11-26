# End-to-end golden path (FMS-63)

Card FMS-63 (SE-99), architecture §41 scenarios A to E. One automated run of the journey evaluators will see, through
the web app and the API of a running stack: `packages/e2e`, with Playwright.

## The journey

Each step is a Playwright `test.step`, run in order, as the person who does it in real life:

| Step | Who | Through | Checked |
|---|---|---|---|
| Set up | Admin | API | A depot of its own, a dispatcher and a technician (invited, password set from the invitation), a driver with a sign-in, a diesel truck, an electric van and a route; every name carries the run's id, so runs never meet |
| Inspection | Driver | API | A pre-trip DVIR with a failed item: `issues_found`, and the truck flagged for maintenance (FMS-28) |
| The flag holds | Dispatcher | API | A planned trip; assigning the flagged truck is `409 CONFLICT_VEHICLE_FLAGGED` (BR-2) |
| Repair | Technician | API | A corrective repair opened and completed; the flag cleared |
| Assign | Dispatcher | API | The driver and the truck: `assigned` |
| Start | Driver | API | `en_route` |
| GPS on the map | Driver, dispatcher | API, web | Three phone positions (FMS-57); the dispatcher signs in on the web, and the truck is on the live map (S-21) |
| Alert acknowledged | Dispatcher | web | Over 80 km/h for three positions: a speeding flag (FMS-46) and an *unsafe driving* alert; acknowledged from the map's alert list, and the API says so |
| End | Driver | API | `completed` |
| Fuel | Driver | API | The fill-up logged (FMS-39) |
| Electric vehicle | Driver | API | A fuel log for the electric van is refused: `400`, `not_a_liquid_fuel` |

The whole run has 5 minutes (`playwright.config.ts`); nothing retries.

## When a step fails

The failure names the step, the person, the request, the status, the error code, and the `X-Request-Id` the API
answered with, for example:

```text
Step "the dispatcher assigns the driver and the truck" failed: dispatcher: POST /trips/…/assign answered 409, expected 200.
CONFLICT_DRIVER_NOT_ELIGIBLE: … (request id 6f1c…)
```

The request id finds the request in the backend logs and the audit trail. A step that waits for something (the flag,
the alert) says what did not happen and how long it waited. In CI a failure also keeps the Playwright trace, a
screenshot and the HTML report (the `e2e-report` artifact), and prints the backend and frontend logs.

## Running it

Against a stack that is up, migrated and has an admin:

```sh
E2E_WEB_URL=http://localhost:5173 E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… npm run e2e -w fms-e2e
```

- `npm run e2e:install -w fms-e2e` installs Chromium the first time.
- `E2E_WEB_URL` is the web app: the Vite dev server, which proxies `/api` to the backend.
- The admin is any admin of that stack; on a fresh one, `npm run user:create -- --role admin` in the backend container.
- Without the admin's details the test is skipped, not failed.

## In CI

The `e2e-golden-path` job ([ci.md](ci.md)) installs the suite and Chromium and type-checks it (before Compose, whose
bind mounts leave root-owned `node_modules` folders behind), then builds and starts the backend and frontend from
Compose, migrates, creates an admin with a random password for the run, and runs the suite. It replaces the
card's "on staging": there is no shared staging environment yet, and the Compose stack runs the same images.
