# Shared UI components: money, fuel and status

Card: FMS-11 (SE-47). Code: `packages/frontend/src/components/shared/`. Import from `@/components/shared`. Built on the design system in `docs/design-system.md` (`@/components/ui`).

Money is stored as integer Ethiopian cents and fuel as integer millilitres (api-contract §3.5). These components are the only place the frontend turns those integers into text and back, so a rounding bug cannot exist on one screen and not another.

| Component | Props | Notes |
|---|---|---|
| `MoneyDisplay` | `amountMinorUnits` (cents), `unit="ETB"` | `ETB 1,234.50`, right-aligned, tabular digits |
| `FuelDisplay` | `amountMinorUnits` (ml), `unit="L"`, `decimals` 2 or 3 | 23500 ml is `23.50 L`. Litres is the assumed default until the unit setting exists (SE-75) |
| `MoneyInput` | `label`, `value` (cents or null), `onChange(cents or null)`, `required`, `error`, `disabled`, `name`, `hint`, `hideLabel` | Typing `149.99` emits `14999`; at most 2 decimals. A minus sign is refused with its own message ("An amount cannot be negative.") and emits `null`. Floating-label look with `ETB` inside the field (FMS-24) |
| `FuelInput` | same, millilitres | Typing `23.5` emits `23500`; at most 3 decimals |
| `OdometerInput` | same, tenths of a km | Typing `123456.7` emits `1234567`; at most 1 decimal; `km` inside the field. Send `tenths / 10` as `odometer_km` (FMS-40) |
| `StatusBadge` | `status` | One colour per status; see below |

## Rules the components enforce

- **No float anywhere.** The inputs keep the typed *text* in state and build the integer by joining digit strings (`decimal.ts`). A multiplying parser stores 1.005 as 100 cents, because `1.005 * 100` is `100.49999999999999`. The displays format with integer arithmetic too. They do not call `toBirr`/`toLitres` from `lib/units.js`, because those divide as floats and `toFixed` rounds 23.505 L to `23.50`.
- **Never silently round.** An input with too many decimals shows an inline error and emits `null`; it does not round to what the user did not type. `null` also means "empty".
- **A value is emitted on every keystroke** once the text is valid, so a form submitted with Enter has it. Blur only tidies the text (`149.9` becomes `149.90`).
- **A non-integer display value renders `—`.** Passing `149.99` to `MoneyDisplay` shows a dash, not a plausible-looking wrong amount.
- Errors are announced through an `aria-live` region that exists before the error does.

## Status colours

`STATUSES` lists every status and `STATUS_STYLES` gives each one a colour, label and Tailwind classes. The style table is a `Record` over every status, so adding a status without a colour is a compile error, and the inline snapshot in `StatusBadge.test.tsx` changes, so a new colour has to be reviewed:

| Status | Colour |
|---|---|
| `draft`, `scheduled` | grey |
| `assigned` | blue |
| `en_route` | yellow |
| `completed` | green |
| `cancelled` | red |
| `flagged` | orange |
| `active` (vehicle) | green |
| `inactive`, `retired` (vehicle) | grey |
| `maintenance` (vehicle) | orange |
| `open` (maintenance) | blue |
| `in_progress` (maintenance) | yellow |

The badge always shows its label as text, so colour is never the only signal.

## Examples page

`/dev/ui` shows every component in each state. It exists only under `npm run dev`; the production build leaves it out.

## Tables, states and dialogs

Built with the vehicle screen (FMS-18) on the design system (`docs/design-system.md`), and completed to the FMS-67 spec (SE-111). Examples of every state are on `/dev/ui`.

| Component | Props | Notes |
|---|---|---|
| `DataTable` | `columns`, `data`, `rowKey`, `caption`, `isLoading`, `isEmpty`, `error`, `onRetry`, `emptyState`, `pagination`, `sort`, `rowHeight`, `tableId`, `onRowClick`, `rowLabel`, `rowClassName`, `selection` | Fixed layout (no sideways scroll on a desktop). Columns can hide below a breakpoint |
| `EmptyState` | `icon`, `heading`, `description`, `action` | One heading, a short why, the next step |
| `ErrorBoundary` / `ErrorState` | `resetKey`, `onReset` / `error`, `onRetry` | Shows the error code and the request id (`ApiError.requestId`: the API's `meta.request_id`, the audit log's `correlation_id`), with "Copy error details". The app shell wraps every screen in one, reset on navigation. "Try again" calls `onReset` first (refetch, clear bad state), then renders the children again |
| `ConfirmDialog` | `open`, `onClose`, `title`, `message`, `action`, `onConfirm`, `requireTyping`, `error`, `busy` | With `requireTyping` (e.g. `DELETE`, a plate), confirm stays disabled until the text matches exactly, and a hint under the field says so. `error` shows inside the dialog, never as a toast |
| `useCursorPages` | | The cursors of the pages seen, for cursor paging: `cursor`, `pageIndex`, `next(cursor)`, `previous()`, `reset()` (on new filters) |

### Power features

- **`onRowClick`**: a click on a row (outside its own buttons, links and inputs) calls it. The keyboard does the same: `J` and `K` move through the rows, `Enter` opens the marked one, `Esc` lets go. Ignored while typing in a field or when a dialog is open. A live region says "Row 2 of 24: AA 3-20212. Press Enter to open." (`rowLabel`).
- **`tableId`** adds *Table options* to the footer: row height (comfortable 56px or compact 44px; touch screens keep 56px) and which **optional** columns show (`optional: true`, `label`). Remembered per device. Compact keeps skeleton and data rows the same height, so nothing jumps.
- **`selection`** `{ selected, onChange }` adds a checkbox column with select-all for the page (mixed state included). Vehicles uses it for **Export CSV** of the ticked rows (`lib/csv.ts`: quoted, formula-safe, BOM for Amharic).
- **`sort.then` / `sort.onThen`**: Shift+click a header for a second sort (a "2" marks it). Vehicles sends it as `then_by` and `then_order`.
- **`rowClassName`** tints rows that need attention.
- One page of results shows only the count ("1–12 of 12"): no arrows and no "Page 1 of 1".

### Rows never move when data arrives

Skeleton rows and data rows share one height, so the page does not jump when a load finishes. `rowHeight` sets it:

- `regular` (default) is 56px.
- `stacked` is 72px on phones and 56px from `sm` up. Use it for tables whose first cell stacks a third line (a badge) on phones: Users and Spare parts do.

In development, `DataTable` warns in the console when data rows come out taller than its loading rows, naming the table. Measured on every list screen at 1440px and 390px (SE-111), the two heights are equal.

### Paging

- Numbered pages, `pagination: { page, pageSize, totalItems, onPageChange }` (api-contract §18). Shows "1–25 of 312" and the page count.
- Cursor pages, `pagination: { kind: 'cursor', pageIndex, pageSize, hasNext, onNext, onPrevious }`, for APIs that page by cursor (the audit log). Shows "51–100 · more after", with no total.

### Accessibility

- The table has a visually hidden caption and `aria-busy` while loading.
- Sortable headers are buttons with `aria-sort`, and paging is a labelled `nav` with labelled buttons.
- A polite live region (no status role, so the toast region keeps it) announces loading, the rows shown ("Drivers: 26–50 of 112.") or "nothing to show". A filter that empties the table is heard, not just seen.
- `ErrorState` is an alert. Copying the details is announced.
- Dialogs trap focus, start on the type-to-confirm field when there is one, close on Escape and give focus back on close.

## Fleet map

Card: FMS-44 (SE-80). Code: `packages/frontend/src/components/FleetMap/`. Import from `@/components/FleetMap`. Leaflet 1.9 with react-leaflet 4 (react-leaflet 5 needs React 19), over OpenStreetMap tiles. Example on `/dev/ui`.

The map only draws what it is given. The page that shows it (the Fleet Command Center, FMS-45) owns the socket and passes the vehicles as a prop; the map never connects to Socket.IO.

| Prop | Notes |
|---|---|
| `vehicles` | `{vehicleId, lat, lng, speedKmh, lastSeen, plateNumber?, heading?, stoppedSince?, breakdown?, speeding?, details?}[]`. From `vehicle.location.updated` (`docs/realtime.md`): `vehicle_id`, `lat`, `lng`, `speed`, `heading`, `recorded_at` as `lastSeen`. `details` (`{label, value}[]`, such as the driver and route) appear in the popup. Keep an unchanged vehicle's object between renders: a marker redraws only when its vehicle, state or selection changes |
| `onVehicleClick` | Called with the `vehicleId` when a marker is clicked, or focused and activated with Enter or Space |
| `className` | Sizes the map; it fills the box and needs a height (at least 256px) |
| `label` | The map region's accessible name; "Fleet map" by default |
| `selectedVehicleId` | The vehicle whose popup is open (FMS-45): plate, state, speed, last seen and its `details`. The popup follows the vehicle and stays open while it is selected; the parent's choice decides. If the vehicle is off screen, the map flies to it (no animation with reduced motion). Its marker gets a focus ring, sits on top and shows no tooltip |
| `onSelectionClose` | Called with the `vehicleId` when the user closes that popup: its close button, Escape on the map, or a click on the map |
| `ref` | The Leaflet map once it exists, for anything else the page needs (`flyTo`, `fitBounds`) |

**Marker colours.** Each marker is worked out from the vehicle's last ping, in this order:

| State | Colour | When |
|---|---|---|
| Breakdown | red, with a ring | `breakdown` is set (FMS-50). Shown even when the phone has gone quiet |
| Offline | grey | No ping for more than 2 minutes. The map re-checks every 10 s, so a vehicle turns grey without new data |
| Speeding | red, pulsing (a still ring with reduced motion) | `speeding` is set: an open speeding flag (FMS-46). Not over an out-of-date position: an offline vehicle is grey |
| Idling | amber | 0 km/h for more than 5 minutes |
| Stopped | green, no arrow | 0 km/h for 5 minutes or less |
| Moving | green, arrow turned to `heading` | Any other speed. A ping without a speed counts as moving, never as stopped |

"Stopped since" is the server's `stoppedSince` when given (the idling rule, FMS-46). Without it, the map counts from the first 0 km/h ping it saw, so a vehicle already idling when the page opened turns amber 5 minutes later.

**Hover or focus** shows the plate, status, speed and last seen. The tooltip opens below a marker near the top edge. A legend in the corner counts the vehicles in each colour.

**Tiles load only on screen.** The Leaflet map is created the first time the map scrolls into view (IntersectionObserver). Its tile layer is removed whenever it scrolls out, so panning or zooming then fetches nothing; markers stay. In the dark theme, the tiles are inverted to a dim map.

**View.** The map opens on Addis Ababa at zoom 12. It fits the view to the vehicles the first time any are given, and never again, so a dispatcher's own panning wins.

**Tile server.** OpenStreetMap's tiles need no key, but their usage policy is for light use. A production deployment points `VITE_MAP_TILE_URL` (and `VITE_MAP_TILE_ATTRIBUTION`) at its own tile server or a provider. Tile requests are cross-origin, so the driver app's service worker never caches them.
