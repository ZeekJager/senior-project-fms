# Telematics provider slot and device onboarding

Card: FMS-138 (SE-182). Code: `packages/backend/src/modules/integration/` (`application/device.service.ts`, `api/device.routes.ts`), `scripts/simulate-gps.ts`, the screen `packages/frontend/src/pages/Telematics/` (S-34). Migration 061. Builds on the integration gateway ([integrations.md](integrations.md), FMS-85) and GPS ingestion ([gps-ingestion.md](gps-ingestion.md), FMS-88).

Positions come from the GPS simulator and the driver app today. The day a telematics provider is contracted, its trackers should go live without changes to tracking, the live map, trip tracks or the telemetry rules: **configuration only** when the provider speaks the FMS format, and **one adapter file** otherwise.

## How a position gets in

```
provider ──signed webhook──▶ POST /api/v1/webhooks/telematics/{code}
                               │ signature, replay window, adapter's normalize, de-duplication
                               ▼
                     integration.sync_logs (inbound) + IntegrationWebhookReceived
                               │ consumer integration.telematics-pings
                               ▼
              device registry: device_id ──▶ vehicle   (unlinked: refused, noted as unknown)
                               ▼
              tracking.gps_pings ──▶ current location ──▶ live map, trip track, telemetry rules
```

The simulator takes the same path: it is a provider (`fms-simulator`) and posts the same signed webhooks.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| The provider | a row of `integration.external_providers` | `code` (its webhook path and secret names), `provider_type = 'telematics'`, `is_active` |
| Its secret | `INTEGRATION_<CODE>_WEBHOOK_SECRET` in the environment | The HMAC key it signs with, 32 characters or more. Never in the database or GitHub |
| Its adapter | `fmsTelematicsAdapter` for every telematics provider, unless one is registered for its code | Reads the body into `{ event_id, positions: [{ device_id, recorded_at, lat, lng, speed_kmh, ... }] }` |
| The device registry | `integration.gps_devices`, `GET/POST/DELETE /integrations/devices`, S-34 | Which of the provider's device ids reports for which vehicle |
| Unknown devices | `integration.unknown_devices`, `GET /integrations/devices/unknown` | Ids its signed deliveries named that no vehicle has, so they can be linked |
| Today's counts | `integration.webhook_daily_counts`, on `GET /integrations/providers` | Deliveries stored and refused, positions stored and refused, per Addis Ababa day |

## Connecting a real telematics provider

### 1. The provider speaks the FMS format: configuration only

The provider (or its webhook builder) posts to `https://<host>/api/v1/webhooks/telematics/<code>`:

```json
{ "event_id": "batch-8812",
  "positions": [ { "device_id": "356307042441013", "recorded_at": "2026-11-05T09:00:00+03:00",
                   "lat": 9.0108, "lng": 38.7613, "speed_kmh": 42.6,
                   "heading": 90, "accuracy_m": 6, "ignition_on": true, "odometer_km": 123456.7 } ] }
```

with `X-FMS-Timestamp` (Unix seconds) and `X-FMS-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`. At most 500 positions per delivery; `event_id` unique per delivery (a redelivery under the same id is a no-op).

1. **Add the row** (an admin with database access; there is no screen for it):
   ```sql
   INSERT INTO integration.external_providers (code, name, provider_type, is_active, configuration)
   VALUES ('geotab-et', 'Geotab Ethiopia', 'telematics', TRUE, '{}');
   ```
2. **Give it its secret**, generated once and shared with the provider by a secure channel:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Put it in the server's environment as `INTEGRATION_GEOTAB_ET_WEBHOOK_SECRET` (and in `docker-compose.yml`'s backend `environment`, which passes variables one by one), then restart the API.
3. **Point the provider at the URL** and let it send. Its devices appear under *Sending, not linked* on S-34.
4. **Link each device** to its vehicle on S-34 (*Link*), or before it sends (*Link device*). Its next position is on the live map.

### 2. The provider has its own format: one adapter file

Copy the template, `infrastructure/mock-provider.ts` (a complete adapter: health check, sync, `normalize`), to `infrastructure/<provider>.adapter.ts` and keep what a webhook-only provider needs, `normalize`:

```ts
export function geotabAdapter(code: string): ProviderAdapter {
  return {
    code,
    normalize(body) {
      const parsed = geotabBody.safeParse(body);                       // the provider's own shape, in zod
      if (!parsed.success) throw new WebhookPayloadError(parsed.error.issues[0].path.join('.') || 'body', 'invalid');
      const positions = parsed.data.records.map((r) => ({
        device_id: r.device.serial,                                    // the id you link on S-34
        recorded_at: r.dateTime,                                       // ISO with an offset
        lat: r.latitude, lng: r.longitude,
        speed_kmh: r.speed,                                            // km/h; convert knots or m/s here
      }));
      return { eventId: parsed.data.batchId, kind: POSITIONS_KIND, occurredAt: new Date(), data: { positions } };
    },
  };
}
```

Register it in `integration/index.ts` (`registry.register(geotabAdapter('geotab-et'))`; a code's own adapter wins over the FMS format). `normalize` must be pure. Then steps 1 to 4 above. If the provider signs differently (another header, no timestamp), the signature check in `IntegrationService.receiveWebhook` is the one place to extend.

### 3. Traccar, or a provider that cannot sign: a relay

A [Traccar](https://www.traccar.org/) server (self-hosted, speaks most tracker protocols) can forward positions to a URL (`forward.enable`, `forward.url` and `forward.json` in `traccar.xml`; check the keys and the JSON against your Traccar version). It cannot sign each request with a timestamped HMAC, so run a small relay next to it that receives Traccar's JSON, converts it to the FMS format and signs it:

```js
// relay.mjs: Traccar position forwarding -> FMS telematics webhook. Node 18+.
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
const url = process.env.FMS_URL;                        // https://<host>/api/v1/webhooks/telematics/traccar
const hmacKey = process.env.FMS_HMAC_KEY;               // the provider's shared key, from the relay's environment
createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const { position: p, device: d } = JSON.parse(raw);
  const body = JSON.stringify({ event_id: `traccar-${p.id}`, positions: [{
    device_id: d.uniqueId, recorded_at: p.fixTime, lat: p.latitude, lng: p.longitude,
    speed_kmh: p.speed * 1.852,                         // Traccar reports knots
    heading: p.course, ignition_on: p.attributes?.ignition ?? null }] });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', hmacKey).update(`${ts}.${body}`).digest('hex');
  const out = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-fms-timestamp': String(ts), 'x-fms-signature': `sha256=${sig}` } });
  res.writeHead(out.status === 202 ? 200 : 502).end();
}).listen(8082, '127.0.0.1');
```

The relay holds the shared key (`FMS_HMAC_KEY`, the same value as the server's `INTEGRATION_TRACCAR_WEBHOOK_SECRET`): run it on the Traccar host, listening on localhost only. Traccar's device `uniqueId` (usually the IMEI) is the id to link on S-34. Then steps 1 to 4 with the code `traccar`.

### Checklist

- [ ] Provider row added: `code` in lowercase letters, digits and hyphens; `provider_type` `telematics`; `is_active` true.
- [ ] `INTEGRATION_<CODE>_WEBHOOK_SECRET` set on the server (32+ characters), passed by `docker-compose.yml`, API restarted. S-34 no longer says *No webhook secret*.
- [ ] Not committed anywhere: the secret lives only in the server's environment (or secret store) and the provider's side.
- [ ] The provider's format: the FMS format, or an adapter registered for its code (with a unit test of its `normalize` on a real sample body).
- [ ] Units: speed in km/h, times ISO 8601 with an offset, odometer in km.
- [ ] First delivery received: S-34 shows *Receiving* and a last delivery. *Refused today* deliveries mean the secret or the provider's clock (the 5-minute window) is wrong.
- [ ] Each device linked to its vehicle; *Sending, not linked* is empty.
- [ ] A linked vehicle moves on the live map; its trip track (S-22) fills in.
- [ ] Devices that went in with a token (`npm run device:register`) and now report through the provider: unlink them, or link the provider's id with *Replace*.

## The device registry

- **List** (`integration:read`, admin and fleet manager): every device of the vehicles in the caller's depot scope, provider devices and token devices (`credential`), with last seen and the last refused reason (`too_old`, `future_timestamp`, `low_accuracy`, `vehicle_retired`). Never a token or its hash.
- **Link** (`integration:execute`): a provider's device id to a vehicle. A vehicle has one active device: linking another is refused (`409 vehicle_has_device`) unless `replace`, which takes the first out of service. The same id again moves the device. Identifiers are unique across the fleet (`409 already_exists` for another provider's or a token device's). Audited with the user.
- **Unlink**: the device is kept as `removed` with its pings; its positions are refused from then on (and noted as unknown again), a token device's token stops working. Audited.
- **Unknown devices**: noted only from signed deliveries, so forged traffic cannot add any; 1,000 kept per provider at most. Linking one removes it.

Both permissions belong to admins and fleet managers, who see every depot, so in practice the registry is fleet-wide; the depot scope applies if a depot-scoped role is ever given them.

## The status panel

`GET /integrations/providers` gains, for each provider:

- `last_delivery_at`: when its last delivery was stored;
- `today`: `deliveries`, `deliveries_rejected` (a wrong signature, a replay, a body its adapter cannot read), `positions_accepted` (stored, or already stored), `positions_rejected` (an unlinked device, too old, in the future, imprecise, a retired vehicle), since midnight in Addis Ababa;
- `devices`: a telematics provider's `linked` and `unknown` counts.

A refused delivery is counted but not stored (`integration.webhook_rejected` in the log says why), so a wrong secret shows on S-34 without the table filling up. The circuit is the gateway's breaker on this API instance: a provider that only sends webhooks is never called, so it reads *Not called*.

## The simulator

```bash
npm run simulate:gps -w packages/backend                              # as the provider fms-simulator, 200 vehicles
npm run simulate:gps -w packages/backend -- --provider geotab-et       # as a real provider, with its secret: tests its slot
npm run simulate:gps -w packages/backend -- --via device               # the old path: each vehicle's own token
```

- **As a provider (default):** each vehicle's simulated device `sim-<provider>-<vehicle id>` is linked in the registry (replacing the vehicle's device), and once a second the positions due are posted as one signed delivery to `/webhooks/telematics/<provider>`: the path, signature and format a real provider uses (`scripts/simulator/delivery.ts`). It signs with `INTEGRATION_<PROVIDER>_WEBHOOK_SECRET` from the same environment as the API.
- **`fms-simulator`:** added switched off by migration 061, so a production database never has it on; the simulator, which refuses `NODE_ENV=production`, switches it on. Its secret is in `.env.example` as `change-me`, so `make env` generates one (an existing `.env` gets it on the next `make env`). Leave it out of a production environment.
- The end-of-run check waits up to 15 s for the consumer, then counts the vehicles whose location moved.

## Security

- Secrets only in the environment, never in the database, the API's answers or GitHub; S-34 shows only whether one is set.
- Signed webhooks only; refused ones are counted, never stored.
- Admins and fleet managers only (`integration:read`, `integration:execute`); every link and unlink is in the audit log with the user.
- Device tokens are never returned by the registry; only their hashes are stored (FMS-88).

## Tests

- Integration, `test/integration/telematics.test.ts`: the simulator's signed webhook lands as pings on the linked vehicle and is counted; an unlinked device is refused, counted and listed as unknown, and lands once linked; a forged and a replayed delivery are refused and counted; the provider switched off answers 404; linking rules (replace, moving, another provider's id, not telematics, retired, spaces); unlinking (audited, kept, refused after, again); a device's last error; token devices listed without their token; permissions. Every response against the OpenAPI spec.
- Unit: `scripts/simulator/delivery.test.ts` (batches, event ids, signature).
- Screen, `pages/Telematics/TelematicsPage.test.tsx`: the providers and devices, linking an unknown device, replacing a vehicle's device, a taken id, unlinking and the unlinked view, read-only, empty and failed states; `describe.test.ts` for the wording.
