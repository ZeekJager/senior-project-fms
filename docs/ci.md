# Continuous Integration

Workflow: `.github/workflows/ci.yml`. It runs on every pull request to `master`, every push to `master`, and manually from the Actions tab. Five jobs run in parallel:

| Check name | What it does | Fails when |
|---|---|---|
| `backend-ci` | `npm ci`, ESLint (including `no-float-in-money-path`), `tsc --noEmit`, `tsc` build, then unit and integration tests with coverage against PostgreSQL 16 as `fms_app` (the tests create and migrate their own `fms_test` database); uploads the `backend-coverage` report | Lint error, type error, build error, failing test, a test leaving rows behind |
| `frontend-ci` | `npm ci`, ESLint, `tsc -b`, component tests with coverage (uploads `frontend-coverage`), `vite build` | Lint error, type error, failing test, build error |
| `migrations-ci` | Applies every migration Up twice, every Down in reverse, Up again; then runs `npm run migrate` on a fresh database twice | A migration is not idempotent or not reversible, Down leaves a schema behind, the runner fails or re-applies a file |
| `docker-stack` | Creates a `.env` with generated secrets, builds the Compose images, starts the stack, waits for `GET /health/ready` | An image does not build or the backend does not start |
| `secrets-scan` | gitleaks over the checked-out files, with the default rules plus `.gitleaks.toml` (weak hardcoded passwords, literal fallbacks in code, SQL role passwords) | Any secret is committed |

CI needs no repository secrets. Its databases are throwaway PostgreSQL containers on the runner (`scripts/ci/start-postgres.sh`); every password and the JWT secret are generated per run and masked in logs.

Run the same checks locally before pushing (integration tests need the `make dev` stack running; see [testing.md](testing.md)):

```bash
npm ci
npm run lint -w fms-backend && npm run typecheck -w fms-backend
npm run lint -w fms-frontend && npm run typecheck -w fms-frontend && npm run build -w fms-frontend
npm test
```

## Branch protection for `master`

A repository admin sets this once in **Settings → Branches → Add branch protection rule** (or **Rules → Rulesets**) for `master`:

- **Require a pull request before merging**, with **1 approval**, and **dismiss stale approvals when new commits are pushed**.
- **Require status checks to pass**, with **require branches to be up to date**, and select: `backend-ci`, `frontend-ci`, `migrations-ci`, `docker-stack`, `secrets-scan`. A check only appears in the list after it has run once on a PR.
- **Do not allow bypassing the above settings** (applies the rules to admins too, so nobody can push to `master` directly).
- **Block force pushes** and **block deletions**.

The check names come from each job's `name:` in `ci.yml`. If a job is renamed, update the rule, or every PR will wait for a check that never reports.
