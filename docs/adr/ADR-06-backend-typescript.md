# ADR-06: TypeScript for the Backend

**Status:** Accepted (decision D-01 in the delivery plan)
**Card:** FMS-70
**Related:** System Design Draft §31 (module structure), ADR-01 (modular monolith)

## Context

The System Design Draft lays out each module as TypeScript files (`vehicle.controller.ts`, `create-vehicle.usecase.ts`, `vehicle.repository.ts`). The backend was written in JavaScript while the frontend already uses TypeScript. The backend was still six files when this was decided, so migrating was cheapest now.

## Decision

The backend is TypeScript in `strict` mode.

- **Runtime in development:** `tsx` (no build step), restarted by `nodemon` on `.ts` changes, the same watcher the Docker setup already relied on.
- **Build:** `tsc -p tsconfig.build.json` to `dist/`; `npm start` runs `dist/src/server.js`.
- **Module format:** CommonJS output (`module: NodeNext` without `"type": "module"`), so `pg`, `express` and `__dirname` work unchanged.
- **Linting:** the root ESLint 10 config applies `typescript-eslint` to `packages/backend/**/*.ts`; the FMS money rule exempts `units.ts` as it did `units.js`.
- **Tests:** Vitest, chosen in FMS-74 (same runner as the frontend, native TypeScript). See docs/testing.md.
- **Layout:** `src/modules/<module>/{api,application,domain,infrastructure}` with an `index.ts` public interface per module, registered in `src/modules/index.ts` and mounted by `src/app.ts`.

## Consequences

- Type errors fail CI (`backend-ci` runs `tsc --noEmit` and a build).
- Every new backend file is `.ts`; plain `.js` in `src/`, `scripts/` or `test/` is not allowed.
- `make migrate` now runs `npm run migrate` (tsx) inside the backend container.
- Shared request properties (`req.user`, `req.correlationId`, `req.dbMutate`) are typed in `src/types/express.d.ts`; FMS-05 extends `RequestUser`.
