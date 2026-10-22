# Integration gateway

Card: FMS-85 (SE-129). Code: `packages/backend/src/modules/integration/`. Architecture §15 (every external API behind an adapter), §28.3 (timeouts, retries, circuit breaking), api-contract §15 and §20.

Every call to an outside system, and every webhook from one, goes through this module. A provider that fails or slows down degrades the one feature that uses it, not the API, and a provider can be swapped by writing a new adapter.

## Pieces

| Piece | File | What it does |
|---|---|---|
| Adapter contract | `domain/adapter.ts` | `ProviderAdapter`: `healthCheck`, `sync`, `normalize`, each optional |
| HTTP client | `application/http-client.ts` | The one way to call a provider: timeout per attempt, retries with jitter for idempotent calls, the provider's breaker |
| Circuit breaker | `application/circuit-breaker.ts` | opossum, one per provider per API instance, with its counts and state changes logged |
| Registry | `application/provider-registry.ts` | Adapters registered in code, matched by `code` to rows of `integration.external_providers`; settings and secrets |
| Webhook signatures | `domain/webhook-signature.ts` | HMAC-SHA256 over the timestamp and raw body; 5-minute replay window |
| Service | `application/integration.service.ts` | Provider status, manual sync, webhook receipt; a sync log for each |
| Mock provider | `infrastructure/mock-provider.ts` | A complete adapter used by the tests; the template for a real one |

## Adding a provider

1. **Add the row** in `integration.external_providers`. Give it a `code` (lowercase letters, digits and hyphens: `geotab-et`), its `provider_type`, and its `base_url`. `configuration` holds settings only:
   - `timeout_ms`: each attempt, 10 to 60,000; default 5,000.
   - `max_retries`: extra attempts, 0 to 5; default 2.
   - `reset_timeout_ms`: how long the breaker stays open, 1,000 to 600,000; default 30,000.
   - Anything else is the adapter's own.

   Out-of-range settings are ignored (logged once).
2. **Put its secrets in the environment**, never in the table:
   - `INTEGRATION_<CODE>_WEBHOOK_SECRET`: the shared HMAC key, at least 32 characters;
   - `INTEGRATION_<CODE>_API_KEY`: the outbound credential.

   `<CODE>` is the code in upper case with `_` for `-` (`INTEGRATION_GEOTAB_ET_API_KEY`). Docker Compose passes the backend's variables one by one, so add them to the backend service's `environment` in `docker-compose.yml` (or to the deployment's secret store).
3. **Write the adapter** in the integration module (`infrastructure/<provider>.adapter.ts`) and register it in `index.ts`: `integrationGateway.register(geotabAdapter('geotab-et'))`.
   - Call the provider only through `ctx.client.call({ method, path, ... })`. Paths are relative to `base_url`; an absolute URL or `..` is refused, so the API key cannot leave for another host.
   - Send `ctx.apiKey` the way the provider wants it, and never log it.
   - `normalize(body)` must be pure. Convert units to the system's (integer km/h, millilitres, cents) and pick the provider's event id as `eventId`, the de-duplication key. Throw `WebhookPayloadError(field, reason)` for a body it cannot read.
   A telematics provider needs no adapter of its own if it sends the FMS telematics format ([gps-ingestion.md](gps-ingestion.md)): `registerForType('telematics', fmsTelematicsAdapter)` covers every telematics provider without one. Its devices are registered with `--provider <code>` (`npm run device:register`).
4. **Consume the deliveries.** Subscribe to `IntegrationWebhookReceived` in the module that owns the data (telematics: `integration.telematics-pings`, FMS-88, ingests `positions`). Read the delivery with `webhookDeliveries.find(tx, payload.sync_log_id)`, which returns `{ provider_code, provider_type, kind, occurred_at, data }`. Insert with the business table's own de-duplication key (api-contract §15) and `ON CONFLICT DO NOTHING`, since delivery is at least once.

Another module that calls a provider directly (the mapping adapter, FMS-84) gets the client with `integrationGateway.contextFor(code, correlationId)`.

## Calls: timeouts, retries, breaker

- **Every attempt has a timeout** (`AbortSignal.timeout`), which cancels the request, including a body that stalls. Redirects are refused.
- **Retries only for idempotent calls:** GET, HEAD, PUT, DELETE, or `idempotent: true` on a POST the provider de-duplicates. They are retried only on failures the provider may recover from: a timeout, a network error, 408, 429, 5xx.
  - Backoff before retry *n* is "full jitter", a random time up to `min(2 s, 200 ms × 2ⁿ)`, so clients that failed together do not retry together.
  - A 4xx other than 408 and 429 is the request's fault: it is not retried and does not count against the provider.
- **The breaker** sits under the retries, around each attempt:
  - **Opens:** once its 60-second window holds at least 5 calls and more than half of them failed. 5 failures in a row always open it; after a recent success, 4 out of 5 do. While open, every call fails at once with `ProviderCallError('circuit_open')`, without reaching the provider, and a manual sync answers `503 UPSTREAM_UNAVAILABLE` with `Retry-After`.
  - **Half-open:** after `reset_timeout_ms`, the next call is a trial. Success closes the breaker with a fresh window; failure opens it again.
  - **Logged:** state changes appear as `integration.circuit_opened`, `integration.circuit_half_open` and `integration.circuit_closed`, with the provider's code.
- **Per instance:** each API instance has its own breakers, which is what a breaker protects (its own threads and time). `GET /integrations/providers` shows the instance that answered; `/health/ready` reports this instance's `metrics.integrations` (`providers_called`, `circuits_open`, `circuits_half_open`).
- **Messages are ours:** stored and shown failures read like `GET /sync timed out after 5000 ms.` or `GET /sync answered 503.`. A provider's response body, a query string or a credential is never kept.

## Webhooks

`POST /api/v1/webhooks/telematics/{code}`, `/fuel-card/{code}` and `/ev/{code}` (api-contract §15.1). The provider signs each delivery:

```
X-FMS-Timestamp: 1761040800                    Unix seconds
X-FMS-Signature: sha256=<hex HMAC-SHA256 of "1761040800.<raw body>" with the shared secret>
```

In order, the receiver:

1. **Finds the provider.** It must be an active provider of the path's type, with an adapter that reads webhooks and a secret. Otherwise `404`, the same answer in every case.
2. **Checks the signature** over the exact bytes received (the JSON parser keeps the raw body for `/api/v1/webhooks/` only), in constant time. A missing, malformed or wrong signature is `401 AUTH_TOKEN_INVALID`.
3. **Checks the timestamp** is within 5 minutes of the server clock, either way. A genuine but stale delivery is a replay: `401 AUTH_TOKEN_EXPIRED`. The timestamp is inside the signature, so a replay cannot be given a fresh one.
4. **Reads the body** with the adapter's `normalize`. A body it cannot read is `400 VALIDATION_FAILED` and a failed sync log, which the provider's status shows.
5. **De-duplicates:** a delivery whose event id was seen before is answered `202` with `duplicate: true` and changes nothing. A unique index (migration 031) settles two simultaneous deliveries, and the event has a fixed id.
6. **Stores and announces it:**
   - an inbound sync log (`succeeded`, the event id as `external_reference`, the normalised data in `metadata`);
   - `IntegrationWebhookReceived`, published in the same transaction through the outbox.

   It answers `202` straight away, so a slow consumer never makes the provider retry.

Rejected deliveries are logged (`integration.webhook_rejected`, with the reason) but not stored, so forged traffic cannot fill the table. Every stored row is audited with channel `webhook` and no user.

**Not yet:** the per-provider rate limit of api-contract §20, and a second secret for rotation. Both come with the first real provider.

## Status and sync

- **`GET /integrations/providers`** (`integration:read`: admin, fleet manager): every provider with:
  - `status`: `operational`, `degraded`, `down`, `unknown` or `inactive`;
  - `capabilities` from its adapter, and whether a webhook secret is set;
  - `last_success_at`, `last_failure_at` and `last_error`, from the sync logs;
  - `last_sync`;
  - this instance's `circuit`: state, `opened_at`, `retry_at`, the window's counts, mean latency;
  - `health`.

  `configuration` and secrets are never returned. `?check=true` first runs each active provider's health check, 5 s at most.
- **`POST /integrations/providers/{id}/sync`** (`integration:execute`): records a `started` sync log and answers `202` at once. The sync runs after the response and completes the log as `succeeded`, `partial` or `failed`, with the record count and the provider's batch reference.
  - A second request while one runs gets the running one (`meta.already_running`).
  - A sync still `started` after 15 minutes is taken as lost (its instance stopped), and a new one may start.

## Tests

- **Unit:**
  - `circuit-breaker.test.ts`: closed to open on the 5th timeout, fail fast, half-open, close with a clean window, reopen on a failed trial, 404s never open it;
  - `http-client.test.ts`: retries, jitter, no retry for POST or 4xx, timeouts, the breaker opening;
  - `webhook-signature.test.ts`.
- **Integration:** `test/integration/integrations.test.ts`. The provider runs locally (`test/support/mock-provider-server.ts`) and can be told to be slow, fail or hang. It covers the status endpoint, sync, the 5 timeouts that open the breaker, and webhook signature, replay and duplicate handling. The test secrets for the code `mock-telematics` come from `test/support/test-env.ts`.
