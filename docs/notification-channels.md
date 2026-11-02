# Notification channels: email, SMS and push

Card FMS-93 (SE-137), architecture §9.4, §15 and §34. On-call staff hear about critical events when they are not signed in.

The alert engine ([alerts.md](alerts.md)) still decides **who** hears about an alert: the rule's roles at the alert's depot, then the escalation tiers. This card adds **how**. Every alert reaches them in the app, as before. An urgent one also goes out by email, SMS and push, through provider adapters on the integration gateway ([integrations.md](integrations.md)).

## Channel rules

| Severity | In FMS | Email | SMS | Push |
|---|---|---|---|---|
| Critical | yes | yes | yes, if the user has a phone number | yes, to each browser they turned push on in |
| High | yes | | | yes |
| Medium, low | yes | | | |

The rules are `CHANNELS_BY_SEVERITY` in `alert/domain/delivery.ts`.

- **Escalations count too.** When a critical alert escalates, the next tier gets it on the same channels.
- **Channels must be on.** A channel is on when an active notification provider delivers it. A channel that is off queues nothing.
- **Inactive users get nothing.** Neither do users already told about the alert.

Each user sees their own rules and addresses under **Notification settings** (S-29, `/notification-settings`), opened from the account card.

## How a message goes out

1. **Queued with the alert.** When the alert engine notifies people, it also writes one `alert.notifications` row for each email, each SMS and each push device. These rows are written in the same transaction as the alert, with `status = 'queued'` and `next_attempt_at` set to now. Like the inbox rows, a batch gets one audit entry, `alert.delivery_queued`, with counts per channel.
2. **Sent by the delivery job.** `notification-delivery` runs every minute ([jobs.md](jobs.md)).
   - It claims the due rows a batch of 20 at a time, with `FOR UPDATE SKIP LOCKED`. Two instances never send the same message.
   - Each claim counts one attempt and leases the row for 5 minutes. A message whose sender dies is picked up again.
   - It sends each message through the integration gateway: the channel's provider, behind that provider's circuit breaker.
3. **Recorded on the row.** Each attempt is recorded on the message's own row:

   | Outcome | What the row records | Attempts |
   |---|---|---|
   | Sent | `status = 'sent'`, `sent_at`, `provider_id` and `provider_message_id`: the SMTP Message-ID, the SMS gateway's id, or the push message's id | as made |
   | Failed, worth retrying | stays `queued`; `failure_reason` and the next `next_attempt_at` | counted |
   | Refused | `status = 'failed'` at once | counted |
   | Breaker open | waits until the breaker lets a call through | not counted |
   | Cancelled | `status = 'cancelled'` | not counted |

   - **Worth retrying:** a timeout, a network error, 408, 429 or 5xx, a mail server's 4xx, a channel switched off. The next attempt comes 1, 5, 15 and then 60 minutes later. After the 5th attempt the message is `failed`, with the last reason.
   - **Refused:** the mail server rejects the recipient (5xx), the push service says the subscription is gone (404, 410), or the message is too large. Such a message is never retried. An expired push subscription is also deleted.
   - **Breaker open:** five failures in a row, or most of a minute's calls failing, open the breaker ([integrations.md](integrations.md#calls-timeouts-retries-breaker)).
   - **Cancelled:** the alert is resolved or dismissed first, the recipient's account is no longer active, or the address has gone (no phone number any more, push turned off).

**Contact details** are read from the user's account at send time, through the auth module's user directory. They are never stored on the message, never logged, and never returned with a delivery. Only this module reads them.

## Delivery status

`GET /alerts/{alert_id}/deliveries` (`alert:read`, in the caller's depot scope, api-contract §12.1) lists every notification of the alert, by channel then recipient.

Each row shows:
- who it was for (public id and name, never their email address or phone number);
- its status, attempts, and the code of the provider that took it, with its message id;
- while it is retrying: why the last attempt failed and when the next is due.

`in_app` rows show whether they were read.

The command center (S-16) offers **Delivery** on each critical and high alert. It opens these rows in a side panel, refreshed every 15 seconds, with each message marked Sent, Retrying, Failed or Not sent.

## Providers

Each channel is an `integration.external_providers` row:
- `provider_type = 'notification'`;
- `configuration.channel` set to `email`, `sms` or `push`;
- `is_active` true.

If several rows deliver the same channel, the oldest wins. Rows without an adapter of their own use the default notification adapter (`integration/infrastructure/notification.adapter.ts`), as telematics rows do. Secrets live in the environment as `INTEGRATION_<CODE>_API_KEY` ([integrations.md](integrations.md#adding-a-provider)), never in the table.

### Email: SMTP

| `configuration` | |
|---|---|
| `channel` | `email` |
| `host`, `port` | The mail server; port 587 by default |
| `tls` | `starttls` (default: required, never sent in clear), `implicit` (port 465), or `none` (local test servers only) |
| `username` | When the server needs a login. The password is the API key |
| `from` | `FMS Alerts <alerts@fleet.example>` |

**Delivery.** It uses nodemailer, one connection per message. The provider's `timeout_ms` covers connecting, the greeting and each command.

**The email.** It is plain text:
- **Subject:** `[Critical] <title>`.
- **Body:**
  - the message;
  - the severity, and when the alert was raised (Addis Ababa time);
  - a link to the screen that deals with it, when `APP_PUBLIC_URL` is set;
  - a line saying why the reader got it.
- **Headers:** `X-FMS-Reference` (the message's id) and `Auto-Submitted: auto-generated`.

### SMS: the FMS SMS format

| `configuration` | |
|---|---|
| `channel` | `sms` |
| `path` | Under the row's `base_url`; `/messages` by default |
| `sender` | The sender id shown on the phone, if the gateway takes one |

**The request.** `POST <base_url><path>` with JSON `{ to, text, sender, reference }`, and these headers:
- `Authorization: Bearer <api key>`;
- `Idempotency-Key: <reference>`, so a resend of the same message is not texted twice.

**The answer.** A 2xx with `{ id }` (or `{ message_id }`). `GET /health` is the health check.

**The text.** It reads `FMS CRITICAL: <title>. <message>` and is cut at 300 characters, two SMS parts at most.

**Which gateway.** No SMS provider was decided in the repository: the card's decision D-05 is not recorded. This format is neutral. A gateway that speaks it needs only a row. A vendor with its own API, such as Africa's Talking or Twilio, gets an adapter of its own registered by its code (`integrationGateway.register(...)`), and nothing else changes.

### Push: Web Push with VAPID

| `configuration` | |
|---|---|
| `channel` | `push` |
| `vapid_public_key` | The public half; browsers subscribe with it |
| `subject` | `mailto:` or `https:`: who the push services contact |

**The private key** is the API key. `npm run push:keys -- --code <code>` makes a pair and prints where each half goes. Make it once per environment: a new pair makes every browser subscribe again.

**Encryption.** Messages are encrypted for the browser that subscribed (RFC 8291, aes128gcm) and signed with a VAPID token (RFC 8292). This is done with Node's crypto and `jose`, in `integration/domain/web-push.ts`; its test reproduces the RFC's worked example byte for byte. The push service only relays bytes it cannot read.

**Headers.** Each push carries `TTL` (24 h for critical, 6 h for high), `Urgency: high` for critical, and a `Topic` from the message's id, so a resend replaces the first if it is still waiting.

**Endpoints.** The server posts to the browser's endpoint, so only `https` addresses of the browsers' push services are accepted, at subscription and again at sending. Those services are FCM, Mozilla, Windows and Apple. An address inside our network, or with credentials in it, is refused (`400`, `reason` `unknown_push_service`, `not_https` or `credentials_in_url`).

## Push in the browser

**Turning it on.** **Notification settings → Push in this browser → Turn on push** does four things:
1. registers the service worker (`/sw.js`), if it is not registered yet;
2. asks the browser's permission;
3. subscribes with the server's key;
4. sends the subscription to `POST /notifications/push/subscriptions`.

**Showing a push.** The service worker shows each push as a system notification, even with FMS closed. A critical one stays on screen until it is dealt with. Clicking it opens the screen that deals with the alert, the same screen the inbox links to, in an open FMS tab if there is one.

**Testing.** *Send a test* (`POST /notifications/push/test`) pushes to each of the user's browsers at once.

**Staff and the service worker.** Staff never had a service worker; they get one only when they turn push on. It caches no staff page and keeps no staff session: their pages are network-only, as before.

**Which browsers.** Push works in Chrome, Edge and Firefox on desktop and Android, and in Safari on macOS. On an iPhone or iPad, Safari pushes only to a web app added to the Home Screen. Today that is the driver app: staff pages offer no install, so staff on iOS get email and SMS.

**After sign-out.** Push stays on. That is the point: on-call staff hear about alerts when they are not signed in. A browser has one owner:
- If someone else signs in on it and turns push on, the subscription moves to them.
- Notification settings tells whether this browser's subscription is the signed-in user's. `GET /notifications/channels` returns a fingerprint of each of their endpoints, the first 22 characters of base64url(SHA-256), so the browser can tell without the endpoint going back and forth.
- On a shared computer, turn push off before leaving (`POST /notifications/push/unsubscribe`).

## The API

| Endpoint | Permission | What |
|---|---|---|
| `GET /alerts/{alert_id}/deliveries` | `alert:read` | The alert's notifications and their delivery status (above) |
| `GET /notifications/channels` | `notification:read` | The rules (most severe first, only channels that are on), the caller's email address and phone number, and push: `available`, `public_key`, `devices`, `device_keys` |
| `POST /notifications/push/subscriptions` | `notification:read` | `PushSubscription.toJSON()` -> `{id, created_at}`, `201` new or `200` known; `503 UPSTREAM_UNAVAILABLE` while push is off |
| `POST /notifications/push/unsubscribe` | `notification:read` | `{endpoint}` -> `{removed}`; only the caller's; safe to repeat |
| `POST /notifications/push/test` | `notification:read` | -> `{devices, sent, failed}` |

## Configuration

| Variable | |
|---|---|
| `APP_PUBLIC_URL` | The web app's public address. Alert emails link to it; unset, they carry no link |
| `INTEGRATION_<CODE>_API_KEY` | The SMTP password, the SMS gateway's key, or the VAPID private key, by provider code |

`docker-compose.yml` passes `APP_PUBLIC_URL` and the keys for the codes `smtp-email`, `sms-gateway` and `web-push`. A deployment that uses other codes adds its own.

**Setting up.** For example, email:

```sql
INSERT INTO integration.external_providers (name, code, provider_type, configuration)
VALUES ('Alert email', 'smtp-email', 'notification',
        '{"channel": "email", "host": "smtp.example.com", "port": 587, "username": "alerts@fleet.example", "from": "FMS Alerts <alerts@fleet.example>"}');
```

Then set `INTEGRATION_SMTP_EMAIL_API_KEY` to the password. The provider shows in `GET /integrations/providers` with its breaker, like any other.

## Data

Migration 055:
- **`alert.push_subscriptions`:** user, endpoint (unique: one owner per browser), key, auth secret, user agent, last success.
- **`alert.notifications`:**
  - `next_attempt_at`;
  - `push_subscription_id` (set to null if the subscription is removed, and the queued push is then cancelled);
  - a partial index on `next_attempt_at` over queued email, SMS and push rows: the delivery job's queue.

Delivery attempts are not audited one by one; the row is the log. Subscribing and unsubscribing are audited (`push.subscribed`, `push.resubscribed`, `push.unsubscribed`), without the endpoint.

## Tests

- **Unit:**
  - `integration/domain/web-push.test.ts`:
    - the RFC 8291 example, byte for byte;
    - a browser-side decrypt;
    - VAPID tokens verified with the public key;
    - which endpoints are accepted.
  - `alert/domain/delivery.test.ts`: the rules, the retry schedule, and the email, SMS and push wording.
- **Integration (`test/integration/notification-channels.test.ts`):** a local SMTP server, SMS gateway and push service stand in for the providers.
  - A critical alert emails, texts and pushes the people it notifies. A high one is only pushed, a medium one stays in the app.
  - A channel with no provider queues nothing.
  - An SMS failing with 503 retries after 1 and then 5 minutes, visible in the delivery status, then is sent.
  - One that keeps failing is `failed` after 5 attempts. Once the breaker is open, the next waits without using attempts.
  - A refused recipient fails at once. Resolving an alert cancels its queued messages.
  - An expired push subscription is removed.
  - Delivery status is scoped to the alert's depot.
  - Push subscriptions: subscribing, moving to another user, unsubscribing only one's own, refused endpoints and keys, the test push, and the channels view.
- **Frontend:**
  - S-29: the rules and addresses, turning push on and off, the test push, a subscription that is someone else's, a blocked permission, push not set up or not supported.
  - `lib/push`: keys and fingerprints.
  - The delivery panel: what each status says, and the list by channel.
