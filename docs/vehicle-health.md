# Vehicle health (S-19, FMS-56)

Card: FMS-56 (SE-92). Code:

- `packages/frontend/src/features/health/`: the badge, the breakdown drawer, the bands and labels;
- `packages/frontend/src/pages/PredictiveMaintenance/`: the screen, and the panel that adds "Schedule inspection";
- the Health column in `pages/Vehicles/columns.tsx`;
- backend: `GET /vehicles/{vehicle_id}/maintenance-risk` (maintenance module) and the `health` filter and `health_score_updated_at` on `GET /vehicles` (fleet module).

The nightly scoring ([ml-scoring.md](ml-scoring.md)) gives every vehicle in service a health score: `round((1 - p) * 100)`, where `p` is its chance of an unplanned breakdown in the next 30 days. These screens show that score so technicians and fleet managers can service the riskiest vehicles first, not only the ones with the most kilometres. Nothing here calls the model, and nobody can change a score by hand.

## The badge

The same badge everywhere a score is shown:

| Score | Badge |
|---|---|
| 85 and up | green |
| 75 to 84 | amber |
| below 75 | red: a technician has been alerted ([alerts.md](alerts.md)) |
| scored more than 25 hours ago | grey, **STALE**, the old score struck through, whatever its value |
| never scored | a dash ("Not scored yet" for screen readers) |

- **Colour is never the only signal.** The number and the word say it. The badge's accessible name reads like "Health score 60, at risk, scored 3 h ago".
- **Bands match the API.** The bands are `HEALTH_BANDS` in the fleet module and the same values in `features/health/health.ts`, so a view's count is what its badges show. A stale score counts only as stale, never as at risk.

## Who sees what

| | Badge | Breakdown, Vehicle health screen |
|---|---|---|
| Admin, fleet manager, depot admin, technician, compliance officer, fleet owner (`prediction:read`) | yes | yes |
| Dispatcher | the badge on Vehicles (`vehicle:read`), not a button | no: the API answers `403` |
| Finance clerk, driver | no (no Vehicles screen) | no |

"Schedule inspection" also needs `maintenance:write` (technicians, depot admins, fleet managers, admins).

## Vehicles (S-04): the Health column

A Health column between Status and Current trip, sortable by score. It is hidden on phones, and tables can drop it in the column options. With `prediction:read` the badge is a button that opens the breakdown; a click elsewhere on the row still opens the vehicle. The CSV export includes the score.

## Vehicle health (S-19)

`/predictive-maintenance`, in the menu as **Vehicle health**, next to Repair log.

- **Views,** each with its count: All, At risk, Watch, Healthy, then Stale and Not scored after the divider. They are the API's `health` filter, kept in the URL with the search, depot, sort and page.
- **The list** is sorted riskiest first: health score ascending, unscored vehicles last, plate to break ties. Each row has the vehicle, its badge, the breakdown risk in a word (High at 40 and below, Medium, Low), the depot and when it was last scored. At-risk rows are lightly tinted.
- **The header** says when the fleet was last scored, and which model is active (`GET /ml-models?status=active`).
- **A row,** its badge or its View button opens the breakdown.

## The breakdown

A drawer, from either screen:

- **The gauge.** A 0 to 100 arc in the band's colour, drawn in when the drawer opens; reduced motion shows it at once. A tick marks 75, the alert line. It is grey for a stale score, which also gets a note that last night's scoring missed the vehicle.
- **The facts.** Risk level, the breakdown chance within 30 days, when it was scored (date and age, in the user's calendar), and the model version.
- **What drives it.** Up to 3 inputs that raise this vehicle's risk most, largest effect first, each with the vehicle's value when scored ("Time since last service · 100 days", "Distance since oil change · 17,380 km"). They come from the ML service's `factors`: each one, set back to a typical vehicle's value, lowers the risk the most. A healthy vehicle has none, and the drawer says nothing stands out.
- **What the inspection found (FMS-128).** Under the breakdown of a **high-risk** vehicle (medium and low are not asked about: only a flag is judged) the panel asks what the inspection found, so the system can tell whether the prediction was right ([ml-scoring.md](ml-scoring.md#feedback-from-technicians-fms-128)):
  - A technician (`maintenance:write`) chooses **Found a problem**, **Nothing wrong**, **Already fixed** or **Not inspected**. For a problem they may name the part of the vehicle and the failure record it led to (the vehicle's latest ten, from `GET /failure-events`; choosing one fills in and locks the part, which follows the record), and add notes. **Save** sends `POST /maintenance-predictions/{prediction_id}/feedback`.
  - Once given, the panel shows what was found, with who can change it: its author sees "You can change it until …" and **Change** for 7 days (the form comes back filled in; **Save changes** is a `PATCH`). Nobody else can change it.
  - Someone without `maintenance:write` (a fleet owner, an auditor) sees nothing to fill in, only what was found once someone has said.
  - Two technicians answering the same prediction: the second is told it is already recorded and sees the first's answer. A change after the week is refused the same way.
- **Never scored:** an empty state saying the nightly scoring has not reached it yet.
- **Footer actions:**
  - **View maintenance history** opens the Repair log filtered to the vehicle.
  - **Schedule inspection** (`maintenance:write`, scored vehicles only) opens the repair form (FMS-24) on the vehicle, as an `inspection`, with the reason filled in: "Inspection: health score 60 (at risk), mostly time since last service, distance since oil change." Saving it is an ordinary repair record, so the vehicle's maintenance flag is set until the work is completed (FMS-22).

## Tests

- `features/health/health.test.ts`: bands, staleness and views, factor labels and values, ages.
- `pages/PredictiveMaintenance/PredictiveMaintenancePage.test.tsx`:
  - riskiest first, with the band colours, STALE and not scored;
  - views and their counts;
  - the breakdown's gauge, facts and factors in order;
  - stale and never-scored breakdowns;
  - Schedule inspection prefilling the repair form;
  - the menu for each role.
- `pages/Vehicles/VehiclesPage.test.tsx`, Health column: a dispatcher sees the coloured badge but no button; `prediction:read` opens the breakdown.
- `src/router/navigation.test.ts`: each role's menu.
- Backend `test/integration/maintenance-risk.test.ts`:
  - the latest prediction with its factors' values and units;
  - stale, and never scored;
  - `403` for a dispatcher, `404` for another depot's vehicle or a bad id;
  - the `health` filter's five disjoint views, and `health_score_updated_at` on the list.
