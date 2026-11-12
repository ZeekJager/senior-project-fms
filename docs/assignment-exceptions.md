# Approved exceptions to the assignment rules (FMS-151)

An assignment that breaks a standard rule is an exception a fleet manager approves, not one a dispatcher makes alone. The request, the decision, who made each and why are recorded.

## The rules, and which can be an exception

Assignment (FMS-31, [api-contract.md](api-contract.md) §7.2) has two kinds of rule.

| Rule | Kind | An exception? |
|---|---|---|
| BR-1, BR-3: the driver or vehicle is on another trip at that time | refuses | Never |
| BR-2: the vehicle is flagged for maintenance or in the workshop | refuses | Never |
| BR-8: the driver's licence has expired or does not cover the vehicle | refuses | Never |
| The vehicle or driver is from another depot, retired or out of service | refuses | Never |
| `DRIVER_ATTENDANCE`: the driver is marked absent, on leave or sick on the trip's day | warns | Per depot |
| `PREVIOUS_TRIP_OVERRUN`: a trip of the driver or vehicle still under way runs into this one | warns | Per depot |

Nobody can approve a rule that refuses, at any level.

## The setting

Each warning has a setting, `warn` or `approve`, kept with the telemetry rules' thresholds in `tracking.rule_thresholds`. Like the other thresholds, the fleet has one row and a depot can have its own row that differs. In the API the fields are `driver_attendance_exception` and `trip_overrun_exception`.

- **`warn`** is the default. The assignment goes ahead and the warning comes back in `meta.warnings`, as it did before this card.
- **`approve`** holds the assignment until a fleet manager decides.

The settings screen (S-27) shows both settings under *Assigning through a warning*, for the fleet and for each depot's own thresholds. An admin changes them (`settings:write`), and every change is audited. The assignment reads the setting inside its own transaction, never from a cache, so a change applies to the next assignment.

## Holding an assignment

`POST /trips/{trip_id}/assign` runs every rule as before. The safety rules refuse first. If they pass, any warning the trip's depot sets to `approve` holds the assignment:

- **No `exception_reason` in the body:** `409 CONFLICT_APPROVAL_REQUIRED`, with one detail per held warning. The detail says `driver_absent`, `driver_on_leave` or `driver_sick`, or `previous_trip_overrun` with `record_id` set to the trip still under way. Nothing changes.
- **With `exception_reason` (1-500 characters):** `202` with the `AssignmentException`.
  - The request records the trip, the driver and vehicle asked for, the held warnings, the reason, and who asked.
  - The trip itself is unchanged: still unassigned (or still on its earlier pair), same version.
  - `AssignmentExceptionRequested` is published.
  - The trip's `exception` shows the request while it waits.

Each trip has at most one waiting request (`uq_assignment_exception_pending`). A waiting request is **withdrawn** when:
- the dispatcher asks again with another pair or another reason (the new request replaces it);
- the trip is assigned in a way that needs no approval;
- the trip is cancelled.

## Deciding

`assignment-exception:approve` is held by admin and fleet manager. The trip must be in the decider's depots (otherwise `404`); fleet managers and admins see every depot.

- **`POST /assignment-exceptions/{id}/approve`** with an optional `{ note }`.
  - Every rule is checked again at that moment, as an assignment would check it. A safety rule that now fails refuses with its usual error, for example a vehicle sent to the workshop since the request. The request keeps waiting.
  - **An approval covers that trip and the warnings it asked about, nothing else.** A warning counts as covered when it is the same rule, about the same driver or vehicle and, for an overrun, the same trip under way. A held warning the request did not ask about is `409 CONFLICT_APPROVAL_REQUIRED`: the manager refuses the request and the dispatcher asks again.
  - The one who asked never approves their own request (`403`, `own_request`).
  - The trip is then assigned to the driver and vehicle asked for. `TripAssigned` carries `exception_id`, and `AssignmentExceptionDecided` (`decision: approved`) is published.
- **`POST /assignment-exceptions/{id}/refuse`** with `{ reason }` (required). The trip stays as it is, and `AssignmentExceptionDecided` (`decision: refused`, with the reason) is published.

A request that has already been decided or withdrawn is `409 CONFLICT_INVALID_STATE_TRANSITION` (`exception_approved`, `exception_refused` or `exception_withdrawn`).

## Who is told

| Event | Alert | Severity | Who |
|---|---|---|---|
| `AssignmentExceptionRequested` | `assignment_exception`: what was asked for, the warnings and the reason | medium | fleet manager |
| `AssignmentExceptionDecided`, refused only | `assignment_exception_refused`: why | low | dispatcher |

An approval is not an alert: the console shows the trip assigned. Both events also reach the dispatch console as `trip.updated` ([realtime.md](realtime.md)). Each notification opens the trip on the console (`/dispatch?trip=`).

## Audit

Every request and every decision is an audited change of `trip.assignment_exceptions` (`audit.audit_logs`), made by the user who asked or decided. An approval also writes the trip's audited update, with the same correlation id. Each row keeps:
- the reason, who asked and when;
- the status, who decided and when, and why (`decision_reason`: required for a refusal, an optional note for an approval).

## The console (S-07)

- **The trip list:** a trip waiting for a decision shows *Awaiting approval*; one whose last request was refused shows *Approval refused*.
- **A held assignment:** the assignment panel says *Needs a fleet manager's approval* and lists the warnings. The dispatcher writes why and sends the request with *Ask for approval*. *Assign* stays disabled until then.
- **A waiting request:** the panel shows the driver and vehicle asked for, who asked and when, the warnings and the reason. A fleet manager writes an optional note and chooses *Approve and assign*, or writes why and chooses *Refuse*. The person who asked reads *Another fleet manager decides on a request you made.*
- **A refused request:** the panel shows who refused it and why, so the dispatcher can choose again.

## Tests

- `test/integration/assignment-exceptions.test.ts`:
  - a held request needs a reason, waits, is audited, alerts the fleet managers, and assigns only on approval;
  - a refused request stays unassigned and tells the dispatchers why;
  - a safety rule refuses as before, never held, and is checked again at approval;
  - an approval covers that warning only, and never by the one who asked;
  - `warn` assigns as before, and a cancelled trip withdraws its request;
  - the settings are per depot.
- `src/modules/trip/domain/exception.test.ts`: which warnings are held, and what an approval covers.
- The console's tests in `DispatchPage.test.tsx`, and the settings tests in `SettingsPage.test.tsx`.
