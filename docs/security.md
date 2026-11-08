# Security hardening (FMS-103)

Architecture §5.5 (security by design), §24, §25 and api-contract §20-21: the known attack paths removed before release. This page says
what is in place, where, and how it is tested. The rules themselves are in api-contract §20-21.

| Control | Where | Tested by |
|---|---|---|
| Response headers and CSP (the API) | `src/middleware/securityHeaders.ts` | `security-hardening.test.ts` |
| Web app headers and CSP (nginx) | `docker/nginx/`, the frontend image | `scripts/ci/smoke-images.sh` |
| CORS allow-list | `src/middleware/cors.ts`, `CORS_ALLOWED_ORIGINS` | `security-hardening.test.ts` |
| CSRF: Origin check and token | `src/shared/http/csrf.ts`, the API client | `security-hardening.test.ts`, `client.test.ts` |
| Rate limits by kind of client | `src/shared/http/rate-limit.ts` | `security-ratelimit.test.ts` |
| Request size limits | `src/middleware/requestLimits.ts`, body parsers | `security-hardening.test.ts` |
| Sort and filter allow-lists | each list's schema | `security-sorting.test.ts` |
| Dependency scanning | CI job `dependency-audit` | the job itself |
| Secret scanning | CI job `secrets-scan` | the job itself |

## Response headers

The API answers JSON, files and redirects, never a page of its own, so its policy is the strictest: `Content-Security-Policy: default-src
'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`, `Cross-Origin-Opener-Policy: same-origin`, a `Permissions-Policy`
that turns off camera, microphone, geolocation, payment and USB, and in production `Strict-Transport-Security` (six months, subdomains).
`X-Powered-By` is gone. Errors and 404s carry them too (they are set first). Two routes set their own on purpose: the photo and file
routes (`default-src 'none'` and a type), and the documentation page `/api-docs` (non-production), whose policy allows Swagger UI's own
scripts and styles and calls to this origin.

HSTS is the TLS terminator's to set where it is not the API: the web app's nginx does not send it, because TLS ends in front of it.

### The web app

The nginx image adds `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy` on every response, and a
`Content-Security-Policy`, written when the container starts (`docker/nginx/40-content-security-policy.sh`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: <CSP_IMG_SOURCES>;
font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'
```

Scripts only from the site: the theme script that was inline in `index.html` is now `/theme-init.js`, loaded from `<head>` so there is
still no flash. Styles may be inline, because React and Leaflet set style attributes. Images may also come from `CSP_IMG_SOURCES`
(default OpenStreetMap's tile server; set it to the host of `VITE_MAP_TILE_URL` if the build changed it).

**It ships as `Content-Security-Policy-Report-Only`** (`CSP_MODE=report-only`, the default): the browser lists in its console what the
policy would have blocked and blocks nothing. A policy for a single-page app is only known to be right by running the app in a
browser, and this was written from the code, not from a browser run. To enforce: run a release in report-only, use the screens
(the map, photos, the driver app offline, an upload), and when the console shows no violation, set `CSP_MODE=enforce`. `off` removes it.

## CORS

Only the origins in `CORS_ALLOWED_ORIGINS` are answered, by name and with credentials, never `*`. The default is none, which is right
when the web app and the API are one host (the Compose stack and the production images, where nginx serves both). Any other origin gets
no CORS headers, so a browser lets its page send a simple request but not read the answer, and a preflight (every request with a JSON
body, a token header or an `Idempotency-Key`) fails: the request is never sent.

## CSRF

The session cookies are `HttpOnly`, `Secure` and `SameSite=Strict`, which already keeps them off cross-site requests. Two more layers
for a `POST`, `PUT`, `PATCH` or `DELETE` that carries them:

1. **Origin.** The request's `Origin` must be this host (hosts are compared, not schemes: behind a TLS-terminating proxy the API sees
   http while the browser says https) or one of `CORS_ALLOWED_ORIGINS`. With no `Origin`, `Sec-Fetch-Site` must not say `cross-site` or
   `same-site`. `Origin: null` (a sandboxed frame) is never accepted.
2. **Token.** `X-CSRF-Token` must equal the `fms_csrf` cookie, and the token must be one this server signed *for this session's access
   token* (an HMAC under a key derived from `JWT_SECRET`). The cookie is readable by the page, which echoes it; sign-in and refresh set a
   new one with the session, and sign-out clears it. Because it is bound to the access token, a cookie planted from a sibling subdomain, or
   the attacker's own valid token, fails.

A refusal is `403 FORBIDDEN_CSRF` (`field` `origin`, or `x-csrf-token` with `required` / `invalid`) and an `access.denied` entry in the audit
log with the route and the reason, never the token.

**Not CSRF targets:** requests with no session cookie: devices (bearer token), webhooks (signature), and sign-in from anywhere.
**Exempt from the token, still checked for origin:** `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/password` (the token does not
exist yet, or may be stale), `POST /telemetry/web-vitals` (a beacon sets no headers), and the **offline queue's replay**: the service
worker replays queued submissions and cannot read cookies, so a request with `X-Client-Channel: pwa` and an `Idempotency-Key`, whose
`Origin` is this very host, passes. A cross-origin page cannot send those custom headers without a preflight, which CORS refuses. Failing
those replays with a 403 would reject a driver's queued fuel logs and inspections for good.

**The web app** (`src/lib/api/client.ts`) sends the token on every write, reading the cookie each time, so a refreshed token is the one used.
A session that began before this was released has no token cookie yet; its first write is refused, the client refreshes (which sets
one) and sends the write again, once. A refusal for the origin is never retried.

The token check is on in every deployment. It is off only under `NODE_ENV=test` (`createApp({ csrfToken })`), where hundreds of tests
make cookie-authenticated calls without it; the CSRF tests turn it on. There is no environment variable that turns it off.

## Rate limits

Requests a minute in fixed windows, by what kind of client sends them (api-contract §20), so a flood from one cannot take the API from the
others:

| Client | Counted by | Default | Config |
|---|---|---|---|
| Signed-in browser | its session (a hash of the access cookie) | 600 | `RATE_LIMIT_SESSION_PER_MINUTE` |
| Uploading (as well) | its session | 30 | `RATE_LIMIT_UPLOAD_PER_MINUTE` |
| A GPS device | its bearer token | 120 | `RATE_LIMIT_DEVICE_PER_MINUTE` |
| A provider's webhook | the provider | 600 | `RATE_LIMIT_WEBHOOK_PER_MINUTE` |
| Nobody signed in | the address | 120 | `RATE_LIMIT_ANONYMOUS_PER_MINUTE` |
| Sign-in, refresh, sign-out, password (as well) | the address | 30 | `RATE_LIMIT_AUTH_PER_MINUTE` |
| Anyone | the address | 3000 | `RATE_LIMIT_IP_CEILING_PER_MINUTE` |

A session is counted by itself, not by address, so an office behind one address is not one client. The ceiling per address is a backstop:
someone sending a made-up cookie on each request gets a new session key every time, but not a new address. Sign-in also has its own
throttle per account and address (docs/auth.md); this is in front of it.

Over a limit: `429 RATE_LIMITED`, `details: [{reason: <policy>}]`, and `Retry-After` in seconds. Every answer carries `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset` for the tightest limit that applies. Health probes are not counted.

Counted in Redis, so the limit holds across instances; when Redis is down, or not configured, in the instance's memory (the limit then
holds per instance, which is looser, never open). A counter that fails lets the request through and is logged: it must not take the API
down. The limits cannot be switched off, only raised.

### The client's address: `TRUST_PROXY`

Behind nginx or a load balancer, the address of every request is the proxy's unless the API is told to read `X-Forwarded-For`. Set
**`TRUST_PROXY` to the number of proxies in front of the API** (1 behind the web app's nginx, which sets the header). Without it the
per-address limits count every client as one, the sign-in throttle does too, and the audit log names the proxy as the source. Never set
it higher than the real number: a client could then choose its own address by sending the header.

## Request size

JSON bodies are limited to 1 MB, uploads to their file's size (10 MB for documents, 2 MB for photos), and any other request that
**announces** more than 12 MB (`Content-Length`) is refused with `413 PAYLOAD_TOO_LARGE` before a byte is read. A body sent in chunks has no
length to read, so the parsers' limits are what stop it. An upload is deliberately not refused up front: its route answers 413 once the
file passes its limit, so the person sees "the file is too large" and not a dropped connection. A client that sends an oversized body to
any 413 may see its connection closed while it is still sending: the server stopped reading.

## Sort and filter allow-lists

A list sorts by a **named column of its own**, never by a column name or SQL the client sends. Each list's schema has a `z.enum` of the
sort keys (`sort_by`, and `then_by` on vehicles), and the query looks the key up in a fixed map of key to column. Anything outside
the enum, a column that exists (`password_hash`) or SQL (`id; DROP TABLE x`), is a `400 VALIDATION_INVALID_ENUM` before it reaches a
query. The direction (`sort_order`) is `asc` or `desc` only. Filters are the same: a list reads the filters it declares, and a query
parameter it does not declare is **ignored**, never turned into SQL.

`test/integration/security-sorting.test.ts` walks every `GET` in `docs/openapi.yaml` with a `sort_by` parameter, so a new sortable list
is covered the day it is documented. For each it checks that values outside the list are 400 (a real column, SQL, an array, a repeated
parameter), that every value the spec declares works, that an undeclared parameter changes nothing, and for vehicles and drivers that
the spec's list and the code's map are the same set. **A new sortable list must declare its values as an `enum` in the spec.**

## Dependency scanning

The `dependency-audit` job (docs/ci.md) audits what is committed, without installing:

- `npm audit` over `package-lock.json`: **fails on a critical advisory**; high and moderate ones are printed for review. A failure is tried
  three times, because npm exits 1 for a registry that answered 5xx as it does for a finding.
- `pip-audit` over `packages/ai-service/requirements.txt`: fails on **any** known vulnerability, because it does not grade them; the
  service has eight pins, so this is a short list to keep clean.

A new advisory can fail an unrelated PR the day it is published; the fix is to update the dependency (`npm audit fix`, or bump the pin).
Advisories that cannot be fixed yet and do not apply are not ignored silently: say so in the PR and add the exception to the job with a
reason. The three high advisories open when this was written (`body-parser` and `multer` denial of service, `zod` memory use on oversized
input) were fixed with it; the moderate ones left need major upgrades (ESLint, react-router) and belong to their own change.

## Secret scanning

The `secrets-scan` job runs gitleaks over the checked-out files with the default rules and `.gitleaks.toml` (weak hard-coded passwords,
literal fallbacks, SQL role passwords). Secrets come from the environment (`.env`, generated by `scripts/init-env.mjs`), never from files.

## Rolling this out

- Set `TRUST_PROXY=1` wherever the API runs behind the web app's nginx or another proxy, **before** relying on the limits.
- A signed-in user's first write after the release is refused once and retried by the app (above); nothing for them to do.
- Run a release with `CSP_MODE=report-only` (the default), check the browser console, then set `enforce`.
- Anything that calls the API from a browser origin other than its own (a separate web host) must be listed in `CORS_ALLOWED_ORIGINS`.
