# Deployment: TLS, the reverse proxy, two API instances (FMS-106) and the runbook (FMS-164)

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

## Deploying to a server (runbook, FMS-164)

A first deployment, step by step, on one Ubuntu 24.04 server running `docker-compose.prod.yml`. Each phase ends
with what to check before going on. Commands run as the deploy user in the checkout (`~/fms`) unless they say
otherwise. A machine with no public IP (at home, behind a router you do not control) uses a Cloudflare Tunnel
instead of DNS records and open ports: [Behind a Cloudflare Tunnel](#behind-a-cloudflare-tunnel).

### 1. Decide

| Decision | Default | Notes |
|---|---|---|
| Server | 4 vCPU, 8 GB RAM, 80 GB SSD | PostgreSQL, two API instances, the AI service and OSRM (about 1.5 GB of map in memory) |
| Domain | `fleet.<client>.et` | A name whose DNS you control |
| Let's Encrypt e-mail | an operations mailbox | Expiry notices; `FMS_TLS_ISSUER` |
| Release | a tag on `master`, CI green | `vX.Y.Z`; its short hash is `FMS_IMAGE_TAG` |
| Alert channels | e-mail and SMS providers, a Teams channel | Their secrets go in `api.env` ([notification-channels.md](notification-channels.md)) |
| Off-server backup storage | an S3 bucket, or an rclone remote | Never this server's disk alone |

### 2. Release

Before a release reaches production: UAT signed off by every role, the release checklist green and a go/no-go
decision ([release.md](release.md), FMS-112).

1. Merge to `master` and wait for CI to go green ([ci.md](ci.md)).
2. Tag it: `git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0`.
3. Note the short hash, `git rev-parse --short=7 v1.0.0`: that is `FMS_IMAGE_TAG`.

### 3. The server

As root, once:

```sh
adduser --disabled-password --gecos "" fms && usermod -aG sudo fms
install -d -m 700 -o fms -g fms /home/fms/.ssh
cp ~/.ssh/authorized_keys /home/fms/.ssh/ && chown fms:fms /home/fms/.ssh/authorized_keys
# SSH keys only, no root login
sed -i -E 's/^#?(PasswordAuthentication|PermitRootLogin) .*/\1 no/' /etc/ssh/sshd_config && systemctl restart ssh
ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
apt-get update && apt-get install -y unattended-upgrades fail2ban git openssl
timedatectl set-timezone Africa/Addis_Ababa
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
curl -fsSL https://get.docker.com | sh && usermod -aG docker fms
# Container logs capped: 10 MB x 3 files per container
echo '{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }' > /etc/docker/daemon.json
systemctl restart docker
```

Check: `ssh root@<server>` is refused, `ssh fms@<server>` works, `ufw status` lists 22, 80 and 443 only, and
`docker compose version` is v2.

Docker publishes ports through its own firewall rules, past ufw. That is why only Caddy publishes any (80 and 443)
and every other service is on the internal network.

### 4. DNS

An `A` record (and `AAAA` if the server has IPv6) for the domain to the server's address. Optionally a `CAA`
record that allows only `letsencrypt.org`. Check it resolves before the first start: a certificate request that
fails is rate-limited by Let's Encrypt.

```sh
dig +short fleet.example.et        # the server's address
```

### 5. The images

There is no registry yet: build them on the server from the tag, as CI does ([production-images.md](production-images.md)).

```sh
git clone https://github.com/<org>/senior-project-fms.git ~/fms && cd ~/fms && git checkout v1.0.0
T=$(git rev-parse --short=7 HEAD)
docker build -f packages/backend/Dockerfile -t fms-backend:$T .
docker build -f packages/frontend/Dockerfile -t fms-frontend:$T .
docker build -t fms-ai-service:$T packages/ai-service
```

### 6. Configuration

```sh
scripts/deploy/init-prod-env.sh fleet.example.et ops@example.et "$T"
```

It writes `prod.env` from `prod.env.example`, with a fresh 48-character secret for each `change-me`, readable by
its owner only (600). It refuses to touch an existing `prod.env`. Then:

- Add `COMPOSE_FILE=docker-compose.prod.yml:docker-compose.routing.yml` to `prod.env`, so every command below uses
  both files. With the tunnel, add `:docker-compose.tunnel.yml`. On Windows the separator is `;`.
- **Copy `DATA_ENCRYPTION_KEY` off the server now**, into the client's password manager. Without it the licence
  and phone numbers already stored cannot be read, and it cannot be changed later.
- Other backend settings go in `api.env` (also 600, also git-ignored): the backup role (phase 9), S3
  (`STORAGE_DRIVER=s3` and its settings), the alert providers' secrets and `SENTRY_DSN`. `.env.example` lists them.

### 7. Road routing

Once per server, and again to refresh the map ([below](#road-routing-in-production)). These steps run outside the
stack, which has no route out:

```sh
docker volume create fms_osrm_data
docker compose --env-file prod.env --profile routing-setup run --rm osrm-download   # Ethiopia, checked against its MD5
docker compose --env-file prod.env --profile routing-setup run --rm osrm-prepare    # the car graph: minutes, about 2 GB RAM
```

### 8. First start

```sh
docker compose --env-file prod.env up -d --wait
docker compose --env-file prod.env ps -a        # migrate exited (0); every other service running and healthy
```

`migrate` runs the migrations as the schema owner and exits. Then the API instances start, then the web app, then
Caddy, which gets the certificate on its first request: `docker compose --env-file prod.env logs caddy` shows
`certificate obtained successfully`.

Then the first administrator. The password is printed once (or set `FMS_USER_PASSWORD`):

```sh
docker compose --env-file prod.env exec api-1 \
  node dist/scripts/create-user.js --email you@example.et --name "Your Name" --role admin
```

**No demo seed in production**: the seed refuses `NODE_ENV=production`. The administrator enters the real data in
the app: depots, users and their roles, vehicles, drivers, routes, service programmes and the alert providers'
rows. Demo data belongs on a separate demo or staging install.

### 9. Backups

pg_dump has to read every table, and the app's role may not. Create a read-only role for it, as the schema owner:

```sh
docker compose --env-file prod.env exec postgres psql -U fms_admin -d fms_db \
  -c "CREATE ROLE fms_backup LOGIN" -c "GRANT pg_read_all_data TO fms_backup" -c "\password fms_backup"
```

Put `BACKUP_DB_USER=fms_backup` and its `BACKUP_DB_PASSWORD` in `api.env`, then recreate the API instances so
they read it: `docker compose --env-file prod.env up -d --wait --force-recreate api-1 api-2`.

- **Back up now** on the Backups screen succeeds and shows its size ([backups.md](backups.md)).
- **Off the server.** With `STORAGE_DRIVER=s3` the nightly backups (02:40) are in the bucket already. With local
  storage, copy the `uploads` volume's `backups/` folder to the off-server remote every night with rclone.
- **Rehearse a restore** into a separate database. A restore creates a database, which the backup role may not
  do, so this one command runs as the schema owner:

  ```sh
  DB_ADMIN_PASSWORD=$(grep '^DB_ADMIN_PASSWORD=' prod.env | cut -d= -f2-)
  docker compose --env-file prod.env run --rm --no-deps \
    -e BACKUP_DB_USER=fms_admin -e BACKUP_DB_PASSWORD="$DB_ADMIN_PASSWORD" \
    api-1 node dist/scripts/backup-restore.js --backup latest --database fms_restored
  ```

  It checks the file's SHA-256 before restoring. Compare a few counts with the live database, then
  `DROP DATABASE fms_restored`.

### 10. Verify

| Check | How | Expected |
|---|---|---|
| HTTP redirects | `curl -sI http://<domain>/` | `308`, `Location: https://<domain>/` |
| HSTS | `curl -sI https://<domain>/` | `Strict-Transport-Security: max-age=31536000; includeSubDomains` |
| The API through the proxy | `curl -s https://<domain>/api/v1/auth/me` | `401`, `AUTH_TOKEN_INVALID` |
| Containers | `docker compose --env-file prod.env ps -a` | all healthy, `migrate` exited 0 |
| TLS grade | <https://www.ssllabs.com/ssltest/> on the domain | A or better ([SSL Labs](#ssl-labs)) |
| Open ports | `sudo ss -tlnp` on the server, `nmap <server>` from outside | 22, 80 and 443 only |
| Routing | [Road routing in production](#road-routing-in-production) | a new route has `distance_source: road` |
| The golden path | by hand, as the administrator | sign in, add a vehicle and a driver, schedule a trip, see it on the dispatch board |
| Failover (optional) | `docker compose --env-file prod.env stop api-1`, use the app, then `start api-1` | the app keeps working |

### 11. Monitoring

- An external uptime check on `https://<domain>/` and `https://<domain>/health/ready`.
- A disk alert at 80% on the server: PostgreSQL, the backups and the map all live there.
- `SENTRY_DSN` in `api.env` for the API's errors ([observability.md](observability.md)).
- Optional: the metrics and dashboards of `docker-compose.observability.yml`.

### 12. Releases and rollback

A release:

1. Take a backup (Back up now), and note the running tag: `grep FMS_IMAGE_TAG prod.env`.
2. `git fetch --tags && git checkout vX.Y.Z`, then build the three images for its hash (phase 5).
3. Set `FMS_IMAGE_TAG` to the new hash in `prod.env`.
4. `docker compose --env-file prod.env up -d --wait`. `migrate` runs the new migrations first, then the services
   whose image changed are recreated.
5. Verify: phase 10's first four rows, and `sh scripts/deploy/release-check.sh` with no FAIL ([release.md](release.md)).

A rollback is the same with the previous tag: set `FMS_IMAGE_TAG` back and run `up -d --wait`. The previous images
are still on the server. If the release ran a migration the old code does not expect, restore the backup of step
1 instead (phase 9, then switch `DB_NAME`: [backups.md](backups.md#restoring-runbook)). Migrations' Down steps are
for development, not for a live rollback.

### 13. After launch

- Switch `CSP_MODE` from `report-only` to `enforce` once a week of reports shows nothing the app needs is blocked
  ([security.md](security.md)).
- Review who has access, and remove accounts that are not needed.
- Monthly: a restore drill (phase 9), `sudo apt-get upgrade` in a maintenance window, and a check that the
  off-server backups are arriving.

### Locally

`FMS_DOMAIN=localhost` and `FMS_TLS_ISSUER=internal` give a certificate from Caddy's own authority. Browsers do not
trust it. To trust it for the run, copy its root out of the container:

```sh
docker compose -f docker-compose.prod.yml cp caddy:/data/caddy/pki/authorities/local/root.crt .
```

### Behind a Cloudflare Tunnel

For a server with no public IP or no ports open to the internet, such as a machine at home. `cloudflared` dials out
to Cloudflare, which serves the site's HTTPS and forwards each request down the tunnel to Caddy. Nothing listens on
the internet, and the DNS record is Cloudflare's, not the server's. The domain's DNS must be on Cloudflare.

1. In Cloudflare's Zero Trust dashboard (Networks, Tunnels), create a `cloudflared` tunnel and copy its token (the
   long value after `--token` in the install command). Put it in `prod.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
   **Do not run the install command itself on the server**: it installs a second connector on the host, which
   cannot reach `caddy:443`. Cloudflare then sends part of the traffic to it, and those requests fail with `502`.
   A token copied before the dashboard refreshed it is refused (`Invalid tunnel secret` in the `cloudflared` log):
   copy it again.
2. Give the tunnel a public hostname (published application route): the site's host name, service **HTTPS**,
   URL `caddy:443`. Under its TLS settings set **Origin Server Name** to the host name and turn **No TLS Verify** on:
   Caddy's certificate is from its own authority, on the stack's own network.
3. In the domain's **SSL/TLS, Edge Certificates** settings: turn **Always Use HTTPS** on and set **Minimum TLS
   Version** to **1.2**. Through the tunnel, Cloudflare answers the visitor, not Caddy: without the first, a plain
   `http://` request is served unencrypted instead of redirected; without the second, Cloudflare still accepts
   TLS 1.0 and 1.1, and SSL Labs grades the site B. Both apply to the whole zone.
4. In `prod.env`: `FMS_DOMAIN` is that host name and `FMS_TLS_ISSUER=internal`. Let's Encrypt cannot reach Caddy
   through the tunnel, and does not need to: browsers see Cloudflare's certificate.
5. Start it with the tunnel's file as well:

   ```sh
   docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file prod.env up -d --wait
   ```

   or, with `COMPOSE_FILE` in `prod.env` naming the tunnel's file (phase 6), `docker compose --env-file prod.env up -d --wait`.

The visitor's address still reaches the API (the audit log and the per-address sign-in limits need it). Cloudflare
puts it in `X-Forwarded-For`, Caddy keeps it because the connector, at its fixed address `172.30.0.250`, is its one
trusted proxy (`FMS_TRUSTED_PROXIES`), and the API trusts two hops (`TRUST_PROXY=2`). A client that sends its own
`X-Forwarded-For` only adds to the left of the list, which the API does not read. The tunnel's file gives the `edge`
network a fixed subnet (`172.30.0.0/24`): an existing stack is taken down (`down`, keeping the volumes) before it is
first started with the file.

## Road routing in production

Road routing (FMS-84, [routing.md](routing.md)) measures routes by road, gives trips under way their arrival times
and suggests a route's stop order (FMS-86, [eta.md](eta.md)). Without it, routes keep the distance typed in and
trips get no ETA. `docker-compose.routing.yml` adds it to the production stack:

- **OSRM** (`osrm-backend` v5.27.1, the same version as development) on the internal `data` network only: no
  published port, no route out, the map mounted read-only. A health check asks it for a route across Addis Ababa.
- **`ROUTING_URL=http://osrm:5000`** for both API instances.
- **The map** in the external volume `fms_osrm_data`, which `down -v` never deletes. It is built once by the two
  `routing-setup` steps (phase 7), on a network of their own with a route out: the download from Geofabrik,
  checked against its MD5, then the MLD car graph. Each step skips work already done.

**Check.** From an API instance, then through the app:

```sh
docker compose --env-file prod.env exec api-1 \
  wget -qO- "http://osrm:5000/route/v1/driving/38.7578,9.0108;38.7469,9.0300?overview=false"   # "code":"Ok"
```

A route saved with both ends then has `distance_source: road` and a `measured_at`, and its road shows on the
map. A trip under way gets its `eta` (arrival, distance and time left) a few seconds after its vehicle's first
position.

**Refreshing the map** (OpenStreetMap changes; every few months):

```sh
docker volume create fms_osrm_next
docker run --rm -v fms_osrm_next:/data curlimages/curl:8.10.1 sh -c \
  'cd /data && curl -fsSLO https://download.geofabrik.de/africa/ethiopia-latest.osm.pbf && curl -fsSLO https://download.geofabrik.de/africa/ethiopia-latest.osm.pbf.md5 && md5sum -c ethiopia-latest.osm.pbf.md5'
docker run --rm -v fms_osrm_next:/data ghcr.io/project-osrm/osrm-backend:v5.27.1 sh -c \
  'cd /data && osrm-extract -p /opt/car.lua ethiopia-latest.osm.pbf && osrm-partition ethiopia-latest.osrm && osrm-customize ethiopia-latest.osrm'
docker compose --env-file prod.env stop osrm
docker run --rm -v fms_osrm_next:/from -v fms_osrm_data:/to alpine sh -c 'rm -rf /to/* && cp -a /from/. /to/'
docker compose --env-file prod.env start osrm && docker volume rm fms_osrm_next
```

The new graph is built beside the live one, so routing is off only for the copy (seconds). While OSRM is
down, routes save with the distance typed in, and the hourly `route-roads` job measures them once it is back.

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
