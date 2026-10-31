# The driver's phone as the vehicle's GPS (FMS-57)

Card: FMS-57 (SE-93). Code: `packages/frontend/src/features/phoneGps/` (`broadcaster.ts`, `buffer.ts`, `PhoneGps.tsx`, `LocationBanner.tsx`), the status line on My day (`pages/Driver/Home.tsx`). No backend change: the phone posts to `POST /tracking/gps-pings` like a tracker ([gps-ingestion.md](gps-ingestion.md)).

Not every vehicle has a tracker. While a driver's trip is under way, the driver app reports the phone's position as the vehicle's, so the vehicle moves on the live map (FMS-45), and the speeding and idling rules see it (FMS-46).

## When it runs

- **Only during the driver's own trip under way.** The driver portal (S-11 to S-14) watches the position while today's trips, which are the driver's own (the API's scope), include one `en_route`. Staff portals never do.
- **On every tab.** The watch lives around the driver portal, not on My day alone, so logging fuel mid-trip does not stop it.
- **Ending the trip stops it at once.** When `POST /trips/{id}/end` succeeds the trip leaves the phone's list and the watch is cleared, before the list is fetched again. Positions still on the phone are sent afterwards: the server files each under the trip it was recorded in (FMS-124).
- **Reopened mid-trip, even offline,** the day saved on the phone (FMS-34) still shows the trip under way, so the watch starts again.

## Readings

`navigator.geolocation.watchPosition` with high accuracy (a fix at most 5 s old, a 30 s timeout, which only means "no fix yet").

- **Dropped when imprecise.** A reading whose accuracy (the phone's own estimate, in metres) is above `VITE_GPS_MAX_ACCURACY_M` (100 by default) is dropped, never sent. The API's own limit is 500 m. The 100 m default stands until the physical device test says otherwise; it is configuration, compiled into the bundle.
- **One kept every 10 s,** a tracker device's cadence. The speeding rule counts 3 pings over the limit, about 30 s sustained; phones that report every second would otherwise flag a 3-second overtake.
- **The ping:** `recorded_at` (the reading's time), `lat`, `lng`, `speed_kmh` (the phone's speed, or worked out from the last kept position when the phone gives none, up to the API's 300), `heading`, `accuracy_m`, `altitude_m` (each left out when the API would refuse it). No `vehicle_id`: the server knows the vehicle from the trip, and a wrong one would refuse the batch. No ignition: a phone cannot know, so the idling rule counts it as running.

## Sending

- **At most 6 requests a minute.** A batch goes only when 10 s have passed since the last request; the loop looks every second, and right after a kept reading, so the first position of a trip goes at once.
- **Batches of up to 500,** oldest first: after a long dead zone the backlog drains at 3,000 positions a minute.
- **Kept on the phone until the server takes them,** in IndexedDB (`fms-phone-gps`), per driver: another driver signing in on the phone never sends them. At most 20,000 (about 55 hours); beyond that the oldest go. Apart from the offline queue of forms (FMS-81) on purpose: six batches a minute would fill its 50 places and block the next fuel log.
- **What the answer does.** `202`: the batch leaves the phone, whatever was accepted, kept as a duplicate (a retry stores nothing twice) or refused alone (`no_trip_at_time`, `too_old`). No signal, 5xx, 408, 429 or 401 (the session is renewed on the way): kept for the next try. Any other 4xx (403 `no_trip_under_way`): dropped, or the phone would retry it forever.
- **No signal:** nothing is sent (`navigator.onLine`, or answers coming from the app's saved copy); positions wait.

## What the driver sees

- **My day,** on the trip card while it is under way: *Finding your position…*, *Sharing your location with dispatch* (and how many positions wait for signal), *GPS signal is weak* (readings too imprecise to share), or that location is blocked or missing.
- **A banner on every tab** when the driver blocked location for the app, or the phone has none: dispatch cannot see the vehicle, how to allow it, and *Try again*, which asks the browser once more.

## Physical device test (the card's testing requirement)

Not done yet: it needs a phone, the app on HTTPS (browsers give the position to secure pages only; `localhost` counts) and a driver with a trip.

1. Sign in as the driver on an Android phone (Chrome) and an iPhone (Safari); start the trip; allow location.
2. Walk or drive: the vehicle's marker moves on the live map within about 10 s of each move. *Sharing your location with dispatch* shows on My day.
3. Indoors or in a garage: *GPS signal is weak* while readings are above 100 m; nothing is sent (the network tab, or `accuracy_m` on the stored pings, never above the limit). Note the accuracies seen outdoors and indoors: they decide whether 100 m stays.
4. Airplane mode for a few minutes, then back: *N positions wait for signal*, then the backlog arrives and the vehicle's GPS history (S-22) has the stretch.
5. Count the requests to `/tracking/gps-pings` over a minute: at most 6.
6. End the trip: the browser's location indicator goes off; no request follows except what was waiting.
7. Block location in the browser's settings during a trip: the banner shows; allow it again and press *Try again*.

## Not covered

- **The app in the background.** Mobile browsers pause a page's location when the screen is off or another app is in front; the vehicle stands still on the map until the driver returns to the app. A native app or a tracker is the answer for continuous tracking; a Screen Wake Lock while on the road would help at a battery cost.
- **Two tabs** open on the same phone both watch; the server's unique key (vehicle and instant) keeps the pings from being stored twice.
