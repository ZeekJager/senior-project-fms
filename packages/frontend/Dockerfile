# syntax=docker/dockerfile:1
# Production image of the web app (FMS-105, docs/production-images.md): the static build served by
# nginx as an unprivileged user on 8080. Build from the repository root:
#   docker build -f packages/frontend/Dockerfile -t fms-frontend:<commit> .
# The browser calls /api/v1 on its own origin; nginx forwards /api (and the Socket.IO socket) to
# API_UPSTREAM, so the image holds no address of the API and is the same in every environment.

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV HUSKY=0
COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
COPY packages/eslint-plugin-fms/package.json packages/eslint-plugin-fms/
RUN npm ci --workspace fms-frontend --include-workspace-root --ignore-scripts
COPY packages/frontend packages/frontend
# Optional build-time settings of the map and the phone GPS.
ARG VITE_MAP_TILE_URL
ARG VITE_MAP_TILE_ATTRIBUTION
ARG VITE_GPS_MAX_ACCURACY_M
# Type-checks, then builds. Lint is its own CI job.
RUN cd packages/frontend && npx tsc -b && npx vite build

FROM ${NGINX_IMAGE} AS runtime
# The base image is rebuilt rarely: take the operating system's security fixes published since (OpenSSL, nginx, ...),
# which the image scan in CI otherwise fails on. Back to the unprivileged user afterwards.
USER root
RUN apk upgrade --no-cache
# Where the start-up script writes the Content-Security-Policy header (FMS-103): the nginx user owns it, the rest of /etc/nginx is root's.
RUN mkdir -p /etc/nginx/snippets && chown nginx:nginx /etc/nginx/snippets
USER nginx
# nginx renders templates/*.template into conf.d at start, filling ${API_UPSTREAM}.
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
# Runs before nginx starts, with the image's other start-up scripts (envsubst of the template above is one).
COPY --chmod=0755 docker/nginx/40-content-security-policy.sh /docker-entrypoint.d/40-content-security-policy.sh
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
ENV API_UPSTREAM=http://backend:3000 CSP_MODE=report-only CSP_IMG_SOURCES=https://tile.openstreetmap.org
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
