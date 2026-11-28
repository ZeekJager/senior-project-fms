# Work orders (FMS-130)

Card: FMS-130 (SE-174). Code: `packages/backend/src/modules/maintenance/` (`domain/work-order.ts`, `application/work-order.service.ts`, `infrastructure/work-order.repository.ts`, `api/work-order.routes.ts`); migration 087.

A repair record used to be one line with one total. A workshop plans work as an order: split into tasks, worked by several technicians, sometimes sent to an outside garage, and approved first when it is expensive. The order is the repair record itself (`maintenance.maintenance_records`); there is no parallel table, so every report, the vehicle's history and the cost KPIs keep reading the same rows.

## What an order adds

| Part | Where | What |
|---|---|---|
| Request and approval | `status` `requested`, `approved_by`, `approved_at` | Work asked for and not started. Above the threshold it waits for an approver. |
| Tasks | `maintenance.work_order_tasks` | The jobs it is split into: description, component (the failure catalogue, [maintenance.md](maintenance.md#catalogues)), status (`pending`, `in_progress`, `done`, `skipped`), estimated hours. A task's actual hours are the labour booked to it. |
| Labour | `maintenance.labour_entries` | Hours a technician worked, on an Addis Ababa day, optionally on a task, at a rate in cents per hour; `cost_cents` is hours x rate, rounded. |
| Vendor | `maintenance.vendors`, and on the order `vendor_id`, `vendor_invoice_ref`, `vendor_cost_cents` | The outside workshop, dealer, tyre or parts supplier that did some of it, its invoice and its cost. |

`GET /maintenance-records/{id}` returns them as `work_order` (api-contract §10.1).

## Rules

- **Approval.** A request whose total is above `work_order_approval_threshold_etb` (default 20,000 ETB; Settings, Maintenance) cannot be scheduled, started or completed until it is approved: `409 CONFLICT_INVALID_STATE_TRANSITION`, reason `approval_required`. `POST /maintenance-records/{id}/approve` (`maintenance:approve`: admin, fleet manager, depot admin) records who and when and makes it open work. A request at or below the threshold may be started directly; it can still be approved, which records the approver. A request can be cancelled at any time. Work that was scheduled or started cannot become a request again (`back_to_requested`). An approval covers the order as approved: a later rise in its cost does not ask again.
- **The maintenance flag.** A request is not work yet: it does not flag the vehicle. Approving it, or scheduling or starting it, flags the vehicle as opening work does. `open=true` on `GET /maintenance-records` lists scheduled, open and in-progress work, not requests.
- **Itemised totals.** An order with labour entries or a vendor is itemised: `total_cost_cents` = parts + labour + vendor, and `labour_hours` is the entries' sum. Both are recomputed in the same transaction as every labour or vendor change, and neither can be sent on `PATCH` any more (`400`, reason `itemised_order`). An order without either keeps its typed total and hours, as before. In-house labour counts only as labour entries: an order sent wholly to a vendor costs its parts and the vendor's invoice.
- **When.** Tasks and the vendor change on requested and open work. Labour is booked on scheduled, open and in-progress work only: a request has not started, and completed or cancelled work is final.
- **Technicians.** A labour entry names an active user who holds `maintenance:execute`, in the vehicle's depot or with fleet-wide access. Its day defaults to today in Addis Ababa and cannot be a day to come. A mistaken entry is taken off (`DELETE .../labour/{entry_id}`, a soft delete) and the totals follow.
- **Rates.** Labour is booked at `labour_rate_etb_per_hour` (default 300 ETB; Settings, Maintenance) unless a finance role sends `rate_cents`. Rates and labour costs (`rate_cents`, `cost_cents`, `labour_cost_cents`, the report's `cost_cents`) are shown only to holders of `labour-rate:read`: admin, finance clerk and fleet owner; anyone else sees `null`, and sending `rate_cents` without it is `403`. The order's total stays visible to everyone who can read it, as before.
- **Vendors.** Fleet-wide (`depot_id` null) or for one depot. A depot-scoped user sees their depot's and the fleet-wide ones, and adds vendors for their own depot only. An order's vendor must be fleet-wide or of the vehicle's depot (`vendor_in_other_depot`). A name is unique among a depot's active vendors, any case (`409 CONFLICT_DUPLICATE`). A vendor is retired, never deleted: orders that named it keep it. Writing vendors needs `vendor:write` (admin, fleet manager, depot admin); reading them, `maintenance:read`.
- **Scope and audit.** Every write is in the caller's depots (another depot's order or vendor is `404`), in one transaction with its audit row, and publishes `MaintenanceRecordUpdated` with what changed in `changed_fields` (`tasks`, `labour`, `vendor_id`, `approved_by`, ...).

## Technician workload

`GET /labour-hours?from=&to=&technician_id=` adds the labour entries up per technician per week (Monday, Addis Ababa): hours, the number of work orders and, for `labour-rate:read`, the cost. Vehicles in the caller's depots only. By default the twelve weeks up to today; at most 366 days.

## Who

| Permission | Roles | For |
|---|---|---|
| `maintenance:approve` | admin, fleet manager, depot admin | Approving a request |
| `vendor:write` | admin, fleet manager, depot admin | Adding, changing and retiring vendors |
| `labour-rate:read` | admin, finance clerk, fleet owner | Seeing and setting labour rates and costs |
| `maintenance:read` | (finance clerk added) | Finance sees what repairs cost |

Tasks, labour and an order's vendor need `maintenance:write`, as the record does.

## Screens

The repair log's record panel (S-08) shows the order: approval (with Approve for `maintenance:approve`), tasks, labour entries with their technician, day and hours (rates and costs for finance roles), and the vendor with its invoice. The Vendors screen (`/maintenance/vendors`) lists, adds, edits and retires vendors.
