# Reports and exports (FMS-91)

Card FMS-91 (SE-135), architecture §10. Management gets monthly figures to download, without building spreadsheets by hand.

There are five reports, each for a calendar month in Addis Ababa:
- **on screen:** S-28 Reports at `/reports`;
- **through the API:** `GET /reports/{report}`.

## The reports

| Report (`{report}`) | One row per | Columns |
|---|---|---|
| `fuel` | Vehicle filled or driven in the month | Fill-ups, fuel (L), cost (ETB), distance (km), used and rated L/100 km, cost per km |
| `maintenance` | Vehicle with repairs completed in the month, or open at its end | Repairs done (preventive, corrective, inspection and other), open at month end, labour (h), cost (ETB) |
| `cost` | Vehicle driven or costing anything in the month | Distance, fuel cost, maintenance cost, total, cost per km |
| `trips` | Trip scheduled to start in the month | Scheduled, route, vehicle, driver, status, started, ended, planned and driven km, on time |
| `drivers` | Driver who completed a trip, was flagged or had an incident in the month | Trips, distance, driving hours, on-time %, speeding and idling flags, incidents |

**Every report has a totals row:** sums, and the overall ratios worked out again from the sums, never averaged.

**The rules match the dashboard's (FMS-50):**
- **Distance and driving time:** a completed trip counts in the month it ended.
- **Fuel:** a fill-up counts in the month it was logged.
- **Repair cost:** a repair counts in the month it was completed.
- **On time:** a trip is on time when it ended within 15 minutes of its scheduled end.

**When a figure is left blank:**
- **Consumption:** judged only past 100 km driven, and never for an electric vehicle.
- **Cost per km:** shown only past 1 km.

**Open at month end** means opened before the month ended and not completed by then. A cancelled repair is left out, because when it was cancelled is not kept.

## The API

`GET /reports/{report}?month=YYYY-MM&depot_id=&format=json|csv|pdf` needs `analytics:read`. That is held by admin, fleet manager, dispatcher, finance clerk, compliance officer and fleet owner.

- **Month:** this month (up to now) by default. A month not yet begun is `400 future_month`.
- **Depot scope:** the caller's depots; depot-unscoped roles see every depot.
  - `depot_id` narrows the report to one depot.
  - Another depot's or an unknown id gives an empty report, as a filter does elsewhere.
  - A driver sees nothing.
- **Which depot a row belongs to:**
  - the vehicle reports: the vehicle's depot;
  - the trip history: the route's depot;
  - driver performance: the driver's home depot.
- **`json`** (the screen) gives:
  - `columns` (`key`, `label`, `kind`), `rows` and `totals`;
  - the month as `period` instants, and the `depot`;
  - `meta.data_freshness`.

  Values are integers in base units, as in the rest of the analytics API: ml, cents, metres and minutes.
- **`csv`:**
  - the same table with a header row and the totals row, CRLF line ends, and UTF-8 with a byte-order mark for Excel;
  - values in litres, birr, km and hours, without thousands separators, and times in Addis Ababa;
  - text a spreadsheet would run as a formula is defused with a leading `'`.
- **`pdf`:**
  - landscape A4, with the title, then a line naming the depot, the dates, when it was generated and how current the data is;
  - the table with its header repeated on each page, and the totals on the last page;
  - numbers with thousands separators, as people read them (the CSV keeps them plain);
  - page numbers.
- **Files** come as attachments named for the report, month and depot code, such as `fuel-report-2026-10-bol.pdf`, or `all` for every depot. They are sent with `Cache-Control: private, no-store`.

## Where it reads

Reports read the analytics views on the **read replica**, one session per request ([read-replica.md](read-replica.md)). Heavy months never slow dispatch or GPS ingestion. Migration 054 adds the views the reports need, so the analytics module reads only `analytics.*`:

- `maintenance_facts`
- `trip_history_facts`
- `driver_directory`
- `telemetry_flag_facts`
- `incident_facts`
- `depot_directory`

Reports are generated on demand and not cached. A monthly fuel report for 200 vehicles (3,000 fill-ups, 2,000 trips) comes back in well under the card's 10 seconds. `test/integration/reports.test.ts` checks the time for JSON and PDF.

## The PDF writer

`analytics/infrastructure/table-pdf.ts` writes PDF 1.4 by hand, with no library and no new dependency.

- **Fonts.** It uses the standard Helvetica and Helvetica-Bold, which every reader has, so nothing is embedded. It lays out text with their published character widths.
- **Columns.** Number columns keep their width. Text columns share what is left and are cut with "…" when they do not fit.
- **Characters.** Text is Windows-1252: Latin letters, accents, "–", "…" and curly quotes. Any other character, such as Amharic script, is written as "?" in the PDF. The CSV and the screen keep it as it is.

## The screen (S-28)

`/reports` is under Fleet management, for the roles with `analytics:read`.
- **Choosing.** Pick a report (Fuel, Maintenance, Cost, Trip history, Driver performance), a month (last month by default, the last whole one) and a depot (for those who see more than one). All three are kept in the address.
- **Preview.** The table shows the report with numbers formatted for reading and the totals row at the end. It is paged at 25, 50 or 100 rows. Each column keeps its width, so a wide report scrolls sideways on a narrow screen; a name too long for its column is cut with "…" and shown whole on hover.
- **Freshness.** A note says when the data is from, and how far the reporting copy is behind when it lags 5 s or more.
- **Downloads.** *Download CSV* and *Download PDF* fetch the file the server builds, renewing the session if it lapsed, and save it under the server's name.

## Tests

- **Unit:**
  - `analytics/domain/reports.test.ts`: units, Addis Ababa times, ratios, and CSV quoting and defusing;
  - `analytics/infrastructure/table-pdf.test.ts`: structure and cross-reference offsets, pages and totals, escaping and encoding, fitting columns.
- **Integration (`test/integration/reports.test.ts`):**
  - each report's rows and totals, as JSON, CSV and PDF;
  - scope and permissions;
  - month validation;
  - 200 vehicles in under 10 s.
- **Frontend:**
  - the screen: the preview, switching report and month, both downloads, a failed download, an empty month.
