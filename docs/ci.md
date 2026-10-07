# Continuous Integration

Workflow: `.github/workflows/ci.yml`. It runs on every pull request to `master`, every push to `master`, and manually from the Actions tab. Four jobs run in parallel:

| Check name | What it does | Fails when |
|---|---|---|
| `backend-ci` | `npm ci`, ESLint (including `no-float-in-money-path`), type-check (once the backend is TypeScript, FMS-70), migrations into a Postgres 16 service, `npm test -w fms-backend` | Lint error, type error, failing test |
| `frontend-ci` | `npm ci`, ESLint, `tsc -b`, tests (once FMS-74 adds Vitest), `vite build` | Lint error, type error, failing test, build error |
| `migrations-ci` | Applies every migration Up twice, every Down in reverse, Up again; then runs `scripts/migrate.js` on a fresh database twice | A migration is not idempotent or not reversible, Down leaves a schema behind, the runner fails or re-applies a file |
| `docker-stack` | Builds the Compose images, starts the stack, waits for `GET /api/v1/health` | An image does not build or the backend does not start |

Run the same checks locally before pushing:

```bash
npm ci
npm run lint -w fms-backend && npm test -w fms-backend
npm run lint -w fms-frontend && npm run typecheck -w fms-frontend && npm run build -w fms-frontend
```

## Branch protection for `master`

A repository admin sets this once in **Settings → Branches → Add branch protection rule** (or **Rules → Rulesets**) for `master`:

- **Require a pull request before merging**, with **1 approval**, and **dismiss stale approvals when new commits are pushed**.
- **Require status checks to pass**, with **require branches to be up to date**, and select: `backend-ci`, `frontend-ci`, `migrations-ci`, `docker-stack`. A check only appears in the list after it has run once on a PR.
- **Do not allow bypassing the above settings** (applies the rules to admins too, so nobody can push to `master` directly).
- **Block force pushes** and **block deletions**.

The check names come from each job's `name:` in `ci.yml`. If a job is renamed, update the rule, or every PR will wait for a check that never reports.
