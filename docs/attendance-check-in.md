# Driver attendance by QR scan (FMS-141)

Card: FMS-141 (SE-185). Code:

- backend, `packages/backend/src/modules/fleet/`: `domain/attendance-code.ts` (the code, its signature and expiry, the late rule), `AttendanceService.code` and `.checkIn`, `api/attendance.routes.ts`;
- frontend: `pages/Attendance/CheckInCodePage.tsx` (S-24), `pages/Driver/CheckIn.tsx` and `scanner.ts` (S-25), the roster card (S-06) and `components/shared/QrCode.tsx`.

Migration 051.

Before this card a supervisor typed every driver's attendance. Now a driver checks in by scanning a QR on a screen at the depot with the driver app, and the time is the server's. It cannot be done from home: the code changes every 30 seconds, only staff can show it, and drivers can no longer type a time.

## The code

The depot screen (`/attendance/qr`, S-24) shows `GET /attendance/qr`'s code as a QR:

```
FMSA1.<depot public id>.<window>.<signature>
```

- `window` is the number of 30-second periods since the Unix epoch; the screen fetches the next code when the server says it is out (`refresh_at`), timed from the server's clock (`generated_at`), so a tablet with a wrong clock still keeps up.
- `signature` is the first 16 bytes of HMAC-SHA256 over `FMSA1|<depot>|<window>`, base64url. The key is derived from `JWT_SECRET` (an HMAC of it with a fixed label), so there is no new secret to deploy; changing `JWT_SECRET` voids every code at once.
- A code is accepted from its window's start for 60 seconds: the window it was shown in and the next. A photo of the screen is useless a minute later.
- Only `attendance:qr` reads it: admin, fleet manager, dispatcher, depot admin. Drivers hold `attendance:read` and `attendance:write` (they record their own day, FMS-21), so the code has a permission of its own, which they never get.
- The screen never shows a code past its life: if the next cannot be fetched, the QR gives way to *Reconnecting*, so nobody scans in vain.

## The scan

`POST /attendance/check-in` with the text the phone read (`attendance:check-in`, drivers only):

1. The code must be one this server signed (`invalid`), still valid (`expired`) and for the depot the driver's account is homed in (`other_depot`). All `400 VALIDATION_FAILED` on `code`, and nothing is written.
2. No record today, or one made by hand without a time: **check in** at the server's time, `check_in_method: qr`, status `present`, or `late` after the depot's `work_starts_at` plus `late_after_minutes` (08:00 and 15 minutes unless the depot says otherwise; Addis Ababa time; 08:15:59 is still on time).
3. Checked in, not out: **check out**, if it is at least 10 minutes since the check-in; sooner is the same scan again (`409`, `just_checked_in`).
4. Checked out: `409`, `already_checked_out`.

The day's row is locked for the scan, and two scans at once cannot both check in (the unique driver and day decides). Every check-in and check-out is an audited write and an `AttendanceRecorded` event with the times and methods.

The depot's start time and grace are set with `PATCH /depots/{id}` (`work_starts_at` as `HH:MM`, `late_after_minutes` 0 to 240).

## The driver app

The *Check in* tab (`/driver/check-in`, S-25), also reached from My day, which shows whether the driver has checked in:

- *Scan depot code* opens the back camera (`getUserMedia`, `facingMode: environment`) and reads a frame every 200 ms: with the browser's `BarcodeDetector` where it reads QR codes (Chrome on Android), with jsQR otherwise (Safari on iOS), loaded only then. Any QR that is not a check-in code is ignored, with a hint. The camera is released as soon as a code is read, on cancel and on leaving the screen.
- Refusals are in the driver's words: the code changed before it arrived (scan again), another depot's code, already checked in or out.
- No signal: refused at once. Unlike fuel logs and inspections, a scan cannot wait in the offline queue, because the code would expire before it was sent. The screen says to ask the supervisor.
- A blocked camera says how to allow it; no camera at all says to ask the supervisor.

## By hand

The supervisor's way when a phone has no signal or no camera. On today's roster (S-06) each card shows the check-in and check-out time and how each was recorded (*QR scan* or *By hand*); staff with `attendance:write` press *Record arrival* or *Record leaving*, which send `check_in_at` or `check_out_at` as now. The API also takes earlier times on `POST`, `PUT` and `PATCH /attendance`: on the record's day, not in the future, a check-out after a check-in. A check-in time without a status makes the day present or late by the depot's rule.

Marking a driver present by hand never sets a time. Otherwise a driver marked present in the morning roll call, who then scanned on arrival, would be checked out instead of in.

A driver cannot type a time, not even for their own day (`403`, `reason: "scan_only"`). They can still mark their own status, as FMS-21 allows; the roster shows such a record with no check-in time and *Marked by* the driver.

## Not covered

- Drivers keep `attendance:write` for their own day (FMS-21). With it a driver can still mark themselves present from anywhere, without a time. Removing it would change FMS-21; the roster shows the difference.
- Location. The code proves the phone saw the depot screen within the last minute, not where the phone is; someone at the depot could send a colleague a live photo. A geofence on the scan would close that, at the cost of the phone's location permission.
- Several shifts a day. One check-in and one check-out per driver and day.
