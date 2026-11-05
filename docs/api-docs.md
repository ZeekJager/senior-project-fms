# API documentation (OpenAPI)

Card: FMS-65 (SE-101), with FMS-119 (SE-163). Code: `docs/openapi.yaml`, `packages/backend/src/shared/http/api-docs.ts`, `packages/backend/test/support/openapi.ts`, `packages/backend/test/integration/{openapi,contract,api-docs}.test.ts`.

`docs/openapi.yaml` is the machine-readable contract of the API (api-contract §24). It is one OpenAPI 3.1 file, committed, and **every route the API mounts is described in it**. [api-contract.md](api-contract.md) stays the reference for the rules behind the operations.

## Reading it

Swagger UI is served by the backend at **`/api-docs`** (for the dev stack, <http://localhost:3000/api-docs>) outside production; the raw file is at `/api-docs/openapi.yaml` and is `docs/openapi.yaml` itself, not a generated copy. In production nothing is served at `/api-docs`.

- **Try it out.** Call `POST /auth/login` first. The session is an HttpOnly cookie the browser keeps and sends with the calls that follow (the page sends credentials with every request), so there is no token to paste. The Authorize button is the OpenAPI way of naming the cookie; it has nothing to type.
- **Tags** group the operations as the contract's modules do: Auth, Users, Depots, Vehicles, Drivers, Attendance, Documents, Trips, Routes, Inspections, Fuel, Maintenance, Inventory, Alerts, Incidents, Notifications, Tracking, Integrations, Analytics, Settings, Photos, Backups, Audit, Health, and others.
- **Public operations** (sign-in, refresh, sign-out, setting a password from a link, a document's signed link, webhooks, the health probes) say `security: []`. Every other operation needs the session.
- **Legacy paths** (`/maintenance`, `/audit`) are described as `deprecated: true`, each with its own operation id and a pointer to the canonical path. The health probes are at the root, not under `/api/v1`, and say so with their own `servers` entry.
- The ML service's internal endpoints belong to that service and are not part of this API.

## Why one file, and no generated request validation

Contract §26 sketches a tree of files. The repository keeps one, because the checks below read it whole and a `$ref` across files would need a bundler for little gain; the tags give the grouping the tree would. Requests are validated by each route's own schema (zod, with the contract's error codes), not by a second validator generated from the spec: two validators of one request disagree sooner or later. What keeps the spec and the code from drifting is the checks below, which run in CI.

## What CI holds it to

All of it in `backend-ci` ([testing.md](testing.md#the-openapi-spec-is-the-contract-fms-119-fms-65)):

| Check | Fails when |
|---|---|
| Routes, both ways | a route is mounted and the spec does not describe it, or the spec describes an operation that is not mounted (a misspelt path or method included) |
| Structure (the lint) | an operation lacks an operation id, a summary or a declared tag; has no success response, or no `401` though it is not public; a `{path parameter}` is undeclared or declared for a path without it; a `$ref` is broken; a schema is not valid JSON Schema; an error code is not in `ERROR_CODES` |
| Responses | a real response has a status the operation does not list, or a body that does not match its schema |

## Adding an operation

1. Write it in `docs/openapi.yaml`: operation id, summary, tag, parameters, request body, every response it can give (with the error codes and reasons, from the code, not from memory), `security: []` if public.
2. Call it in `contract.test.ts` (or in your own test with `expectContract`): the success and one refusal. Fix the schema where the real body disagrees; that is what the test is for.
3. Run `npx vitest run --project integration test/integration/openapi.test.ts test/integration/contract.test.ts`.

A route added without step 1 fails the first check; an operation described but never called is not checked against the real thing until someone calls it.
