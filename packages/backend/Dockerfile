# syntax=docker/dockerfile:1
# Production image of the API (FMS-105, docs/production-images.md). Build from the repository root:
#   docker build -f packages/backend/Dockerfile -t fms-backend:<commit> .
# TypeScript is compiled in a build stage; the image runs dist/ with production dependencies only,
# as the unprivileged `node` user. The layout mirrors the repository (/app/packages/backend), so the
# default ML_FEATURE_SPEC_PATH (../ai-service/feature_spec.json) and the migrations/ lookup both resolve.

ARG NODE_IMAGE=node:22-alpine

# 1. Every dependency, to compile.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV HUSKY=0
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
COPY packages/eslint-plugin-fms/package.json packages/eslint-plugin-fms/
RUN npm ci --workspace fms-backend --include-workspace-root --ignore-scripts
COPY packages/backend/tsconfig.json packages/backend/tsconfig.build.json packages/backend/
COPY packages/backend/src packages/backend/src
COPY packages/backend/scripts packages/backend/scripts
RUN npm run build --workspace fms-backend

# 2. Production dependencies only: no tsx, no vitest, no swagger-ui-dist.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV HUSKY=0
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
COPY packages/eslint-plugin-fms/package.json packages/eslint-plugin-fms/
RUN npm ci --workspace fms-backend --omit=dev --ignore-scripts && npm cache clean --force

# 3. What runs.
FROM ${NODE_IMAGE} AS runtime
# pg_dump and pg_restore for database backups (FMS-144): the server's major version, 16.
RUN apk add --no-cache postgresql16-client && apk upgrade --no-cache
ENV NODE_ENV=production PORT=3000 STORAGE_LOCAL_DIR=/app/packages/backend/storage
WORKDIR /app/packages/backend
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY packages/backend/package.json ./
COPY --from=build /app/packages/backend/dist ./dist
COPY packages/backend/migrations ./migrations
COPY packages/ai-service/feature_spec.json /app/packages/ai-service/feature_spec.json
COPY packages/ai-service/trip_risk_spec.json /app/packages/ai-service/trip_risk_spec.json
# Uploaded documents when STORAGE_DRIVER=local: mount a volume here (or use S3).
RUN mkdir -p storage && chown -R node:node storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/health/ready >/dev/null || exit 1
# Migrations: docker run --rm <image> node dist/scripts/migrate.js (needs DB_ADMIN_USER and DB_ADMIN_PASSWORD).
CMD ["node", "dist/src/server.js"]
