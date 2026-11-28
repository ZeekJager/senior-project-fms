# UAT, release checklist and go-live

Card: FMS-112 (SE-156). Script: `scripts/deploy/release-check.sh`. Builds on the deployment runbook
([deployment.md](deployment.md), FMS-164), backups ([backups.md](backups.md), FMS-108) and monitoring
([observability.md](observability.md), FMS-109).

A release happens on purpose and with sign-off. These are the steps:

1. One person per role runs that role's UAT script and signs it off.
2. The release checklist is green, machine checks and human checks both.
3. A go/no-go meeting decides.
4. Only then is the release tag deployed.

## 1. User acceptance testing

### Where and with what

UAT runs on the UAT environment (today <https://fms.zekarias.tech>), on the release candidate's images and the budget
demo seed with EV ([seed-data.md](seed-data.md)):

```sh
docker compose --env-file prod.env run --rm --no-deps api-1 node dist/scripts/seed.js --size=budget --with-ev
```

The seed prints one account per role, and they all share `FMS_SEED_PASSWORD`. Give each tester the account for their
role, and never production credentials. Test on the devices people will use: drivers on an Android phone in Chrome,
office roles on a laptop.

Steps hand work from one role to the next (D3 to T1, D6 to P6, P4 to M2, D9 to M4), so every tester must be in the same
depot. Use a driver account of the office testers' depot: the admin issues it a setup link from **Users & roles**
(*Create new invitation link*). Before the dispatcher's P4, the admin sets **Settings** › *Driver marked absent* to
*Needs a fleet manager's approval*, and sets it back after M2.

Each tester runs their role's script below, in order. Every step has an expected result. A step that does not give it is
a **defect**. Record it with the step number, what happened, a screenshot and its severity:

| Severity | Meaning | Release |
|---|---|---|
| Blocker | A role cannot do its job, data is wrong or lost, or a permission leaks | No-go until fixed and retested |
| Major | A task works only by a workaround | No-go, unless the go/no-go meeting accepts the workaround in writing |
| Minor | Wording, layout, a slow screen | May ship; logged for the next release |

### Driver (phone)

| # | Step | Expected |
|---|---|---|
| D1 | Sign in, then add FMS to the home screen | **My day** shows today's next trip: times, from and to, the plate |
| D2 | Check in at the depot (scan the depot QR, or the code) | *Checked in* with the time; the dispatcher sees you as available |
| D3 | Pre-trip inspection: mark one item *Problem* with a note, then submit | The vehicle is flagged for maintenance; **START TRIP** is refused with the reason |
| D4 | On a trip whose vehicle is not flagged: pre-trip all OK, then **START TRIP**, allowing location | *On the road*; *Sharing your location with dispatch*; the trip moves on the dispatcher's live map |
| D5 | **Fuel**: litres, total paid, odometer, then **Log fuel**. Try again with a lower odometer | *Fuel logged*; the second is refused for the odometer |
| D6 | **Incident**: a flat tyre, *Moderate*, add my location, **Send report** | Sent; the dispatcher sees it on the map |
| D7 | Turn on airplane mode, log fuel, turn it off | The badge counts it as waiting; it is sent on its own when the signal returns |
| D8 | **END TRIP**, then the post-trip inspection | The trip is completed and the card shows the next one |
| D9 | **My appeals**: appeal one speeding alert, with what happened and a photo, then **Send** | Listed under **My appeals**, waiting for a decision |
| D10 | On D4's trip, type the dashboard odometer before **START TRIP** and again before **END TRIP**. Then try a reading below the vehicle's | Both accepted; the vehicle's odometer is the end reading. The low one is refused, saying it is below the vehicle's |
| D11 | During D4's trip, **Navigate** | The next turn on top, the road to the destination on the map, time and distance left. Away from the road by more than 150 m, a new road within seconds |

### Dispatcher

| # | Step | Expected |
|---|---|---|
| P1 | Open the **Dispatch console** | Today's trips by status; available drivers and vehicles of your depot only |
| P2 | **Create a trip** from a route, for later today | It appears as *Scheduled* |
| P3 | **Assign** a driver and a vehicle | Assigned; the driver sees it on **My day** |
| P4 | Try to assign a driver whose licence has expired. Then assign the driver A1 marked *On leave* to a trip today, and request the exception with a reason | The first is refused, saying why: a safety rule has no exception. The second is held, and the request waits for a fleet manager |
| P5 | **Live map**: follow D4's trip | Its position moves; the speeding and idling flags show on the vehicle |
| P6 | Open D6's incident and **Take it on** | It shows *Taken on by* you; the driver's report is unchanged |
| P7 | Change the URL to another depot's trip | *Not found*: another depot's data is never shown |

### Maintenance technician

| # | Step | Expected |
|---|---|---|
| T1 | **Repair log**: the vehicle D3 flagged is in *Flagged* | It shows the inspection's problem and the driver's note |
| T2 | **Log a repair** for it: corrective, the component and failure, the parts from stock, the labour hours and the cost, then **Save as open work** | The record is *Open*; the stock goes down by the parts |
| T3 | Open it, book the technician's hours, then **Mark as complete** | *Completed*; the vehicle's flag is cleared and it is available again |
| T4 | **Vehicle health**: open a vehicle with a high risk score | The score, its factors and the model version |
| T5 | **Service programs** and **Recalls**: open a vehicle that is due | Its next service by km or date; open recalls listed |
| T6 | Open a fault code alert, if the simulator ran with `--faults` | The code, what it means and the vehicle |
| T7 | **Vehicle health**: open a vehicle, then **Schedule inspection** | The form opens with the vehicle's odometer filled in and says where it came from (D10's trip, a fuel log, a device) |

### Depot admin

| # | Step | Expected |
|---|---|---|
| A1 | **Attendance**: today's roster; mark a driver *On leave*, and **Record leaving** for one with no signal | Each card shows the new state and time, marked *by hand*; D2's check-in is marked *QR scan* |
| A2 | **Drivers**: open one whose licence expires within 30 days | The warning shows; renew it with a new expiry |
| A3 | **Vehicles**: add a vehicle document (insurance, PDF) with its expiry | Listed; it downloads |
| A4 | **Spare parts**: **Adjust** a count with a reason | The quantity changes; **Stock history** shows the movement and the reason |
| A5 | Open the user list | Only your depot's people |

### Fleet manager

| # | Step | Expected |
|---|---|---|
| M1 | **Dashboard** | The KPI band, utilisation and cost charts for every depot |
| M2 | **Dispatch**: open P4's held trip, then **Approve and assign** with a note | The assignment goes through; the approval is audited |
| M3 | **Feedback to drivers**: send one from a template | The driver sees it under **Feedback** |
| M4 | **Score appeals**: decide D9's appeal | The driver sees the decision |
| M5 | **Reports**: export the utilisation report as Excel and PDF | Both files open and match the screen |
| M6 | **Availability**: this week | Each vehicle's available, assigned and in-repair days |

### Finance clerk

| # | Step | Expected |
|---|---|---|
| F1 | **Fuel reconciliation** for last month | Each vehicle's expected and actual fuel, with the variance |
| F2 | Open an anomaly and close it with a reason | *Closed*, with your reason |
| F3 | **Reports**: the cost report as CSV | It opens; the totals match the screen |
| F4 | Try to open a trip or the live map | Not in the menu; the URL is refused |

### Compliance officer

| # | Step | Expected |
|---|---|---|
| C1 | **Audit log**: filter on the last hour | The UAT's own changes, each with who, when and what |
| C2 | Open M2's approval | Before and after values; the person and their IP address |
| C3 | **Sign-ins** and **Denied** | X2's user's refused sign-in; F4's refused request |
| C4 | Try to change anything | Read-only everywhere |

### Fleet owner

| # | Step | Expected |
|---|---|---|
| O1 | **Dashboard** and **Reports** | Every depot's figures, read-only |
| O2 | The cost report (fuel and repairs) | The totals for every depot |
| O3 | Try to create or assign a trip | No such button |

### Admin

| # | Step | Expected |
|---|---|---|
| X1 | **Invite a user** with a role and a depot | The invitation is sent; the link sets a password once |
| X2 | Deactivate that user | Their sessions end; they cannot sign in |
| X3 | **Settings**: change a threshold (speeding) | Saved, audited and in effect for the next ping |
| X4 | **System health** | Every part of FMS working; uptime over 24 hours |
| X5 | **Backups**: **Back up now** | Listed, then finished with its size; **Download** saves it |

### Sign-off

One row per role. Sign once every step has passed, or every defect left is Minor or accepted at the go/no-go.

| Role | Tester | Date | Steps passed | Open defects | Signature |
|---|---|---|---|---|---|
| Driver | | | /11 | | |
| Dispatcher | | | /7 | | |
| Maintenance technician | | | /7 | | |
| Depot admin | | | /5 | | |
| Fleet manager | | | /6 | | |
| Finance clerk | | | /4 | | |
| Compliance officer | | | /4 | | |
| Fleet owner | | | /3 | | |
| Admin | | | /5 | | |

## 2. Release checklist

### Machine checks

Run on the server, from the checkout of the release tag:

```sh
sh scripts/deploy/release-check.sh                # production: every check must PASS
sh scripts/deploy/release-check.sh --allow-demo   # UAT on demo data: demo accounts are a warning
```

It prints PASS, WARN or FAIL per check and exits 1 on any FAIL. It never prints a secret.

| Area | Check |
|---|---|
| Secrets | `prod.env` is mode 600; each secret is set, 32 characters or more, and not a placeholder |
| The release | The checkout is a release tag, and `FMS_IMAGE_TAG` is its commit |
| Containers | Every service is running and healthy; `migrate` exited 0 |
| Database | Every migration is applied |
| Default credentials | No active `@fleet.demo` account (they share the seed password), and at least one named administrator |
| Backups | A backup succeeded in the last 26 hours and a restore drill in the last 31 days |
| Through the domain | `/health/ready` answers 200; `/api/v1/auth/me` answers 401 without a session; plain HTTP redirects to HTTPS; HSTS is sent; TLS 1.1 is refused |
| CSP | Warns until `CSP_MODE=enforce` (a week after launch) |

### Human checks

| Check | How |
|---|---|
| UAT signed off | Every row of the sign-off table, no Blocker or Major open |
| CI green on the tag | Every required check on the tag's commit |
| Alerts reach people | An administrator's **Send a test** push arrives on their browser; the email and SMS providers are healthy on System health; the monitoring lines are set in Settings, *Monitoring* |
| Off-server backups | The latest backup is in the off-server copy ([backups.md](backups.md)) |
| Secrets rotated | Every secret in `prod.env` was generated for production by `scripts/deploy/init-prod-env.sh`, never copied from UAT or a laptop. Anyone who saw a UAT secret does not hold a production one |
| Accounts | Only the people who need access have it; each has their own account |
| Monitoring | The external uptime check watches `/` and `/health/ready` |
| Rollback ready | The previous tag's images are on the server, and the backup of step 1 below is taken |
| TLS grade | A or better at SSL Labs ([deployment.md](deployment.md#ssl-labs)) |

## 3. Go/no-go meeting

Who attends: the product owner, the technical lead, one person who ran UAT for each office role, and whoever deploys.

Agenda (30 minutes):

1. UAT results: the sign-off table, and each open defect with its severity.
2. The checklist: the release check's output and the human checks.
3. Known issues shipping with the release, each accepted by name.
4. The plan: when, who deploys, who verifies, and the rollback trigger (any Blocker found in the first hour).
5. The decision: **go** or **no-go**. A no-go names what has to change before the next meeting.

Record the decision:

| Release | Date | Decision | Accepted known issues | Deployer | Signed (product owner) |
|---|---|---|---|---|---|
| | | | | | |

## 4. Go-live

1. **Tag** the release on `master` once CI is green, and push the tag:
   `git tag -a v1.0.0 -m "FMS 1.0.0" && git push origin v1.0.0`.
2. **Back up** the current database: Back up now, then note the running tag.
3. **Build** the tag's images and set `FMS_IMAGE_TAG` ([deployment.md](deployment.md) phases 5 and 12).
4. **Production data.**
   - A first release starts from an empty database, with no demo seed.
   - The administrator creates the depots, then invites each person with their role and depot. Vehicles and drivers
     follow.
   - If the server ran UAT on demo data, reset it first: stop the stack, remove the `postgres_data` volume, and start
     again.
5. **Start:** `docker compose --env-file prod.env up -d --wait`.
6. **Verify:** `sh scripts/deploy/release-check.sh` shows no FAIL, then the golden path by hand (deployment phase 10).
7. **Watch** the first hour: System health, the error rate and alerts. A Blocker means a rollback (phase 12).
8. **Announce** the release with the tag and what changed, and move the card to Done.

## Tested

- **UAT dry run** of every step on fms.zekarias.tech, 28 November 2026 (release `bf3c23d`, then `9f077c1`), by browser
  sessions signed in as each role, the driver on a phone-sized screen with a scripted GPS track along the Addis
  Ababa – Modjo road. 51 of 52 steps ran: 50 passed, T1 failed, T6 did not run (the server has no fault codes).
  - **T1 (defect, Major or Minor at the go/no-go):** the technician is alerted to *1 defect on the pre-trip
    inspection: Tyres* and the vehicle is under *Flagged*, but the driver's note is on no office screen (only
    `GET /vehicles/{id}/dvir-reports` returns it).
  - **Minor:** P7 opens nothing of another depot's trip (the API answers 404) but says nothing either; F4 and other
    refused screens are blank instead of saying the role has no access.
  - The dry run is not the sign-off: each role's tester still runs their script and signs their row.
- `scripts/deploy/release-check.sh` was run against the UAT stack on fms.zekarias.tech with `--allow-demo`
  (27 November 2026). It passed the secrets, containers, migrations, backup and health checks. It failed, correctly,
  on:
  - no release tag, and an image tag that is not the checkout's;
  - 337 demo accounts and no named administrator;
  - no restore drill yet;
  - plain HTTP answering 200;
  - TLS 1.1 still accepted.

  All of these must be fixed before go-live.
- `packages/backend/scripts/release-check.test.ts` checks that placeholder, short and missing secrets fail, and that
  no secret is printed.
