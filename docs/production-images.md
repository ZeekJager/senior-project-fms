# Production container images (FMS-105)

Three small images for deployment, built from the repository. They are separate from the development
images (`Dockerfile.dev`, used by `docker-compose.yml`), which keep dev tooling and mount the source.

| Image | Dockerfile | Build context | Runs |
|---|---|---|---|
| `fms-backend` | `packages/backend/Dockerfile` | repository root | `node dist/src/server.js` on `node:22-alpine`, user `node`, port 3000 |
| `fms-frontend` | `packages/frontend/Dockerfile` | repository root | the static build behind nginx (`nginx-unprivileged`), port 8080 |
| `fms-ai-service` | `packages/ai-service/Dockerfile` | `packages/ai-service` | `uvicorn` with 2 workers on `python:3.12-slim`, user `ml` (uid 10001), port 5000 |

```sh
tag=$(git rev-parse --short HEAD)
docker build -f packages/backend/Dockerfile  -t fms-backend:$tag .
docker build -f packages/frontend/Dockerfile -t fms-frontend:$tag .
docker build -t fms-ai-service:$tag packages/ai-service
```

CI tags each image with the full commit SHA. A deployment pins an image by that tag, never by `latest`.

## What is in each image

- **Backend.** Multi-stage: a build stage compiles TypeScript with `tsc` (`npm run build`); a second stage installs
  production dependencies only (`npm ci --omit=dev`), so there is no `tsx`, `vitest` or `swagger-ui-dist`; the runtime
  stage copies `dist/`, the dependencies, `migrations/` and `feature_spec.json`, and installs `postgresql16-client`
  for database backups (FMS-144). The folder layout mirrors the repository (`/app/packages/backend`), so the default
  `ML_FEATURE_SPEC_PATH` (`../ai-service/feature_spec.json`) and the migration lookup need no setting. API documentation
  pages are off in production (`NODE_ENV=production`) and the spec is not in the image.
- **Frontend.** The build stage type-checks and runs `vite build`; the runtime stage is only the output and nginx. The
  browser calls `/api/v1` on its own origin and nginx forwards `/api` (the Socket.IO socket too, with the upgrade
  headers) to `API_UPSTREAM`, so the same image serves every environment. `index.html` and the service worker are
  never cached (a release must reach a phone that has the old one); hashed files under `/assets/` are cached for a
  year. `/healthz` answers for orchestrators. Optional build arguments: `VITE_MAP_TILE_URL`,
  `VITE_MAP_TILE_ATTRIBUTION`, `VITE_GPS_MAX_ACCURACY_M`.
- **ML service.** Dependencies go into a virtualenv in a build stage; the model is trained at build time from the
  seeded dataset (the same data every build), so the container needs only `ML_SERVICE_TOKEN` (at least 32 characters).

- **Base images and security fixes.** The runtime stages of the backend and the web app run `apk upgrade`, so the operating
  system's fixes published since the base image was built are in. The web app is on `nginx-unprivileged:1.30-alpine`
  (nginx 1.30): the 1.28 line stopped at 1.28.2, which has a critical vulnerability (CVE-2026-42945) fixed only in later
  versions. When the scan below starts failing on a base image, move to its newest minor tag before anything else.

All three run as a non-root user, carry a `HEALTHCHECK`, and contain no secrets: every secret comes from the
environment at run time.

## Running them

Required environment for the backend in production: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `JWT_SECRET`,
`REDIS_HOST`, `REDIS_PASSWORD` (and the rest of `.env.example` as the deployment needs). Migrations run from the same
image, as the schema owner, before the new version starts:

```sh
docker run --rm -e DB_HOST=... -e DB_NAME=... -e DB_USER=fms_app -e DB_PASSWORD=... \
  -e DB_ADMIN_USER=... -e DB_ADMIN_PASSWORD=... fms-backend:$tag node dist/scripts/migrate.js
```

Uploaded documents: use S3 (`STORAGE_DRIVER=s3`), or mount a volume at `/app/packages/backend/storage` for local
storage. The folder is owned by the `node` user.

## CI

The `production-images` job (docs/ci.md) builds the three images, scans them with Trivy and runs
`scripts/ci/smoke-images.sh`:

- **Scan.** `trivy image --severity CRITICAL --ignore-unfixed --exit-code 1`: a critical finding that has a fix fails
  the job. High findings are printed for review and do not fail it. Unfixed findings in the base image are not
  actionable by this repository and are left out. The Trivy version is pinned in the workflow and its download is
  checked against the published checksum.
- **Smoke run.** Starts PostgreSQL and Redis, migrates with the backend image, starts the three images with
  `NODE_ENV=production`, and checks: each image becomes healthy, none runs as root, `pg_dump` is in the backend image
  and no dev dependency is, the web app serves the SPA at `/` and at an app route and a missing asset is a 404, and
  `/api/v1/auth/me` through nginx is the backend's 401 (not nginx's 502).

Run the same check locally with the three images built: `sh scripts/ci/smoke-images.sh fms-backend:$tag fms-frontend:$tag fms-ai-service:$tag`.
