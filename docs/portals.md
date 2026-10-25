# App shell and portals

Card: FMS-114 (SE-158). Code: `packages/frontend/src/router/routes.tsx` (the route table), `router/navigation.ts` (menus and homes), `components/layout/AppShell.tsx`.

## Portals

The four portals of the architecture (§6, §7) are the sections of the route table and of the menu:

| Portal | Screens | Layout |
|---|---|---|
| Fleet management | Dashboard, Vehicles, Drivers, Attendance, Repair log, Spare parts, Routes, Fuel reconciliation | Staff |
| Command center | Dispatch (S-07), Live map (S-16) | Staff |
| Administration | Users & roles | Staff |
| Driver | My day (S-11; DVIR, fuel and incident forms join here) | Driver |

**Staff layout:**

- From 1024px, a dark sidebar with one titled group per portal.
- From 768px to 1023px, an icon rail, plus a menu button that opens the same labelled slide-in menu as on phones (hover tooltips do not exist on touch).
- Below 768px, a slide-in menu.
- At every width, a top bar with the current portal's name and the notification bell.

**Driver layout:** a phone in a cab.

- A compact top bar with the bell and the account button. The account sheet holds the name and sign-out.
- One centred column.
- A bottom tab bar once the driver portal has more than one screen.

Both layouts work at 375px without sideways scrolling.

## The driver app (installable, offline)

Card: FMS-34 (SE-70). Code: `packages/frontend/src/{service-worker.ts,pwa/}`, `packages/frontend/build/pwa.ts`, `packages/frontend/public/{manifest.json,offline.html,icons/}`.

The driver portal installs to the home screen and opens without a connection, because route buses cross areas with no signal.

- **Only the driver portal.** The driver layout links the web app manifest and registers the service worker (production builds only; the dev server has none). Staff screens never link the manifest or register a worker, and no staff page is ever answered from a cache.
- **Install.** `manifest.json`: "FMS Driver", `start_url` `/driver`, `display: standalone`, brand-coloured icons (192, 512, and a maskable 512). Chrome on Android shows its own "Add to Home Screen" offer, and the driver portal shows an Install card too (dismissible, remembered on the phone).
- **Today's trips on the phone (FMS-35).** My day keeps its last answer (today's trips of the signed-in driver: route, times, stops, vehicle) in `localStorage` (`fms-driver-today`), so with no signal the driver still sees where to be, marked "Saved on this phone at ...". Another account's or another day's copy is ignored. START and END need the server (it records the time) and are disabled offline.
- **Inspections (FMS-37).** The checklists are fixed in the app, so the inspection form opens with no signal for any trip on the phone. Ending a trip keeps a post-trip reminder with the trip's vehicle (`fms-driver-post-trip`, this driver only), so the post-trip inspection opens offline right after END TRIP; submitting it clears the reminder. Reports go through the offline queue (below).
- **Fuel (FMS-40).** Log fuel works offline the same way: the form needs no server data beyond the trip, and the fill-up goes through the offline queue. The server stamps a fuel log with the time it receives it (api-contract §9.1), so one sent after a dead zone carries the time it arrived, not the time at the pump.
- **Incidents (FMS-38).** The incident form needs nothing from the server: with no trip on the phone it reports without a vehicle. It sends `occurred_at` as the moment the driver pressed send, so a report sent after a dead zone keeps when it was reported, and the server recognises a late replay by it (docs/incidents.md).
- **What works offline.** At install the worker caches the built app (scripts, styles, fonts, icons, `index.html`, `offline.html`), one cache per build, and deletes the previous build's. A `/driver...` page tries the network for 4 seconds, then opens from the cache, so the Driver Home loads in airplane mode. Any other page goes to the network, and offline shows `offline.html` (a link back to My day, and Try again). API reads and writes are not cached; what a driver submits offline waits in the offline queue (below).
- **Staying signed in.** See docs/auth.md, Frontend session handling: the driver's session body is kept for up to 7 days and answers a refresh when there is no connection.
- **Offline banner.** "You are offline" shows under the top bar when the phone has no network, or when the server's answers are coming from the saved copy (a network with no internet).
- **No framework.** `build/pwa.ts` lists the built files with a content hash after `vite build`, then bundles `src/service-worker.ts` with that list into `/sw.js`; a changed file changes the worker, so phones pick up each release. The routing rules live in `src/pwa/routing.ts`, unit-tested.
- **Hosting.** Whatever serves the built app in production must send `/sw.js` (and `/manifest.json`) with `Cache-Control: no-cache`, or phones keep an old worker for up to a day. Nothing in the repo serves the build yet (only the dev servers).

### Offline submissions (the queue)

Card: FMS-81 (SE-125). Code: `packages/frontend/src/lib/offlineQueue/` (shared by the page and the worker), `src/pwa/{OfflineQueue.tsx,PendingSubmissions.tsx,queueRunner.ts}`, the `sync` handler in `src/service-worker.ts`.

A driver's forms that create records (inspections FMS-37, fuel, incidents) submit through the queue, so nothing is lost to a dead zone and nothing is recorded twice.

- **Use it.** Inside the driver portal: `const { submit } = useOfflineQueue()`, then `submit({ kind: 'dvir', label: 'Pre-trip inspection, AA 3-10001', path: '/dvir-reports', body })`. It answers `sent` (with the server's `data`), `queued` (kept on the phone), or `rejected` (the server refused it: show why; nothing is kept). The endpoint must take an `Idempotency-Key` (`idempotent()`, FMS-87).
- **Kept until acknowledged.** Each submission goes into IndexedDB (`fms-offline-queue`) with an Idempotency-Key made once, the driver's user id, the path and the body. Never a token: the session stays in its HttpOnly cookies. It leaves the queue only on a 2xx (a replayed answer counts).
- **In order, once.** One sender at a time (a Web Lock shared by the page and the worker), oldest first. A lost answer is retried with the same key, so the server replays its record instead of adding one. The endpoints the queue sends to (`POST /fuel-logs`, `/dvir-reports`, `/incidents`) keep keys 7 days, the longest the queue may hold a submission (FMS-116), so a fill-up that reached the server, lost its answer and is replayed after a long dead zone is answered from the record, not recorded twice. Past 7 days a key is forgotten and the endpoint's own check is all that is left (a trip's inspection of one type is recorded once; an incident is matched by reporter, time and description).
- **When it is sent.** At once when made; when the phone is back online (`online` event, or the server answering again); with backoff after a failure (2 s doubling to 30 s); and by the worker on a Background Sync (`fms-offline-queue` tag, Chrome), so it goes even with the app closed.
- **What stops it.** No answer, 5xx, 408, 429, or the key still in progress: stop and try later, keeping the order. 401: paused. The page renews the session on the way (the API client's refresh); if that is refused the driver signs in again and the queue goes on from where it stopped. The worker never renews a session (a page and a worker refreshing at once look like a stolen token): on a 401 it leaves the queue to an open page. Any other 4xx (validation, permission, a key reused for a different body) is final: the submission is marked "Not sent" with the server's reason, the rest go on, and the driver removes it from the list.
- **Limit.** 50 pending per driver on a phone (CFG-3). The 51st is refused: "50 submissions are already waiting to send. Get signal to send them before adding another." Forms can read `full` to disable their submit button.
- **Per driver.** Signing out keeps the queue: it is sent once the same driver signs in again. Another driver on the same phone never sees or sends it; the worker sends only for the driver whose session it holds.
- **Pending badge.** In the top bar while anything is waiting: the count, an upload icon (spinning while sending), red with a warning icon when something was refused. It opens the list ("Waiting to send", oldest first) with Send now (needs signal).

## Menus are built from permissions

A menu link appears only if the user holds the route's permission (the same codes the API enforces). A portal's section appears only if it has at least one such link. Nobody sees a link that ends in nothing. Routes stay protected on their own (`RoleGate`, FMS-09): a screen opened by URL without the permission renders nothing, and the API refuses its data.

The driver portal is for users who drive (`trip:execute`) and hold none of the staff read permissions (`driver:read`, `maintenance:read`, `inventory:read`, `fuel-anomaly:read`, `users:read`, `audit:read`, `command:read`). Dispatchers hold `trip:execute` too, but they are staff: they never see "My day".

With today's grants (`docs/permissions.md`), the menus are:

| Role | Menu |
|---|---|
| admin, fleet_manager | every staff screen |
| dispatcher | Dashboard, Vehicles, Drivers, Attendance, Routes · Dispatch, Live map |
| depot_admin | all of fleet management · Live map |
| technician | Dashboard, Vehicles, Repair log, Spare parts |
| finance_clerk | Dashboard, Fuel reconciliation |
| compliance_officer | Dashboard, Vehicles, Drivers, Attendance, Repair log, Routes, Fuel reconciliation · Users & roles |
| fleet_owner | Dashboard, Vehicles, Drivers, Repair log, Routes · Live map |
| driver | My day (driver portal) |

`router/navigation.test.ts` reads `docs/permissions.md` and checks these menus. A grant change that moves a screen shows up there.

## Where users land

Signing in without a destination, or opening `/`, goes to the role's home:

| Role | Home |
|---|---|
| driver | `/driver` |
| dispatcher | `/dispatch` |
| technician | `/maintenance` |
| finance_clerk | `/fuel-reconciliation` |
| everyone else | `/dashboard` |

A user with several roles gets the first match in this order: admin, fleet_manager, fleet_owner, dispatcher, depot_admin, compliance_officer, technician, finance_clerk, driver. A home is used only if it is in the user's own menu; otherwise the first link of that menu.

## Adding a screen

1. Add a route to its portal in `routes.tsx`: `path`, `element`, `permission` (the code the API checks) and `nav` (label and icon) if it belongs in the menu.
2. If it changes a role's menu or home, update the expectations in `router/navigation.test.ts` and the tables above.

The Live map (S-16, [live-map.md](live-map.md)) needs `tracking:read` as well as `command:read`; every role with the one has the other. The notification bell is a slot: the inbox (S-17) renders into its panel.
