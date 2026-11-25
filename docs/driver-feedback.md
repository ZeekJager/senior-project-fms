# Admin-to-driver feedback (FMS-158)

Card: FMS-158 (SE-202). A manager gives a driver feedback on a trip, a month's score or their performance overall. The driver is told, reads it in the driver app, acknowledges it and may reply, or disagrees by appealing (FMS-159).

Code:

- backend: `packages/backend/src/modules/analytics/` (`domain/feedback.ts`, the rules; `application/feedback.service.ts`; `api/feedback.routes.ts`; `infrastructure/feedback.repository.ts`); `modules/alert/application/notice.service.ts` for the driver's notices; `modules/privacy/application/data-erasure.service.ts` for an erasure;
- frontend: `pages/Driver/Feedback.tsx` (My feedback), `pages/Drivers/DriverFeedbackDrawer.tsx` (the managers' view), `features/feedback/`;
- migration 080.

## Giving feedback

| About | What it records | From |
|---|---|---|
| A trip | The driver's completed trip | *Give feedback on this trip* in a vehicle's trip history, or the drawer's *A trip* with the driver's last 20 completed trips |
| A month | The month (this one or earlier) and **the score shown then** (`score_shown`, null when the month has too little driving to be scored) | The drawer's *A month* |
| Overall | Nothing more | The drawer |

- **Who:** `feedback:write` (admin, fleet manager, depot admin) for a driver of their depots. Another depot's driver is `403`. Fleet managers and admins see every depot (`DEPOT_UNSCOPED_ROLES`); a depot admin sees their own.
- **Category:** one of the `feedback_categories` setting's values in use: *Safety*, *Driving behaviour*, *Fuel efficiency*, *Punctuality*, *Vehicle care*, *General comment*. A category taken out of use is refused from then on (`400`); items already filed under it keep it.
- **Tone:** *Praise*, *Needs improvement* or *Information*.
- **Message:** 10 to 2,000 characters.
- **Templates:** saved messages per category, the fleet's (`GET`, `POST /feedback/templates`, `PATCH`, `DELETE /feedback/templates/{id}`, `feedback:write`). The form starts from one, or saves its message as one. A removed template is kept inactive.

## Correcting and retracting

- **Corrections:** the author alone may edit the message for **24 hours** (`editable_until`). The earlier text is kept (`analytics.feedback_revisions`) and shown under *Earlier text*. Another manager's edit is `403`; a later one is `409 CONFLICT_FEEDBACK_LOCKED`.
- **Retraction:** any time, by a manager of the driver's depots, with a reason (up to 500 characters). It disappears for the driver at once (their list, their item: `404`) and stays for the managers, marked *Retracted* with who, when and why, and in the audit log. Retracting twice is `409 CONFLICT_FEEDBACK_RETRACTED`.

## The driver's side (S-38)

- *My feedback* (`/driver/feedback`), from My day, which says how many are new: live items newest first, each with its tone, category, what it is about, who gave it and when, and *corrected* when edited.
- **Offline:** the list and its items read from the last copy on the phone (this driver's only) when there is no signal, saying so.
- **Got it** acknowledges an item, once. The author sees when.
- **One reply** of up to 1,000 characters; it acknowledges the item too. A second is `409 CONFLICT_FEEDBACK_REPLIED`.
- **I disagree** opens *Appeal or complain* (FMS-159) with the feedback (`feedback_id`) and, for a month, that month. The appeal names the feedback, and **its author may not decide that appeal** (`409 CONFLICT_OWN_REPORT`), the rule [score-appeals.md](score-appeals.md#review) had waited for.
- **Notices:** new feedback in the app and by push; a correction in the app only. Never by email or SMS (the personal-channel rule, FMS-149). They are notices without an alert: `alert.notifications` rows of type `feedback_update`, `entity_type` `feedback`, opening `/driver/feedback/{id}`. Queued at once, the push leaves with the next delivery run, within a minute.

## The managers' view

The **Feedback** action on a driver's row in Drivers (S-05) opens the drawer (`feedback:read`):

- newest first, retracted items too, filtered by category and tone;
- the live items per category of the **last 90 days**;
- items **not read after 7 days** flagged, with a count;
- each item's reading and reply with their times, its earlier texts, *Correct* (the author, in time) and *Retract*.

A link opens it on a driver, ready to give feedback: `/drivers?feedback={driver_id}&give=trip&trip={trip_id}` (or `give=month&month=YYYY-MM`).

## Data protection

- **Who reads it:** the driver (their own), and managers with `feedback:read` of the driver's depots. Dispatchers, finance clerks and the other roles do not (the card's open question: not for now).
- **The data export** (`GET /auth/me/data-export`, FMS-104) has `feedback`: every item, retracted ones too, with its earlier texts, the reply and its times. The export's audit entry counts them.
- **Erasure:** `POST /drivers/{driver_id}/data-erasure` with a `reason`, `privacy:erase` (admin). It deletes for good, in one transaction, what the modules register for erasure: today the driver's feedback with its earlier texts. Trips, fuel logs, inspections and the other fleet records keep their own retention and are not touched. Audited as `privacy.data_erased` (the counts and the reason), and each item as `privacy.feedback_erased`, which never copies its words. The audit entries written when the item was given and changed stay, under the audit trail's own retention.
- **Retention:** `feedback_retention_months` (a setting, 24). The `feedback-retention` job (03:40) deletes older items, retracted ones too, in batches of 500, each audited as `feedback.retention_deleted`.
- **Events:** `FeedbackGiven`, `FeedbackEdited`, `FeedbackRetracted`, `FeedbackAcknowledged` (the card's `feedback.given` and the rest, named as CONVENTIONS.md has events) and `FeedbackReplied`. Each carries `feedback_id`, `driver_id`, `depot_id`, `subject_type`, `category` and `tone`, never the words.

## API

| Route | Needs |
|---|---|
| `POST /drivers/{driver_id}/feedback` | `feedback:write`, the driver in the caller's depots |
| `GET /drivers/{driver_id}/feedback?category=&tone=` | `feedback:read`, the driver in the caller's depots |
| `GET /feedback/{id}` | `feedback:read` |
| `PATCH /feedback/{id}`, `POST /feedback/{id}/retract` | `feedback:write` (an edit: the author, for 24 hours) |
| `GET`, `POST /feedback/templates`; `PATCH`, `DELETE /feedback/templates/{id}` | `feedback:write` |
| `GET /driver/feedback`, `GET /driver/feedback/{id}`, `POST .../acknowledge`, `POST .../reply` | Signed in; the driver's own (anyone else's is `404`) |
| `POST /drivers/{driver_id}/data-erasure` | `privacy:erase` |

The contract is in [openapi.yaml](openapi.yaml).

## Tests

`src/modules/analytics/domain/feedback.test.ts` covers the 24-hour window, what each side may do, the 7-day flag and the retention cutoff. `test/integration/driver-feedback.test.ts` covers the card's acceptance criteria: feedback on a trip with the push queued at once that opens the item; a driver seeing only their own and a manager of another depot getting 403; an edit after 24 hours refused and a retracted item gone for the driver but in the audit log; the acknowledgement and reply visible to the author with their times; feedback in the data export and removed by an erasure. Also the month's score shown, categories in use, the 7-day flag, the 90 days' counts, "I disagree" and its author, retention and templates. `test/integration/data-scope.test.ts` checks no depot's feedback reaches another depot's users.

## Not covered

- Giving feedback from the score card and the drivers report: the drawer and the trip link do; the report is a generic table with no actions.
- Dispatchers giving feedback (the card's open question): not granted.
- Erasing a driver's other records: the erasure covers what modules register for it, today feedback.
- Telling the author when the driver replies: the drawer shows it when opened.
