# ADR-12: Caddy at the Edge, in Front of Two API Instances

- **Status:** Accepted
- **Date:** 2026-11-25
- **Card:** FMS-106 (SE-150)

## Context

Nothing served the system over TLS (NFR-8) and the API ran as one process (§28.1, §30). The web app's nginx (FMS-105)
already serves the built files and forwards `/api`, but expects TLS to end in front of it. FMS-106 asks for HTTPS and
WSS with Let's Encrypt certificates, HSTS, HTTP redirected to HTTPS, TLS 1.2 or later, two API instances behind the
proxy with one able to die without taking the site down, and the database, Redis and the AI service on an internal
network.

## Decision

- **Caddy** (`caddy:2.10-alpine`, `docker/caddy/Caddyfile`) is the only service with published ports. It gets and renews
  the Let's Encrypt certificate itself, redirects port 80 to HTTPS, sets HSTS, and allows TLS 1.2 and 1.3 only.
- **Caddy balances the API**, not the web app's nginx: `/api/*` goes straight to `api-1` and `api-2` with active health
  checks on `/health/ready`, passive ones on failed connections, retries on the other instance, and a cookie (`fms_lb`)
  that keeps a browser on one instance, which Socket.IO's long-polling needs. Everything else goes to the web app.
- **Two networks:** `edge` (Caddy, the web app, the API) and `data`, internal (PostgreSQL, Redis, the AI service, the API).
- **A separate `docker-compose.prod.yml`** of the production images. The development stack (`docker-compose.yml`) is unchanged.

## Alternatives

- **nginx with certbot:** nginx is already in the web app's image, but certificates would need certbot, a renewal
  timer and a reload hook, and open-source nginx has no active health checks or cookie stickiness (only `ip_hash`,
  which pins every phone behind one carrier's NAT to one instance). Caddy does all of it in one binary and about 40
  lines.
- **Traefik:** automatic certificates and health checks too, but configured through container labels and a second
  configuration format, for a stack of five services.
- **TLS in the web app's nginx, and nginx balancing the API:** one hop fewer, but the frontend image would carry
  certificates and the balancing limits above; a release of the web app would restart the edge.
- **Socket.IO on WebSocket only** (no long-polling, so no stickiness): drops the fallback that keeps the live map
  working behind proxies that block WebSockets, which drivers' and depots' networks sometimes are.

## Consequences

- `scripts/ci/smoke-tls.sh` checks the redirect, the certificate, the TLS floor, HSTS, WSS, both instances taking
  requests, and 160 requests without a failure while one instance is killed, on every push (`production-images` job).
- The SSL Labs grade needs a public name, so it is checked by hand after each deployment ([deployment.md](../deployment.md#ssl-labs)).
- One Caddy is a single point of failure for the site, as one HAProxy is for the database (ADR-08); more than one host
  needs a floating address or a provider's load balancer in front.
- The API sees one proxy hop (`TRUST_PROXY=1`), the same as behind the web app's nginx.
