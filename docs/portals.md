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
- **What works offline.** At install the worker caches the built app (scripts, styles, fonts, icons, `index.html`, `offline.html`), one cache per build, and deletes the previous build's. A `/driver...` page tries the network for 4 seconds, then opens from the cache, so the Driver Home loads in airplane mode. Any other page goes to the network, and offline shows `offline.html` (a link back to My day, and Try again). API reads and writes are not cached; screens that queue work offline (DVIR, fuel: FMS-35+) add their own storage.
- **Staying signed in.** See docs/auth.md, Frontend session handling: the driver's session body is kept for up to 7 days and answers a refresh when there is no connection.
- **Offline banner.** "You are offline" shows under the top bar when the phone has no network, or when the server's answers are coming from the saved copy (a network with no internet).
- **No framework.** `build/pwa.ts` lists the built files with a content hash after `vite build`, then bundles `src/service-worker.ts` with that list into `/sw.js`; a changed file changes the worker, so phones pick up each release. The routing rules live in `src/pwa/routing.ts`, unit-tested.
- **Hosting.** Whatever serves the built app in production must send `/sw.js` (and `/manifest.json`) with `Cache-Control: no-cache`, or phones keep an old worker for up to a day. Nothing in the repo serves the build yet (only the dev servers).

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

Dispatch and Live map are placeholders until S-07 and S-16. The notification bell is a slot: the inbox (S-17) renders into its panel.
