# Warranties, warranty claims and recalls (FMS-133)

Card FMS-133 (SE-177). Two problems it addresses:

- **Paying twice.** A repair under warranty is paid for twice when nobody checks.
- **Unfixed recalls.** A manufacturer's recall goes unfixed when it is not tracked per vehicle.

The fleet now records:

- **Warranties:** each vehicle's warranties.
- **Claims:** marks a repair claimable when a warranty covered what failed, and follows the claim to its outcome.
- **Recalls:** lists every vehicle a recall applies to until the remedy is done.
- **Expiry warnings:** warns of a warranty's end through the expiry job (FMS-26).

## Where the code is

- **Migration 065:**
  - `maintenance.warranties`, `maintenance.recalls`, `maintenance.recall_vehicles`;
  - the claim columns on `maintenance.maintenance_records`;
  - `warranty` added as a subject of `fleet.expiry_notices`.
- **Maintenance module, `packages/backend/src/modules/maintenance/`:**
  - `domain/warranty.ts`: the rules, as pure functions;
  - `application/warranty.service.ts`;
  - `infrastructure/warranty.repository.ts`;
  - `api/warranty.routes.ts`.
- **Fleet module:**
  - `ExpiryService.checkWarranties`, the `warranty-expiry-check` job;
  - `infrastructure/recall-vehicles.queries.ts`, the vehicles a recall can apply to.
- **Wiring:** `src/modules/index.ts` gives fleet the warranties ending soon (`provideWarrantyExpiry`). Maintenance imports fleet, so fleet cannot import maintenance.
- **Screens:**
  - S-22, the vehicle page: *Warranty and recalls*, `packages/frontend/src/pages/VehicleHistory/WarrantySection.tsx`;
  - S-35 Recalls: `packages/frontend/src/pages/Recalls/`;
  - the claim on a repair's record: `pages/Maintenance/WarrantyClaimBlock.tsx`.
- **Contract:** api-contract §10.5 and `docs/openapi.yaml`.

## Warranties

A warranty belongs to one vehicle and covers one of two things:

- **The whole vehicle:** `component` is `null`.
- **One component:** a component of the failure catalogue (FMS-125): `engine`, `brakes`, `transmission` and so on.

It comes from a `provider`, with optional `coverage` and `terms` text.

**When cover runs:**

- It starts on `starts_on`.
- It ends on `ends_on`, at the odometer reading `ends_km`, or at whichever comes first when both are given. At least one of the two is required.
- Dates are days in Addis Ababa, and both ends count as covered.

**What the warranty view adds:**

- **`status`:**
  - `not_started`: before `starts_on`;
  - `active`;
  - `expiring`: within the `expiry_warning_days` setting (30) of `ends_on`;
  - `expired`: past `ends_on`, or the vehicle's odometer past `ends_km`;
  - `void`: switched off with `is_active: false`.
- **`days_left`** and **`km_left`:** from today and from the vehicle's odometer now.
- **`claims`:** its repairs by claim status, and `recovered_cents` from approved claims.

**Changes:**

- **Voiding.** `PATCH` with `is_active: false` voids a warranty that was entered by mistake or cancelled. A warranty is never deleted.
- **Audit.** Every write is audited.

## Claimable repairs

**The rule (`covers`, `coveringWarranty`).** A repair is claimable under a warranty of its vehicle when all of these hold:

- **Something failed.** The repair has at least one failure (FMS-125). A service with no failure has nothing to claim.
- **Active warranty.** The warranty is not void.
- **In time.** Its work day falls within cover. The work day is when the work was completed; if it has not been, when it started; if not, when it was entered.
- **In distance.** Its odometer is at or under `ends_km`. A repair entered without an odometer cannot be checked against `ends_km`, so it is treated as within it. The claim then says `km_checked: false`.
- **Right part.** The warranty is on the whole vehicle, or on a component that failed.

**Two warranties covering it.** The repair is claimed under one only:

1. A component warranty comes before a whole-vehicle one: the narrower cover is the one that pays.
2. Then the one that ends last.
3. Then the oldest.

**When it is judged.** On the writer's transaction, every time something it depends on changes:

- **Repairs:** a repair created, changed or completed, or a failure added to it.
- **Warranties:** a warranty added or changed. This judges every repair of the vehicle whose claim is not yet sent, so a warranty entered after the repair still catches it.

Only a change is written, and each write is audited as an `UPDATE` of `maintenance.maintenance_records`.

**The claim, `warranty_claim` on a maintenance record:**

| Status | Means | Next |
|---|---|---|
| `claimable` | Covered; not yet claimed | `submitted` |
| `submitted` | Sent to the provider (`reference`: their claim number) | `approved` with `amount_cents`, the amount recovered, or `rejected` |
| `approved` | Paid back (`amount_cents`) | none: final |
| `rejected` | Turned down | `submitted` again, with more evidence |

**Moving a claim.** `PATCH /maintenance-records/{id}/warranty-claim` (also under `/maintenance`), with `maintenance:write`:

- A step not in the table is `409 CONFLICT_INVALID_STATE_TRANSITION` with `allowed_transitions`.
- A repair with no claim is `409`, `reason: not_claimable`.
- An approval without an amount is `400`. So is an amount with any other status.

**Once sent, the claim is the clerk's.** A submitted, approved or rejected claim is never judged again, even if the warranty is voided or the repair changes. Only claims still at `claimable` follow the rules.

## Recalls

**A recall** is a manufacturer's campaign:

- **Identity:** a `campaign_code`, unique ignoring case.
- **Target:** a `make`, a `model`, and model years `year_from` to `year_to`, both included.
- **Details:** a `description`, a `remedy`, and `issued_on`.

A recall applies to the whole fleet. Only a user who sees every depot may issue or change one; anyone else gets `403`, `reason: fleet_wide_not_allowed`.

**Matching (`recallMatches`).** Every vehicle in service matches when all of these hold:

- **Same make and model,** ignoring case and outer spaces.
- **Model year in the range.**

A vehicle with no model year on record is not matched. A retired vehicle is not matched either.

**When matching runs:**

- **Issued.** Every match is listed as open (`maintenance.recall_vehicles`), and `RecallIssued` is published.
- **Edited.** A change of make, model or years lists the new matches. It also drops those that no longer match, but only if they are still open with no work order: booked or completed work stays on record.
- **A vehicle registered or changed.** On `VehicleRegistered`, or a `VehicleUpdated` that changed its make, model or year, the consumer `maintenance.recall-match` lists the vehicle under the recalls it now matches.
  - A vehicle that no longer matches keeps its recalls: its details were corrected, and someone should look.
- **Events.** Each new match publishes `VehicleRecallOpened`, which becomes an alert for the vehicle's depot (`vehicle_recall`, high).

**A vehicle's recall work** (`PATCH /recalls/{id}/vehicles/{vehicle_id}`, `maintenance:write`, the caller's depots):

| Status | How |
|---|---|
| `open` | Listed. Sending `status: open` unlinks the work order |
| `scheduled` | `maintenance_record_id` links the work order that carries out the remedy. It must be the vehicle's own, and not cancelled |
| `completed` | Completing the linked work order completes the recall work with it. Linking an already completed work order also completes it. Or `status: completed` with no work order: done elsewhere, at the dealer for example (`completed_at`, default now). Final. |

Cancelling a linked work order puts its recall work back to open. Completion publishes `VehicleRecallCompleted`.

## Expiry warnings

The `warranty-expiry-check` job (07:00, fleet module) uses the expiry rules of FMS-26 ([jobs.md](jobs.md)):

- **What it checks:** live warranties of vehicles in service with an `ends_on` within the `expiry_warning_days` setting (30).
- **Level:** amber, or red within 7 days.
- **Once per level.** A level is raised once per warranty and end date (`fleet.expiry_notices`, subject `warranty`). Moving the end date starts again.
- **Event:** `WarrantyExpiring` (`warranty_id`, `vehicle_id`, `provider`, `component`, `ends_on`, `days_left`, `level`), with an id derived from those facts.
- **Alert:** the alert engine raises a `warranty_expiring` alert for the vehicle's depot (red: high, amber: medium; technician and depot admin).
- **Not warned of:** a warranty that ends at an odometer reading only. It shows as expired once the odometer passes `ends_km`.

## Who may do what

| | Permission | Scope |
|---|---|---|
| Read warranties, claims, recalls, a vehicle's recalls | `maintenance:read` | Warranties and recall vehicles of the caller's depots; another depot's warranty or vehicle is `404`. A recall itself is visible to all, its counts of the caller's vehicles |
| Add, change or void a warranty; move a claim; schedule or complete recall work | `maintenance:write` | The caller's depots |
| Issue or change a recall | `maintenance:write` and every depot | Fleet-wide |

## Screens

**S-22, the vehicle page:** *Warranty and recalls* (`?section=warranty`, `maintenance:read`).

- **Recalls:** each recall the vehicle is under, open first, with its code, description, remedy and status. *Mark done* (`maintenance:write`) records a remedy done elsewhere.
- **Warranties:** each warranty with what it covers, its provider, its cover dates and kilometres, and what is left. Also its claims: to claim, submitted, approved and rejected, and what was recovered.
  - *Add warranty* opens a form: what it covers, the provider, the start, and an end by date, odometer or both.
  - *Void* asks first.
- **Header badge:** an open recall shows as a badge in the header, which opens the section.

**Repairs:** a repair a warranty covers shows *Under warranty: claimable*, or where its claim is. Its record shows the warranty. With `maintenance:write`, the record moves the claim on, on the vehicle page as on the workshop page:

- *Submit claim*, with the provider's reference;
- *Approved*, with the amount recovered;
- *Rejected*.

**S-35 Recalls** (`/recalls`, `maintenance:read`): every recall on record, newest first, with its campaign code, what it applies to (make, model and model years), the defect, when it was issued, and the user's vehicles under it by open, booked and done.

- **A recall's panel:** the defect, the remedy, and the user's vehicles under it, open first, each opening its vehicle page at *Warranty and recalls*. *Mark done* (`maintenance:write`) records a remedy done elsewhere.
- *Issue recall* and *Edit recall* (`maintenance:write`, a user who sees every depot) open a form: the campaign code, when issued, the make, model and first and last model year (blank: the first year only), the defect and the remedy. The form checks what the API checks before sending; a taken campaign code shows under its field. Saving says how many vehicles are listed as open.

## Tests

- **Unit, `maintenance/domain/warranty.test.ts`:**
  - cover by day, odometer and component;
  - which warranty a repair is claimed under;
  - a warranty's status;
  - recall matching;
  - the Addis Ababa day.
- **Integration, `test/integration/warranties-recalls.test.ts`:**
  - **Recall matching:** a recall for a make, model and year range lists every matching vehicle as open, and none of: another year, another model, no year, retired. Also:
    - one event and alert per vehicle;
    - a depot's own view;
    - a vehicle registered later;
    - narrowing the years.
  - **Who may issue a recall;** a campaign code once; years in order.
  - **Recall work:** through a work order (scheduled, then completed with it, back to open when it is cancelled), and by hand.
  - **Claimable detection:** by component and by the whole vehicle; by date and km; a warranty entered after the repair.
  - **Claims:** the steps, with the amount; voiding the warranty.
  - **Expiry warning:** a warranty ending within 30 days is warned of, once per level; ending later, by distance only, void or of a retired vehicle is not; the alert.
  - **Rules, scope and permissions.**
  - Every answer is checked against `docs/openapi.yaml`.
- **Integration, also:** `data-scope.test.ts` probes a depot B warranty.
- **Components, `VehicleHistory/VehicleHistoryPage.test.tsx`:**
  - the header badge, the recall marked done, the warranty ending;
  - adding a warranty;
  - a claimable repair submitted and then approved with its amount;
  - a reader without the buttons.
