# Audit log screen (S-10)

Card: FMS-29 (SE-65). Code: `packages/frontend/src/pages/AuditLog/`. It reads `GET /audit-logs` (FMS-28, [api-contract §5.2](api-contract.md#52-audit-log)).

Compliance officers, fleet owners and administrators (`audit:read`) read the change history here, without database access. It is in the menu under **Administration → Audit log**, at `/audit`. Everyone else gets no menu link and an empty page. The screen is read-only: the API has no way to change an entry.

## The list

Entries are newest first, 50 a page, paged by cursor ("Next page"). Each row shows:
- when, in Addis Ababa time;
- what happened, for example "Updated vehicle AA 3-12345", with the fields it changed underneath;
- who did it.

A denied or failed request is marked red.

| View | Shows | Asks the API for |
|---|---|---|
| Data changes (default) | Records created, updated or deleted, and role changes | `action=INSERT,UPDATE,DELETE,ROLE_CHANGE` |
| Sign-ins | Sign-ins, failed attempts, sign-outs, password changes | `action=auth.*` |
| Denied | Requests refused for lack of permission | `result=denied` |
| Scheduled jobs | Each job run's start and end | `action=job.*` |
| Everything | Every entry, GPS position batches included | no action filter |

**Everything** sits apart from the other views. GPS position batches outnumber every other kind of entry by far: about 116,000 of 134,000 entries on a demo database after a few runs of the GPS simulator.

**Filters.** Every filter lives in the address, so an audit question can be shared as a link:
- **Record ID** (the search box): a record's full ID finds its history. Anything else is explained, not sent.
- **Records:** one kind of record, such as fuel logs or vehicles.
- **When:** today; the last 7, 30 or 90 days; or chosen From and To dates. These are Addis Ababa days, and To includes its day.
- **Chips** for a person, a record or a request, set from an entry (below). A chip's × removes it.

## An entry

Clicking a row opens the entry.

**Fields changed: only the fields that changed.**
- An update shows each field whose value differs, before and after.
- A create shows each field it set, and a delete each field the record had. Empty fields are left out.
- The record's own ID is shown in Context, not as a change.
- Values are compared as data, so an object with its keys in another order is not a change.

The order is the record's name first, then A to Z, with times last. The database stores keys in its own order, which reads as random.

**Values are in their units:**

| Stored as | Shown as |
|---|---|
| Integer cents (`*_cents`) | ETB 3,800.50 |
| Millilitres (`*_ml`) | 42.50 L |
| `fuel_efficiency_ml_per_km` | 32.0 L/100 km |
| Kilometres (`*_km`) | 87,000.5 km |
| Seconds (`*_seconds`) | 5 h 20 min |
| Times | 28 Oct 2026, 14:05:09, Addis Ababa |
| `true` / `false` | Yes / No |
| A redacted value (password and token hashes) | Hidden |

Big integers and decimals reach the trail as text ("57220"). A field with a unit reads them as numbers. A value that is not a whole number of cents or millilitres is shown as it is, never rounded into a plausible amount.

**Details** are the entry's other facts: a job's result, how many GPS positions a batch accepted, a denied permission.

**Context** shows who, the record, the request (correlation id), the channel, the IP address and the device. Three links narrow the list from there:
- **Everything they did:** the person's entries.
- **Its full history:** the record's entries, of every kind.
- **Everything in it:** every entry the same request or job run wrote.

An entry without a user reads "Not signed in" for sign-in events. Any other entry without a user reads "System": an event consumer or the seed.

## API change

`action` now takes up to 10 actions, comma-separated, each exact or a prefix ending in `.*`. Before, it took one exact action. A prefix's `_` matches only itself. Anything else is `400`, `reason: invalid_action`.

## Tests

- `describe.test.ts` covers:
  - the diff: changed fields only, keys in another order, fields that appear or disappear, creates and deletes;
  - the units, including numbers stored as text;
  - the labels.
- `AuditLogPage.test.tsx` covers:
  - the default view and its request;
  - the drawer's diff in litres and ETB, with unchanged fields left out;
  - each view's request, and the denied mark;
  - following a person and a record;
  - the record ID search;
  - the record and period filters, and cursor paging;
  - the menu for each role.
- `test/integration/audit-logs.test.ts` covers several actions, prefixes, the literal `_` and refused filters.
