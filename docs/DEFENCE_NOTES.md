# Defence notes

Notes for presenting FMS to the senior project evaluators:

1. [The system in two minutes](#the-system-in-two-minutes): what to say first.
2. [Before the demo](#before-the-demo): the checklist for the night before and the hour before.
3. [The Golden Path demo](#the-golden-path-demo): a 10-step live demo, narrated for a non-technical audience. It
   follows the FMS-63 end-to-end workflow: one vehicle from a driver's inspection, through a repair, to a completed trip.
4. [The questions evaluators are likely to ask](#the-questions-evaluators-are-likely-to-ask), with answers.
5. [Performance results](#performance-results): the measured load-test numbers (FMS-61, FMS-152).
6. [Known limitations](#known-limitations): what to say before someone else does.

## The system in two minutes

> Ethiopian transport operators run their fleets on paper job cards, phone calls and spreadsheets. Nobody can say
> where a bus is now, whether the fuel bought matches the kilometres driven, or which truck will break down next week.
> FMS puts the whole working day in one system. The dispatcher assigns the trip. The driver inspects the vehicle and
> drives it, with their phone as its GPS. The technician repairs it. Finance reconciles the fuel. Management sees it
> all on one dashboard. Every change is recorded and can't be edited afterwards.

The numbers behind it:

| | |
|---|---|
| Roles | 9 (admin, fleet manager, dispatcher, depot admin, technician, driver, finance clerk, compliance officer, fleet owner), each seeing only its screens and its depots |
| Permissions | 62, checked on every request, and again per depot |
| Screens | 34 in the [screen inventory](screen-inventory.md), every one working at phone width, in light and dark |
| Backend | 16 modules in one Node.js/TypeScript API, 73 database migrations |
| Tests | 2,034 backend tests passing (13 skipped), plus the web app's component tests and the AI service's pytest suite, on every pull request in 10 CI checks |
| Scale tested | 500 vehicles reporting every 10 seconds to 25 live dashboards: 0 positions dropped, p95 delivery 273 ms |

## Before the demo

**The night before:**

- Pull the latest `master` and start it as the [README](../README.md#quick-start-running-in-five-minutes) says:
  `make dev-bg`, `make migrate`, then `FMS_SEED_PASSWORD=Demo-Pass-2026 make seed`. Seeding sets "today" to the day you
  run it, so **seed again on the morning of the defence**: the trips, attendance and expiries are relative to that day.
- **Activate the two models straight after each seed** (README, step 3). Without that, *Vehicle health* shows no scores
  and the dispatch board shows no trip risk. The scores appear within 10 minutes of the seed.
- Open every screen once, so nothing compiles in front of the audience. The first page of the development server is
  slow.
- Check the dispatcher's depot (Addis Ababa Central) has the driver **Meron Lemma** available and the van
  **AA 3-79079** free. Both are in the seed.

**An hour before:**

- Re-run `make seed` (it wipes the earlier rehearsal), activate the models, and check *Vehicle health* shows scores.
- Open three browser windows, each signed in, side by side if the projector allows:
  1. **Dispatcher** (`kebede.kassa@fleet.demo`), on Dispatch.
  2. **Technician** (`solomon.haile@fleet.demo`), on the Repair log.
  3. **Driver** (`meron.lemma@fleet.demo`), on a phone, or a Chrome window in device mode at 390 px wide. Allow it
     your location.
- Keep a fourth window for the **fleet manager** (`almaz.negash@fleet.demo`) on the Dashboard, for the close.
- Turn off notifications and screen savers on the presenting machine.

**Plan B.** If the network or the stack fails, the [User Guide](USER_GUIDE.md) walks through the same path with
screenshots taken from a rehearsal of this script, on the seeded data, on 13 November 2026.

## The Golden Path demo

About 12 minutes. Each step gives who is acting, what to do, what to say, and what the audience sees. The steps follow
the FMS-63 end-to-end workflow. Where FMS does a step differently, the step says so.

### Step 1. The dispatcher creates and assigns a trip

**Who:** Dispatcher. **Do:**

1. On **Dispatch**, select **New trip**, then **One-off trip**: from *Addis Ababa Central depot* to *Bole International
   Airport cargo terminal*, leaving in five minutes, back in an hour and a half, 800 kg of general goods.
   **Create trip**.
2. Select the new trip, then **Meron Lemma**, then the van **AA 3-79079**, then **Assign**.

**Say:** "The dispatcher sees who is free *for this trip*. Not just today: free at that hour, with a licence that covers
this vehicle, under their driving limits. Busy or unqualified drivers are not offered. If the dispatcher tried anyway,
the server would refuse, and say why."

**They see:** the trip move to *Assigned*. ([screenshot](user-guide/images/dispatcher-04-assigned.png))

### Step 2. The driver inspects the vehicle and finds a problem

**Who:** Driver, on the phone. **Do:**

1. *My day* shows the trip. Select **Pre-trip inspection**.
2. Mark every item **OK** except **Brakes**: **Problem**, *"Brake pedal goes soft and the van pulls to the left"*.
3. **Submit inspection**.

**Say:** "This replaces the paper checklist. It works with no signal: it waits on the phone and is sent, once, when the
signal returns."

**They see:** *Inspection sent. Maintenance has the problem you reported, and the vehicle is flagged.*
([screenshot](user-guide/images/driver-04-inspection-sent.png))

### Step 3. The vehicle is flagged, and can't be driven

**Who:** Driver. **Do:** go back to *My day* and select **START TRIP**.

**Say:** "The vehicle was flagged the moment the inspection arrived, in the same database transaction. The server
refuses to start a trip in a flagged vehicle: the phone can't get around it."

**They see:** *This vehicle is flagged for maintenance. Do not drive it: call dispatch.*
([screenshot](user-guide/images/driver-05-start-refused.png))

### Step 4. The technician sees the flagged vehicle

**Who:** Technician. **Do:** show the **bell**: *Defects reported on AA 3-79079*, a high alert. On the **Repair log**,
select **Flagged vehicles**.

**Say:** "Nobody phoned the workshop. The technicians and the depot admin were alerted by the inspection itself."

**They see:** AA 3-79079 under *Flagged*. ([screenshot](user-guide/images/technician-02-flagged.png))

### Step 5. The technician repairs it and completes the job

**Who:** Technician. **Do:**

1. **Log a repair** for AA 3-79079: *Repair*, 2 hours.
2. What failed: *Brakes*, *Worn out*, found by *Driver inspection (DVIR)*. Cost ETB 3,500.
3. **Save and complete…**, then confirm.

**Say:** "Recording *what* failed isn't paperwork: it's the history the predictive model learns from. Completing the
last open job on a vehicle clears its flag, in the same transaction as the repair."

**They see:** the confirmation *This clears AA 3-79079's maintenance flag*, then the repair under *Completed*.
([screenshot](user-guide/images/technician-05-confirm.png))

### Step 6. The vehicle is available again

**Who:** Dispatcher. **Do:** on **Dispatch**, select the trip: the van is no longer flagged.

**Say:** "The dispatcher's board shows the van free again, because the board reads the same state the repair just
changed."

**Different from FMS-63:** the card has the fleet manager *notified* that the vehicle is available. FMS doesn't send
that notification. A repair's completion shows on the dispatch board and the live map, and in the audit log. Say so
if asked. It is a small addition: an alert rule on the repair-completed event.

### Step 7. The trip is assigned: the van and the driver are ready

The van stayed on the trip from step 1, which a flagged vehicle may stay on (it just can't start). The card assigns the
trip only here; in this demo it was assigned first, because the inspection is of the trip's vehicle.

**Say:** "Nothing to re-do: the trip, the driver and the van are as dispatch left them."

### Step 8. The driver starts the trip, and the van appears on the live map

**Who:** Driver, then Dispatcher. **Do:**

1. On the phone, **START TRIP**. The card turns to *On the road · Sharing your location with dispatch*.
2. On the dispatcher's window, open **Live map**, then **Focus on driver** under AA 3-79079.

**Say:** "The phone is the vehicle's GPS: no hardware to buy. Its positions go to the server, through the event outbox
and Redis, to every dashboard watching this depot, live. At 500 vehicles, a position reaches the dashboards in under a
third of a second."

**They see:** the van moving on the map, *Moving*, with its speed, the trip and the GPS track.
([screenshot](user-guide/images/dispatcher-06-focus.png))

Move the phone, or set its location in Chrome's device tools, to show the van move.

### Step 9. On the way: fuel and a road hazard

**Who:** Driver. **Do:**

1. **Fuel** tab: 45 L, ETB 4,950, the odometer. **Log fuel**.
2. **Incident** tab: *Road hazard*, *Minor*, *"Large pothole on the Bole road..."*. **Send report**.

**Say:** "Each fill-up is checked as it arrives: the price per litre, a refuel too soon, a fill-up far from where the
GPS had the van. At the month's end, finance reconciles all of it against the trips."

**They see:** the incident appears on the dispatcher's live map, under *Incidents*.

### Step 10. The driver ends the trip

**Who:** Driver. **Do:** **END TRIP**.

**Say:** "Ending the trip asks for the post-trip inspection, so the next driver gets a checked vehicle."

**They see:** the *post-trip inspection* prompt ([screenshot](user-guide/images/driver-13-post-trip-prompt.png)).

**Different from FMS-63:** the card has a *fuel entry* prompt after the trip. FMS prompts for the post-trip
inspection instead. Fuel is logged when the driver fills up, which can be during the trip, as in step 9. Logging fuel
after the trip ended needs the vehicle's next trip, because fuel is logged against the driver's trip.

### Close: the management view (1 minute)

**Who:** Fleet manager. **Do:** the **Dashboard**, then the **Audit log** (as admin or compliance officer), filtered to
the vehicle.

**Say:** "Every step we just took is here: who, what, when, from which device, the fields before and after. The audit
log is written in the same transaction as each change, and the application's database role can't update or delete
it."

## The questions evaluators are likely to ask

### 1. "Why a modular monolith and not microservices?"

One team, one deployable, one database, and **transactions that span a change and its consequences**. Assigning a trip
updates the trip, the availability read model, the audit log and the event outbox atomically. With microservices that
would need distributed transactions or sagas, for a fleet of hundreds of vehicles, not millions of users.

The boundaries are still real:

- each of the 16 modules owns its own PostgreSQL schema;
- modules call each other only through their public `index.ts`;
- two lint rules fail the build on a cross-module import or a cross-schema SQL query.

A module could be split out later along those lines. The one service that *is* separate, the AI service, is separate
for a reason: Python's ML stack, and a model that can change without a release of the core (ADR-02).

### 2. "How do you guarantee a driver or vehicle is never double-booked?"

Three layers:

1. **The service** checks the rules before assigning (BR-1, BR-3), from one function shared by the dispatch board and
   the assignment itself.
2. **The database** backs it up with exclusion constraints on time ranges (`tstzrange`, inclusive, so even a 0-minute
   overlap is refused). Two dispatchers pressing *Assign* at the same instant can't both succeed.
3. **The tests:** `trip-assignment-race.test.ts` fires concurrent assignments over HTTP against a real database. The
   interval cases (exact, partial, contained, the 0-minute gap that counts, the 1-minute gap that doesn't) run against
   PostgreSQL, not mocks.

### 3. "What happens to a real-time update if the server crashes mid-way?"

The **transactional outbox**. The change, its audit row and its event are written in one transaction. If the change
rolls back, there is no event; once it commits, the event is in `events.outbox` and can't be lost. A relay broadcasts
outbox rows to Redis, and every API instance forwards them to its sockets; it also dispatches them to in-process
consumers. Progress is recorded per row and per consumer. A relay that dies is replaced and resumes at the first
unfinished row. Delivery is at least once, in order per vehicle or trip, and consumers ignore an event they already
handled.

### 4. "Drivers lose signal. How do you avoid losing or duplicating what they submit?"

- **Nothing is lost.** Every inspection, fill-up and incident goes into an **offline queue** on the phone (IndexedDB)
  and leaves it only when the server acknowledges it.
- **Nothing is duplicated.** Each submission carries an **Idempotency-Key** made once on the phone. A retry after a
  lost answer gets the original record back, not a second one. The server keeps keys for 7 days, the longest the queue
  holds anything.
- **Order is kept.** One sender at a time, oldest first.
- **The record keeps the real time.** A fill-up keeps the time the driver pressed the button, not when it arrived.

The app itself installs as a PWA and opens offline with the day's trips saved on the phone.

### 5. "Why use phones as GPS instead of tracking hardware?"

Cost and speed of adoption: every driver already has a phone, and the MVP scope rules out buying hardware. But the
design doesn't depend on phones. Positions arrive through one ingestion path, and telematics providers plug in as
**signed webhooks**, with a device registry linking their trackers to vehicles and a circuit breaker per provider (the
Telematics screen). The GPS simulator posts through that same provider path. Imprecise phone readings (worse than
100 m) are dropped, and a ping that would need an impossible speed is ignored when measuring distance.

### 6. "How do you know the audit log hasn't been tampered with?"

Three reasons:

- **It is written in the same transaction as the change.** A change can't commit without its audit row, nor the
  reverse.
- **The application can't edit it.** The API connects as a role with INSERT-only rights on the audit tables: no
  UPDATE, no DELETE. Even a bug or an injection in the app can't rewrite history. Only the schema owner could, and the
  running app never connects as it.
- **It covers more than data changes.** It records sign-ins, refused requests and scheduled jobs, with the request id,
  IP and device.

### 7. "How does the predictive maintenance model work, and how good is it?"

- **The model:** a scikit-learn random forest, chosen because it handles mixed, non-linear inputs, needs little
  tuning, and shows which inputs matter. It predicts the chance of an unplanned failure in the next 30 days from 19
  inputs the core computes nightly: kilometres and days since each part was renewed, fault reports, age, usage. The
  health score is `(1 − p) × 100`; under 75 raises a risk alert.
- **The data:** a fleet this new has no failure history yet, so it trains on a **generated** dataset of 12,000 rows,
  built from one shared feature spec and checked for quality.
- **The results:** ROC-AUC **0.83** on vehicles it hasn't seen (the bar was 0.75). At the alert line, precision is 0.50
  and recall 0.66.
- **What keeps it honest:** the model registry records which model, data and metrics produced every score. The core
  refuses a model whose feature spec doesn't match its own. Every failure a technician records becomes real training
  data.
- **The second model** (trip risk) works the same way. It shows *Not enough trips yet* until the fleet has 2,000
  completed trips by 20 drivers.

### 8. "How is it secured?"

- **Sign-in:** argon2 password hashes, and sessions in HttpOnly cookies (no token for a script to steal), with refresh
  rotation and reuse detection. Sign-in is throttled after 5 failures.
- **Every request:** CSRF tokens, permission checks *and* depot scope (a dispatcher can't read another depot's trips,
  even by guessing an ID: access tests call every route as every role). Rate limits per kind of client, and allow-lists
  for sorting and filtering.
- **Data:** licence and phone numbers are encrypted in the database. Driver location history is deleted after 180
  days.
- **The build:** a dependency audit and a secret scan on every pull request, and production images scanned with Trivy
  and run as non-root.

### 9. "Will it scale?"

It was measured, not assumed ([Performance results](#performance-results)). At 200 vehicles and at 500 every budget
was met.

The 500-vehicle run first *failed*: the relay that broadcasts events handled about 21 a second against the 50 that 500
vehicles send. It was redesigned (separate broadcast and dispatch loops, batched broadcasts, parallel dispatch per
vehicle) and then met every budget, at about half a CPU core. The API is stateless behind Redis, so more instances
can be added; the next limits are written down in [load-testing.md](load-testing.md).

### 10. "How did you make sure it's correct, and fits Ethiopia?"

**Correctness:**

- **Tests and CI:** 2,034 backend tests against a real PostgreSQL, each rolled back. Component tests for every screen
  and pytest for the models. 10 CI checks that must pass before anything merges: lint, types, tests, migrations up and
  down, the Docker stack booting, the production images, the load test, a dependency audit, a secret scan and the
  documents' lint.
- **The contract:** every API route is checked against the OpenAPI spec.
- **Money:** in integer cents and fuel in millilitres. A lint rule refuses floating-point arithmetic on money.

**Fitting Ethiopia:**

- times in **Addis Ababa time**, money in **birr**;
- **Ethiopian licence classes** checked against what each vehicle carries;
- Amharic place names on the map;
- an app built for **areas without signal**.

### If there is time: "What would you do next?"

- Run the FMS-63 Golden Path as an **automated end-to-end test**. Today it is rehearsed by hand and covered by
  integration tests step by step.
- Retrain the models on the fleet's **own** failures and trips as they accumulate.
- Add the "vehicle available again" notification (step 6) and a post-trip fuel prompt (step 10).
- Run the 500-vehicle load test on production-like hardware, not a laptop.

## Performance results

Measured with the load suite (FMS-61, [load-testing.md](load-testing.md)) on a development laptop: Intel i5-10300H, 8
threads, 40 GB; Windows 11; PostgreSQL 16 and Redis 7.4 in Docker on the same machine, which also generated the load.
That is a harder setting than a server. A run fails if any budget is missed.

### 200 vehicles (`full` profile, FMS-61), 13 November 2026

The workload:

- **GPS:** 200 vehicles ping every 10 s for 5 minutes, while 25 dashboards watch the live map.
- **API:** 50 users list trips and vehicles and log fuel.
- **Dashboards:** 20 users open the Fleet Command Center and the analytics dashboard.

The results:

| Budget | Limit | Measured (p95) |
|---|---|---|
| Positions dropped | 0 | **0** |
| GPS position delivered to dashboards | < 500 ms | **244 ms** |
| API CPU | < 80% of a core | **33%** |
| `GET /trips` | < 200 ms | **44 ms** |
| `GET /vehicles` | < 500 ms | **46 ms** |
| `POST /fuel-logs` | < 400 ms | **74 ms** |
| A dashboard page loaded | < 2 s | **46 to 65 ms** |
| Failed requests, dashboard disconnects | 0 | **0** |

The first run, on 11 November, also passed, but with delivery at 461 ms against 500. That narrow margin is what led to
measuring 500 vehicles.

### 500 vehicles (`fleet500` profile, FMS-152, NFR-3)

The workload: 500 vehicles every 10 s for 5 minutes, with 25 dashboards watching. That is 14,991 pings and 374,775
deliveries.

| Budget | Limit | 12 Nov: before the fix | 13 Nov: after the fix |
|---|---|---|---|
| Positions dropped | 0 | 350,075 of 374,700 | **0** |
| Delivery to dashboards, p95 | < 500 ms | 28.8 s | **273 ms** |
| API CPU, p95 | < 80% | 43% | **55%** |
| Fleet Command Center loaded, p95 | < 2 s | | **78 ms** |
| Analytics dashboard loaded, p95 | < 2 s | | **49 ms** |
| Slowest analytics report, p95 | < 200 ms | | **46 ms** |
| Failed requests | 0 | | **0** |

The reports are kept in [load-reports/](load-reports/), before and after.

**How to tell it:** "We set budgets first, then measured against them in CI. At 500 vehicles we failed, found why, and
fixed it. The API wasn't the problem; the event relay was. After the fix, positions reach dashboards *faster* at 500
vehicles than they did at 200 before it."

## Known limitations

Say these before someone else does.

- **The models train on generated data.** They are honest about it: the registry records it, and the trip risk model
  shows a notice until real data suffices. The pipeline is built for real data to replace it.
- **The Golden Path is not yet an automated end-to-end test** (FMS-63). Each step is covered by integration tests, and
  the path was rehearsed by hand through the real UI on 13 November 2026.
- **Two notifications from the FMS-63 workflow aren't sent:** "vehicle available" after a repair, and a fuel prompt
  after a trip. See steps 6 and 10.
- **Long routes and the default driving limits.** With the default daily limit (500 km) and the weight for heavy jobs
  (1.5), a trip of 351 km counts as 526.5 km. So the seeded Addis Ababa to Jimma, Woldia and Mekelle trips can't be
  assigned to anyone until the limits are adjusted in **Settings → Driving distance limits**. That is the rule working
  as configured, but the defaults suit day trips better than long hauls. Don't demo with those routes.
- **One laptop.** The load tests ran on a development laptop generating its own load. A 2-core CI runner is untested at
  500 vehicles.
- **Out of scope by decision:** native apps (the PWA instead), payroll, accounting integration, and a public booking
  portal ([fms-mvp-spec.md](fms-mvp-spec.md)).
