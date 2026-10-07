# Continuous Integration

Workflow: `.github/workflows/ci.yml`. It runs on every pull request to `master`, every push to `master`, and manually from the Actions tab. Five jobs run in parallel:

| Check name | What it does | Fails when |
|---|---|---|
| `backend-ci` | `npm ci`, ESLint (including `no-float-in-money-path`), `tsc --noEmit`, `tsc` build, migrations into a Postgres 16 service, unit tests, integration tests as `fms_app` | Lint error, type error, build error, failing test |
| `frontend-ci` | `npm ci`, ESLint, `tsc -b`, tests (once FMS-74 adds Vitest), `vite build` | Lint error, type error, failing test, build error |
| `migrations-ci` | Applies every migration Up twice, every Down in reverse, Up again; then runs `npm run migrate` on a fresh database twice | A migration is not idempotent or not reversible, Down leaves a schema behind, the runner fails or re-applies a file |
| `docker-stack` | Creates a `.env` with generated secrets, builds the Compose images, starts the stack, waits for `GET /api/v1/health` | An image does not build or the backend does not start |
| `secrets-scan` | gitleaks over the checked-out files, with the default rules plus `.gitleaks.toml` (weak hardcoded passwords, literal fallbacks in code, SQL role passwords) | Any secret is committed |

CI needs no repository secrets. Its databases are throwaway containers on the runner; the admin password is derived from the run id, and the app password and JWT secret are generated per run and masked in logs.

Run the same checks locally before pushing:

```bash
npm ci
npm run lint -w fms-backend && npm run typecheck -w fms-backend && npm test -w fms-backend
# Integration tests need a migrated database and the app settings, e.g. against `make dev`:
#   DB_HOST=localhost DB_NAME=fms_db DB_USER=fms_app DB_PASSWORD=<DB_APP_PASSWORD from .env> \
#   JWT_SECRET=<JWT_SECRET from .env> npm run test:integration -w fms-backend
npm run lint -w fms-frontend && npm run typecheck -w fms-frontend && npm run build -w fms-frontend
```

## Branch protection for `master`

A repository admin sets this once in **Settings → Branches → Add branch protection rule** (or **Rules → Rulesets**) for `master`:

- **Require a pull request before merging**, with **1 approval**, and **dismiss stale approvals when new commits are pushed**.
- **Require status checks to pass**, with **require branches to be up to date**, and select: `backend-ci`, `frontend-ci`, `migrations-ci`, `docker-stack`, `secrets-scan`. A check only appears in the list after it has run once on a PR.
- **Do not allow bypassing the above settings** (applies the rules to admins too, so nobody can push to `master` directly).
- **Block force pushes** and **block deletions**.

The check names come from each job's `name:` in `ci.yml`. If a job is renamed, update the rule, or every PR will wait for a check that never reports.
