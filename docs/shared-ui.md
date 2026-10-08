# Shared UI components: money, fuel and status

Card: FMS-11 (SE-47). Code: `packages/frontend/src/components/shared/`. Import from `@/components/shared`.

Money is stored as integer Ethiopian cents and fuel as integer millilitres (api-contract §3.5). These components are the only place the frontend turns those integers into text and back, so a rounding bug cannot exist on one screen and not another.

| Component | Props | Notes |
|---|---|---|
| `MoneyDisplay` | `amountMinorUnits` (cents), `unit="ETB"` | `ETB 1,234.50`, right-aligned, tabular digits |
| `FuelDisplay` | `amountMinorUnits` (ml), `unit="L"`, `decimals` 2 or 3 | 23500 ml is `23.50 L`. Litres is the assumed default until the unit setting exists (SE-75) |
| `MoneyInput` | `label`, `value` (cents or null), `onChange(cents or null)`, `required`, `error`, `disabled`, `name` | Typing `149.99` emits `14999`; at most 2 decimals |
| `FuelInput` | same, millilitres | Typing `23.5` emits `23500`; at most 3 decimals |
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

The badge always shows its label as text, so colour is never the only signal.

## Examples page

`/dev/ui` shows every component in each state. It exists only under `npm run dev`; the production build leaves it out.

## Not here

`DataTable`, `EmptyState`, `ErrorBoundary` and `ConfirmDialog` are FMS-67 (Sprint 2).
