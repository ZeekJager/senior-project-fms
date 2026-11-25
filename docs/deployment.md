# Deployment: TLS, the reverse proxy and two API instances (FMS-106)

Card FMS-106 (SE-150), architecture §25 (communication security), §28.1 and §30 (scalability), NFR-8. The production
stack, `docker-compose.prod.yml`, runs the production images ([production-images.md](production-images.md)) behind
Caddy, which terminates TLS. Why Caddy: [ADR-12](adr/ADR-12-edge-caddy.md).

```text
                 :80 (redirect only)   :443 (HTTPS, WSS)
 browser ─────────────────────► caddy ──────────────────────┐
                                  │ /api/*  (cookie fms_lb)  │ everything else
                          ┌───────┴───────┐                  ▼
                          ▼               ▼                 web (nginx, the built app)
                        api-1           api-2
     edge network ────────┼───────────────┼─────────────────────────────────────────
     data network         │   (internal)  │
                          ▼               ▼
              postgres     redis     ai-service      (migrate: once, before api-1 and api-2)
```

## What it gives

| The card asks | How |
|---|---|
| HTTPS and WSS | Caddy terminates TLS for the site and its Socket.IO socket (`/api/v1/socket.io`); WebSocket upgrades pass through. |
| Let's Encrypt certificates | Caddy gets and renews the certificate for `FMS_DOMAIN` by itself (ACME), with `FMS_TLS_ISSUER` as the account's e-mail. Certificates live in the `caddy_data` volume. |
| HTTP redirects to HTTPS | Port 80 answers every request with `308` to the same URL on `https://`, except Let's Encrypt's challenge. |
| HSTS | `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every response, the API's included (it replaces the API's own six months). |
| TLS 1.2 or later | `protocols tls1.2 tls1.3`. Caddy's cipher suites are forward-secret AEAD only, and HTTP/2 is on. |
| Two app replicas | `api-1` and `api-2`, the same image and settings. Caddy sends each new browser to one of them and keeps it there with the `fms_lb` cookie, which Socket.IO's long-polling needs. |
| Killing one instance keeps the site up | Caddy checks `/health/ready` on each every 5 s, stops sending to one that fails (or that it cannot reach) for 30 s, and retries a request that could not reach an instance on the other, within 10 s. A browser whose cookie named the dead instance moves to the live one. |
| Internal-only network for the database, Redis and ML | The `data` network is `internal`: no published port and no route out. PostgreSQL, Redis and the AI service are only on it; the API instances are on it and on `edge`. Only Caddy publishes ports. |

Running twice is safe for the API: jobs claim each run in the database ([jobs.md](jobs.md#running-once-across-instances)),
the outbox relay runs on one instance at a time under an advisory lock ([events.md](events.md#the-relay)), rate limits
count in Redis ([security.md](security.md#rate-limits)), and Socket.IO joins the instances through Redis
([realtime.md](realtime.md)). Uploaded documents are on a volume both instances mount (`uploads`), or in S3.

## Running it

On a server whose DNS name points at it, with ports 80 and 443 open to the internet:

1. Build or pull the images of one commit ([production-images.md](production-images.md)).
2. Copy `prod.env.example` to `prod.env` and fill it in: the host name, the e-mail for Let's Encrypt, the images' tag
   and a fresh secret for each password and key. `prod.env` is git-ignored; keep `DATA_ENCRYPTION_KEY` somewhere off
   the server as well.
3. Any other backend setting from `.env.example` (S3, mail and SMS providers, retention) goes in `api.env` next to the
   compose file, also git-ignored.
4. Start it:

   ```sh
   docker compose -f docker-compose.prod.yml --env-file prod.env up -d
   ```

   `migrate` runs the migrations as the schema owner and exits; then the two API instances start, then the web app,
   then Caddy, which asks Let's Encrypt for the certificate on its first request.
5. Create the first administrator. Without `FMS_USER_PASSWORD` the script generates the password and prints it once:

   ```sh
   docker compose -f docker-compose.prod.yml --env-file prod.env exec api-1 \
     node dist/scripts/create-user.js --email you@example.com --name "Your Name" --role admin
   ```

A release: change `FMS_IMAGE_TAG` and run step 4 again. Compose recreates the containers whose image changed, after
`migrate` has run.

### Locally

`FMS_DOMAIN=localhost` and `FMS_TLS_ISSUER=internal` give a certificate from Caddy's own authority. Browsers do not
trust it. To trust it for the run, copy its root out of the container:

```sh
docker compose -f docker-compose.prod.yml cp caddy:/data/caddy/pki/authorities/local/root.crt .
```

## Tested

`scripts/ci/smoke-tls.sh <tag>` starts the stack for `localhost` and checks every row above. CI runs it in the
`production-images` job, after the image smoke run ([ci.md](ci.md)):

- `http://` answers `308` to the same path on `https://`.
- The certificate verifies for the host; TLS 1.2 and 1.3 handshake, and the server refuses TLS 1.1.
- HSTS on the web app and on the API.
- The web app, the API (`401` without a session) and a WebSocket to Socket.IO (`101`) through the proxy.
- 20 new browsers are spread over both instances, and a browser with its cookie stays on its instance.
- `api-1` is killed after 10 rounds of 40: 160 requests (both instances' cookies, a new browser, the web app), none
  failed. `api-1` is then started again and takes new browsers.
- Only Caddy publishes ports, the `data` network is internal, and the AI service, on it alone, cannot open a
  connection to the internet.

### SSL Labs

The card's test is an SSL Labs grade of A, which needs the site on a public name. After a deployment, run
<https://www.ssllabs.com/ssltest/> on `FMS_DOMAIN`. What the grade looks at is fixed here: TLS 1.2 and 1.3 only,
forward-secret AEAD ciphers (Go's defaults), a full certificate chain from Let's Encrypt, and HSTS for a year,
which makes it A+ when nothing else is wrong. CI checks the protocol floor and HSTS; the grade itself is checked by
hand after each change to `docker/caddy/Caddyfile`.

## Limits

- One PostgreSQL server in this file. For the standby, failover and backups of [disaster-recovery.md](disaster-recovery.md),
  point `DB_HOST` at that pair's `db-proxy`.
- One Caddy. A second host would need a floating address or a load balancer in front, as the database endpoint does
  (ADR-08).
- A request already on its way to an instance when it dies can fail; the browser's next one goes to the other.
