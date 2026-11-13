# Continuous Integration

Workflow: `.github/workflows/ci.yml`. It runs on every pull request to `master`, every push to `master`, and manually from the Actions tab. Five jobs run in parallel:

| Check name | What it does | Fails when |
|---|---|---|
| `backend-ci` | `npm ci`, ESLint (including `no-float-in-money-path` and the module boundary rules `no-cross-module-import` / `no-cross-schema-sql`), the ESLint rule tests, `tsc --noEmit`, `tsc` build, then unit and integration tests with coverage against PostgreSQL 16 as `fms_app` (the tests create and migrate their own `fms_test` database); uploads the `backend-coverage` report | Lint error (including a cross-module import or cross-schema SQL), type error, build error, failing test, a test leaving rows behind, **a route mounted but not in `docs/openapi.yaml`** (or the reverse), a spec that fails its lint, or a response that does not match the spec ([api-docs.md](api-docs.md)) |
| `load-test` | `npm ci`, `tsc` build, then the load suite (FMS-61, [load-testing.md](load-testing.md)) against PostgreSQL 16 and Redis: a database of its own seeded at the budget size, the compiled API with `NODE_ENV=production`, GPS with dashboards watching, 50 API users, 20 dashboard users. Pull requests run the `smoke` profile (about 6 minutes); pushes to `master` the card's workload, `full` (about 12). A manual run (*Run workflow*) takes a `profile` input: `full` (the default), `smoke`, or `fleet500`, NFR-3's 500 vehicles on the live map (FMS-152, about 25 minutes, on the 500-vehicle dataset; only this way, never on a push). Uploads the `load-report` artifact (the report as JSON and as a page, and the API's log) | A budget missed: a dropped socket event, delivery p95 of 500 ms or more, API CPU p95 of 80% or more, an endpoint over its p95, a page over 2 s, an analytics report over 200 ms, or any failed request |
| `frontend-ci` | `npm ci`, ESLint, `tsc -b`, component tests with coverage (uploads `frontend-coverage`), `vite build` | Lint error, type error, failing test, build error |
| `ai-service-ci` | Python 3.12, `pip install` of `packages/ai-service` (requirements and requirements-dev), `pytest` (the feature spec, the training dataset and its quality checks, FMS-52; the model, FMS-53; the service, FMS-54), then the dataset generated twice and compared byte for byte, then the model trained on it and graded by `evaluate.py`; the same for the trip risk model (FMS-155): its generated trips twice, `train_trip_risk.py`, `evaluate_trip_risk.py` | A failing test, a dataset that fails its checks, a generator that is not reproducible, a model that misses an FMS-53 acceptance criterion, a trip risk model whose recorded metrics do not reproduce |
| `migrations-ci` | Applies every migration Up twice, every Down in reverse, Up again; then runs `npm run migrate` on a fresh database twice | A migration is not idempotent or not reversible, Down leaves a schema behind, the runner fails or re-applies a file |
| `docker-stack` | Creates a `.env` with generated secrets, builds the Compose images, starts the stack, waits for `GET /health/ready`, then `scripts/ci/check-replica.sh` (FMS-94): the replica streams, a write on the primary reaches it, it refuses writes, readiness reports it `ok`, and `degraded` while it is stopped; then (FMS-75) the database is collecting `pg_stat_statements` and the API's metrics port answers in its container. | An image does not build, the backend does not start, or the replica does not follow the primary or is not fallen back from |
| `production-images` | Builds the three production images tagged by commit (FMS-105, [production-images.md](production-images.md)), scans them with Trivy (fails on a critical finding that has a fix), then `scripts/ci/smoke-images.sh`: migrates with the backend image, starts the three images with `NODE_ENV=production`, checks health, that none runs as root, that the web app serves the SPA and reaches the API through nginx | An image does not build, a critical vulnerability with a fix, an image runs as root or fails its health check |
| `dependency-audit` | `npm audit` over the lockfile (fails on a **critical** advisory; high and moderate are listed) and `pip-audit` over the AI service's pins (fails on any known vulnerability: it does not grade). No install, so it is quick (FMS-103, [security.md](security.md)) | A critical vulnerability in an npm dependency, or any in a Python pin; fix by updating it, or `npm audit fix` |
| `secrets-scan` | gitleaks over the checked-out files, with the default rules plus `.gitleaks.toml` (weak hardcoded passwords, literal fallbacks in code, SQL role passwords) | Any secret is committed |

CI needs no repository secrets. Its databases are throwaway PostgreSQL containers on the runner (`scripts/ci/start-postgres.sh`); every password and the JWT secret are generated per run and masked in logs.

A pre-commit hook (Husky + lint-staged, installed by `npm install`) lints the staged backend files with the same rules, so most lint failures never reach CI. `git commit --no-verify` skips it, but `backend-ci` still fails.

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
- **Require status checks to pass**, with **require branches to be up to date**, and select: `backend-ci`, `frontend-ci`, `ai-service-ci`, `migrations-ci`, `docker-stack`, `production-images`, `dependency-audit`, `secrets-scan`, and `load-test` (its smoke profile on pull requests). A check only appears in the list after it has run once on a PR.
- **Do not allow bypassing the above settings** (applies the rules to admins too, so nobody can push to `master` directly).
- **Block force pushes** and **block deletions**.

The check names come from each job's `name:` in `ci.yml`. If a job is renamed, update the rule, or every PR will wait for a check that never reports.
