# Diagnostic trouble codes from telematics

Card: FMS-132 (SE-176). Code: `packages/backend/src/modules/integration/` (`domain/diagnostics.ts`, `application/diagnostics.service.ts`, `infrastructure/diagnostic.repository.ts`), the alert rule in `alert/domain/rules.ts`, `scripts/simulate-gps.ts --faults`. Migration 088.

GPS position and speed say little about a vehicle's mechanical health. Engine fault codes do. They are OBD-II codes on light vehicles and J1939 on trucks and buses, and telematics providers deliver them. This feature receives them, keeps each one while it is active, and alerts the workshop once per code.

## How a code gets in

```text
provider ──signed webhook──▶ POST /api/v1/webhooks/telematics/{code}
                               │ signature, replay window, adapter, de-duplication by event id
                               ▼
                     integration.sync_logs + IntegrationWebhookReceived
                               │ consumer integration.telematics-diagnostics
                               ▼
              device registry: device_id ──▶ vehicle   (unlinked: counted as an unknown device)
                               ▼
              tracking.diagnostic_codes ──▶ VehicleFaultDetected ──▶ vehicle_fault alert
                                        ──▶ VehicleFaultCleared  ──▶ the alert closes
```

It uses the same path, signature and device registry as positions ([telematics.md](telematics.md)). A delivery can carry positions, codes, or both.

## The webhook format

The FMS telematics format gains `diagnostics`. Either list may be left out, but not both: a delivery with neither is `400` naming `positions`.

```json
{
  "event_id": "evt-20261127-0001",
  "positions": [{ "device_id": "FMB920-0042", "recorded_at": "2026-11-27T08:00:00+03:00", "lat": 9.01, "lng": 38.76, "speed_kmh": 42 }],
  "diagnostics": [
    { "device_id": "FMB920-0042", "protocol": "obd2", "code": "P0217", "status": "active", "observed_at": "2026-11-27T08:00:00+03:00" },
    { "device_id": "FMB920-0042", "protocol": "j1939", "spn": 110, "fmi": 0, "status": "cleared", "observed_at": "2026-11-27T08:00:00+03:00" }
  ]
}
```

| Field | Rule |
|---|---|
| `protocol` | `obd2` or `j1939` |
| `code` (OBD-II) | SAE J2012: one of `P`, `C`, `B` or `U`, then `0`-`3`, then three hexadecimal characters, in capitals (`P0217`) |
| `spn`, `fmi` (J1939) | The suspect parameter (0-524,287) and failure mode (0-31). The row's code is `SPN-FMI` (`110-0`) |
| `status` | `active` (the vehicle reports it) or `cleared` (it no longer does, or a technician cleared it) |
| `observed_at` | ISO 8601 with an offset |

A delivery may carry up to 500 codes. One that is malformed refuses the whole delivery (`400`, with `details` naming the field, such as `diagnostics.0.code`), as a bad position does.

A provider with an adapter of its own (the mock provider in the gateway's tests) can send codes as well. Its `data.diagnostics` must be in this format. Anything else is skipped and logged, because the delivery was already accepted.

## Raise, repeat, clear

The consumer takes a delivery's codes oldest first, on the delivery's transaction:

| Report | The vehicle has | Result |
|---|---|---|
| `active` | no active row for the code | A row: first and last seen at `observed_at`, one occurrence. **`VehicleFaultDetected`** (source `telematics`) opens one `vehicle_fault` alert |
| `active` | an active row | One more occurrence; first and last seen widen to include `observed_at`. No event, no new alert |
| `active` at exactly a time already counted | an active row | Ignored: the provider sent the same report twice |
| `active` no later than the code's last clear | no active row | Ignored: an old report arriving late |
| `cleared` | an active row, last seen no later than `observed_at` | The row closes, `cleared_at` = `observed_at`. **`VehicleFaultCleared`** closes the alert, resolved by nobody |
| `cleared` older than the row's last report | an active row | Ignored: a later report outranks it |
| `cleared` | no active row | Ignored |
| any, more than 2 minutes in the future | — | Ignored |
| any, from a device no vehicle has | — | Counted as an unknown device in the registry (`GET /integrations/devices/unknown`) |

A code that comes back after its clear is a new row and a new alert. A redelivery of the same `event_id` never reaches the consumer, because the receipt stops it.

The batch is audited as one entry, `tracking.diagnostics_ingested`, with no user and channel `webhook`. It lists the provider, the counts, and the public ids of the rows raised or cleared.

## The dictionary and severity

`tracking.diagnostic_code_dictionary` names the generic codes a fleet sees most: 42 OBD-II codes (by code) and 19 J1939 parameters (by SPN), each with a description and a severity. A J1939 description adds the failure mode ("Engine coolant temperature: above normal, most severe").

The alert's severity, by code class:

1. The dictionary's severity, when it names the code (`P0217` engine overheating and SPN 100 oil pressure are critical; `P0420` catalyst efficiency is low).
2. Otherwise by system: body codes (`B…`) are low, the rest medium.
3. J1939 failure modes 0 and 1 (most severe) raise it one level, up to critical.

A code the dictionary does not name is kept with no description. Manufacturer-specific codes (`P1…`) are like this until someone adds them to the dictionary.

## The alert

`VehicleFaultDetected` already makes the DVIR's `vehicle_fault` alert ([alerts.md](alerts.md)), and a telematics code uses the same rule. Its dedup key names the vehicle and the code (`vehicle_fault:<vehicle>:<protocol>:<code>`), so each code is its own alert and never merges with a DVIR's.

- **Title:** "Fault code P0217 on AA 3-41207".
- **Message:** the code's protocol and description.
- **Audience:** technicians and depot admins of the vehicle's depot. A critical code escalates if nobody acknowledges it.

`VehicleFaultCleared` resolves the alert by itself (`ALERT_RESOLVERS`).

## Reading them

`GET /vehicles/{vehicle_id}/diagnostic-codes` (`tracking:read`, in the caller's depot scope) lists the vehicle's codes: active ones first, then by last seen. `status` is `active`, `cleared` or `all` (the default), and `limit` runs from 1 to 200 (default 50). Each code carries its protocol, code, SPN and FMI, description, severity, first and last seen, occurrences, clear time, and the provider's code.

The vehicle detail screen will show them later. The card has no frontend.

## The simulator

```bash
npm run simulate:gps -- --vehicles 20 --faults 0.2               # 4 of 20 vehicles report a code
npm run simulate:gps -- --faults 0.1 --keep-faults --duration 0  # codes stay active for the demo
```

`--faults` is the share of vehicles that report a code with every position. The codes are P0217, P0300, J1939 110-0, P0524 and P0420, in turn. The first report raises the alert and later ones count occurrences. When the run ends the codes are cleared, which closes the alerts, unless `--keep-faults` is given. Codes come from a provider, so `--faults` needs the webhook channel (the default).

## Later

- A model feature: the number of active codes in the last 30 days ([ml-dataset.md](ml-dataset.md)).
- Opening a requested work order from a critical code.
- Codes on the vehicle detail screen.
