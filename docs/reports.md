# Reports, KPIs and scheduled exports (FMS-91, FMS-160)

Cards FMS-91 (SE-135) and FMS-160 (SE-204), architecture §10. Management, operations and finance get their figures
without building spreadsheets by hand: for any period and filter, against targets, as trends, as Excel and PDF, and by
email on a schedule.

- **On screen:** S-28 Reports at `/reports`, and S-39 KPIs at `/analytics/kpis`.
- **Through the API:** `GET /reports/{report}`, `GET /analytics/kpis` and `GET /analytics/kpis/{kpi}/trend`, with saved
  filters, background exports and schedules under `/reports/...`.

## The reports

| Report (`{report}`) | One row per | Columns |
|---|---|---|
| `fuel` | Vehicle filled or driven in the period | Fill-ups, fuel (L), cost (ETB), distance (km), used and rated L/100 km, cost per km |
| `maintenance` | Vehicle with repairs completed in the period, or open at its end | Repairs done (preventive, corrective, inspection and other), open at the end, labour (h), cost (ETB) |
| `cost` | Vehicle driven or costing anything in the period | Distance, fuel cost, maintenance cost, total, cost per km |
| `trips` | Trip scheduled to start in the period | Scheduled, route, vehicle, driver, status, started, ended, planned and driven km, on time |
| `drivers` | Driver who completed a trip, was flagged or had an incident | Rank and score (0 to 100), trips, distance, driving hours, on-time %, speeding and idling flags, incidents |
| `utilisation` | Vehicle in the fleet during the period | Days in the fleet, available and in use, utilisation %, downtime by cause (planned service, unplanned repair, breakdown, accident, awaiting parts, other), availability % |
| `compliance` | Vehicle with a programmed service due, a repair, or a failure | PM on time, late and overdue, PM compliance %, corrective repairs, repeated within 30 days, unplanned failures, MTBF (h), cost; then cost by system and by workshop |
| `safety` | Depot, driver or route (`by`) | Distance, incidents, accidents, speeding and idling flags, incidents and flags per 100,000 km, appeals opened and approved |

**The driver score (FMS-146).** The rank and score columns are only for a caller who also holds `tracking:read`: the
score is behavioural data ([analytics.md](analytics.md#the-driver-performance-score)). For them the rows come in rank
order, the drivers with no score last with the reason in the score column ("Not enough trips"). A finance clerk
(`analytics:read` only) gets the report without them, most trips first.

**Every report has a totals row:** sums, and the overall ratios worked out again from the sums, never averaged.

**The rules match the dashboard's (FMS-50):**
- **Distance and driving time:** a completed trip counts in the period it ended.
- **Fuel:** a fill-up counts when it was logged; with a driver or route filter, only fill-ups logged on that driver's
  or route's trips.
- **Repair cost:** a repair counts when it was completed.
- **On time:** a trip is on time when it ended within 15 minutes of its scheduled end.

**The FMS-160 reports:**
- **Utilisation.** A vehicle is in the fleet from its registration to its retirement. Its days available are those
  days less its downtime (FMS-131); its days in use are the Addis Ababa days a completed or running trip touched.
  Utilisation is days in use over days available; availability is time up over time in the fleet.
- **Compliance.** A programmed service (`preventive`, with a service programme) is on time when completed by the end of
  its scheduled day, late after it, and overdue when still open past it. A corrective repair is repeated when the same
  component (its failure record) was repaired on the same vehicle in the 30 days before. MTBF is time in the fleet over
  unplanned failures.
- **Safety.** A trip belongs to its route's depot, else its vehicle's. Rates are tenths per 100,000 km, judged only
  past 1 km. Flags and incidents an approved appeal excluded (FMS-159) are left out.

**When a figure is left blank:**
- **Consumption:** judged only past 100 km driven, and never for an electric vehicle.
- **Cost per km:** shown only past 1 km.

**Open at the period's end** means opened before the period ended and not completed by then. A cancelled repair is
left out, because when it was cancelled is not kept.

## Periods and filters

`GET /reports/{report}` needs `analytics:read`, held by admin, fleet manager, dispatcher, finance clerk, compliance
officer and fleet owner.

- **The period:** one of
  - `month=YYYY-MM` (the FMS-91 links, unchanged; this month up to now by default);
  - `quarter=YYYY-Qn`;
  - `year=YYYY`;
  - `from` and `to` (Addis Ababa days, both included, at most 366 days).

  Two at once, a backwards range, a longer one or one not yet begun is `400`; a month not yet begun keeps its
  `future_month` reason.
- **Filters:** `depot_ids` (several, comma-separated), `vehicle_type`, `vehicle_id`, `driver_id`, `route_id`, and for
  safety `by` (`depot`, `driver` or `route`). FMS-91's single `depot_id` still works.
- **Depot scope:** the caller's depots; depot-unscoped roles see every depot. A filter naming a depot, vehicle, driver
  or route outside the caller's scope is `404`, as the record itself would be. A driver sees nothing.
- **Which depot a row belongs to:** the vehicle reports, the vehicle's depot; the trip history and safety, the route's
  depot; driver performance, the driver's home depot.
- **`json`** (the screen) gives `columns` (`key`, `label`, `kind`), `rows`, `totals`, any `sections`, the `period`
  (instants, kind, key, label and its first and last day), the `filters` and `filter_names` (the depots', vehicle's,
  driver's and route's names), and `meta.data_freshness`. Values are integers in base units: ml, cents, metres, minutes,
  tenths for a rate.
- **Saved filters:** `GET`, `POST /reports/filters` (`name`, `filters`) and `DELETE /reports/filters/{id}`, the
  caller's own; a name used twice is `409 CONFLICT_DUPLICATE`.

## Exports

- **`csv`:** the table with a header row and the totals row, CRLF, UTF-8 with a byte-order mark for Excel; values in
  litres, birr, km and hours, without thousands separators; times in Addis Ababa; text a spreadsheet would run as a
  formula is defused with a leading `'`.
- **`xlsx`:** the same table with typed cells (numbers in display units with a number format, so they sort and sum), a
  frozen header row with an auto-filter, a bold totals row, each section on a sheet of its own, and a *Filters* sheet
  with the period and every filter by name. It opens in Excel and LibreOffice.
- **`pdf`:** landscape A4. A cover page with the title, the filters and a bar chart of the top ten rows; the table with
  its header on each page and the totals on the last; each section; page numbers. The font, Abyssinica SIL, is embedded,
  so Amharic names print and can be searched ([ADR-11](adr/ADR-11-report-exports-exceljs-pdfkit.md)).
- **Files** are attachments named for the report, period and depot, such as `fuel-report-2026-10-bol.xlsx`, sent with
  `Cache-Control: private, no-store`.
- **Over 20,000 rows** a file is made in the background: the request answers `202` with an export
  (`GET /reports/exports/{id}`, the caller's own). The `report-exports` job builds it as its owner now is, keeps it in
  the document storage under `reports/exports/`, and the export then carries a signed link
  (`/api/v1/report-files/{id}/content`) valid for 24 hours. After that the file is removed and the export is `expired`.

## KPIs

`GET /analytics/kpis` takes the reports' period and filters and gives, for each KPI, its value, the value for the
period before (as long), the change, its target, its status and a 12-month sparkline. Each KPI is read from the totals
of the report it opens, so the two always agree.

| KPI | From | Better | Target setting |
|---|---|---|---|
| Cost per km | `cost` totals | lower | `kpi_cost_per_km_target_cents` |
| Fuel use (L/100 km) | `fuel` totals | lower | `kpi_fuel_target_l100km_tenths` |
| Utilisation | `utilisation` totals | higher | `kpi_utilisation_target_pct` |
| Availability | `utilisation` totals | higher | `kpi_availability_target_pct` |
| On time | `trips` rows judged | higher | `kpi_on_time_target_pct` |
| PM compliance | `compliance` totals | higher | `kpi_pm_compliance_target_pct` |
| Incidents per 100,000 km | `safety` totals | lower | `kpi_incidents_target_per_100k_km` |
| Vehicles at risk | health below `health_alert_below` now | lower | `kpi_vehicles_at_risk_target` |
| Score appeals, driver feedback | opened in the period | | none |

- **Status:** on the good side of the target, or on it, is green (*On target*); past it by no more than the amber band
  (`kpi_amber_band_pct`, a share of the target, 10 % by default) amber (*Near target*); further red (*Off target*). The
  screen shows each with an icon and a label, never colour alone. The targets are settings ([settings.md](settings.md)),
  so a change shows at once, with no deployment.
- **Trend:** `GET /analytics/kpis/{kpi}/trend?months=` (up to 24) gives the KPI month by month with the same month a
  year before, and with `group=depot` or `group=vehicle` the KPI per depot or vehicle for the period: the drill-down from
  fleet to depot to vehicle.
- **Cache:** a month's KPIs are kept in Redis per caller scope and filters, a past month an hour, the current one 5
  minutes.

## Schedules

`/reports/schedules` (`analytics:read`): a report, its filters and format, sent daily, weekly (a weekday) or monthly (a
day, 1 to 28) at an Addis Ababa hour to FMS users, through the email provider ([notification-channels.md](notification-channels.md)).
The owner sees and changes their own; an administrator, all. `GET /reports/recipients?search=` lists who can receive
them: active users with `analytics:read`, names and roles only.

- **The period** of each run is the one just ended: yesterday, last Monday to Sunday, or last month.
- **Each recipient is checked at send time:** still active and holding `analytics:read`, else skipped and the owner
  told by email. The report is built as the recipient: their own depot scope, and the driver score only with
  `tracking:read`.
- **Delivery:** up to 5 MB the file is attached; larger, the email carries a signed link valid for 7 days.
- **Retries:** a recipient whose send failed is tried again 15 minutes later, 3 attempts in all.
- **History:** `GET /reports/schedules/{id}/runs` gives the last 50 runs: status (`sent`, `partial`, `failed`,
  `retrying`), attempts, rows and size, and each recipient's outcome.
- The `report-schedules` job runs every 5 minutes; each schedule has one run per due time, so a job that runs twice
  sends once.

## Where it reads

Reports read the analytics views on the **read replica**, one session per request ([read-replica.md](read-replica.md)).
Heavy reports never slow dispatch or GPS ingestion. Migrations 054 and 082 add the views the reports need, so the
analytics module reads only `analytics.*`: `report_vehicles`, `route_directory`, `report_trips`, `report_fuel`,
`report_maintenance` and `report_failures` beside the FMS-91 and FMS-131 ones. Saved filters, schedules, runs and
exports are tables on the primary (migration 082).

Reports are generated on demand and not cached. Every report for a year of 200 vehicles, filtered, comes back in
under the card's 10 seconds; `test/integration/reports-kpis.test.ts` checks it.

## The screens

**S-28 Reports** (`/reports`, under Fleet management):
- **Choosing.** A report (eight tabs), a period (month, quarter, year or custom range), depots (several), a vehicle
  type, and under *More filters* a vehicle, a driver or a route, each searched by name. The filters in force are chips
  that remove themselves. Everything is kept in the address; FMS-91's `?report=&month=&depot=` links still open.
- **Saved filters.** Save the period and filters by name, and bring them back in one click.
- **Preview.** The table with the totals row, paged at 25, 50 or 100; compliance's breakdowns below it. A note says
  how current the data is.
- **Downloads.** *CSV*, *Excel* and *PDF*. A report over 20,000 rows is made in the background: a notice says so and
  offers the file when it is ready.
- **Schedules.** A drawer lists the schedules, adds one from what is on screen, changes or stops one, and shows each
  run with who got it, who was skipped and why, and the retries.

**S-39 KPIs** (`/analytics/kpis`): a tile per KPI with its value, change, target, status and sparkline, linking to its
report with the same period and filters; one KPI's trend over 12 or 24 months beside last year, and its breakdown by
depot, where picking a depot shows its vehicles.

## Tests

- **Unit:** `analytics/domain/reports.test.ts` (units, times, ratios, CSV), `report-period.test.ts` (periods),
  `report-schedule.test.ts` (run times and periods), `kpi-targets.test.ts` (statuses and targets),
  `analytics/infrastructure/table-pdf.test.ts`.
- **Integration:** `test/integration/reports.test.ts` (the FMS-91 reports, scope, month links, CSV);
  `reports-kpis.test.ts` (periods and filters, the three new reports, the KPIs against their reports, a target changed
  in Settings, trends, Excel opened with exceljs, a PDF with Amharic names, a year of 200 vehicles under 10 s);
  `report-jobs.test.ts` (saved filters, a background export and its link, a weekly schedule on time, a recipient who
  lost access, retries and the history, the 5 MB link, recipients' scope).
- **Frontend:** `pages/Reports/ReportsPage.test.tsx` and `pages/Kpis/KpisPage.test.tsx`.
