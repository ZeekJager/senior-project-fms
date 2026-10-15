# Design system

Every FMS screen uses this system: a calm operations console. Flat surfaces
with hairline borders, one indigo accent, tight corners, almost no shadow, and
quick, quiet motion. No gradients, glows, blur or decorative eyebrow labels.
Usability and accessibility come first.

Code: `packages/frontend/src/components/ui/` (building blocks, import from
`@/components/ui`) and `src/components/shared/` (money, fuel, status, tables,
states and dialogs, see `docs/shared-ui.md`). See each one in every state on
`/dev/ui` under `npm run dev`.

## Foundations

**Colour.** Tokens are CSS variables in `src/index.css`, exposed as Tailwind
colours in `tailwind.config.js`. Use the tokens, never raw hex or Tailwind
greys, so light and dark mode both work. The theme is `data-theme` on `<html>`: set before first paint by the script in `index.html` (stored choice, else the system setting) and changed by `ThemeToggle` (`src/theme/theme.ts`, key `fms-theme`). The toggle is in the top bars and on the sign-in screens.

| Token | Use |
|---|---|
| `canvas` | The page behind everything (with a faint brand glow at the top) |
| `surface`, `surface-muted`, `surface-sunken` | Cards and panels; table headers and footers; wells, skeletons, icon tiles |
| `line`, `line-strong` | Hairline borders; control borders |
| `ink`, `ink-muted`, `ink-subtle` | Headings and values; body text; captions and placeholders |
| `brand` | Solid fills under white text (primary buttons, the active toggle) |
| `brand-ink`, `brand-soft` | Accent text and icons; tinted backgrounds (an active filter) |
| `success`, `warning`, `danger`, `info`, `neutral` (+ `-soft`) | Status text and tinted backgrounds; `danger-solid` for destructive buttons |
| `overlay` | The dimmed backdrop behind dialogs and drawers |

Every text and background pair meets WCAG AA (4.5:1). The weakest pair,
`ink-subtle` on `surface`, is about 4.9:1 in light mode and 6:1 in dark.
Colour is never the only signal: badges always carry a label, icons carry
`aria-label` or sr-only text.

**Type.** One family, Inter (variable, self-hosted via `@fontsource-variable/inter`), with Ethiopic falling back to Noto Sans Ethiopic or Nyala. Fixed role scale:

| Role | Size | Use |
|---|---|---|
| Page title | `text-xl` / `sm:text-2xl`, semibold, tight | One per screen |
| Plate | 15px, semibold, tabular, slashed zero (`.plate`) | A vehicle registration number, wherever it leads a row |
| Body and data | 14px (`text-sm`) | Table cells, form values |
| Caption | 13px (`text-xs`) | Secondary lines, table headers, badges |
| Group label | 12px (`text-2xs`), uppercase, wide tracking | Sidebar groups, form sections |

Nothing is smaller than 12px. Numbers in tables and stats use `tabular`. In dark mode the body gets a little more tracking and line height (`index.css`), because light text on dark reads tighter.

**Space.** An 8px grid: paddings and gaps in steps of 8 (`2`, `4`, `6`, `8`
in Tailwind units), with 4px only inside small components. Table rows are
56px; controls are 40px (fields 56px with the floating label).

**Shape and depth.** Controls 8px corners (`rounded-control`), cards 12px
(`rounded-card`), sheets and dialogs 16px (`rounded-sheet`). Shadows:
`shadow-soft` on controls, `shadow-card` on cards, `shadow-elevated` on
anything floating (menus, drawers, toasts), `shadow-glow` on the primary
button's hover. Frosted glass (`backdrop-blur` over a translucent surface) is
for chrome that floats over content: the sidebar, the mobile top bar, menus,
toasts.

**Motion.** 150-300ms with `ease-smooth`. Things enter (`animate-scale-in`,
`animate-slide-in-right`, `animate-pop-in`, `animate-fade-in`); cards lift
2px on hover; buttons press down 1px. `prefers-reduced-motion` turns it all
off (`index.css`).

**Touch.** On touch devices every control is at least 44px: use the `coarse:` variant (`@media (pointer: coarse)`, in `tailwind.config.js`) to raise a size, e.g. `h-9 coarse:h-11`, so the desktop stays dense. Row actions are always visible (never faded until hover), and hover styles apply only where the device can hover (`hoverOnlyWhenSupported`).

**Focus.** One style everywhere: `focus-ring` (a soft brand halo on keyboard
focus only). Never remove an outline without it.

## Components

| Component | Notes |
|---|---|
| `Button`, `IconButton` | `primary`, `secondary`, `ghost`, `danger`; `sm`/`md`/`lg`; `loading` shows a spinner and sets `aria-busy`. `type` defaults to `button`. An `IconButton` needs a `label` (its accessible name and tooltip) |
| `TextField`, `SelectField` | Floating label: a real `<label>`, inside the control until there is a value. `error` replaces `hint` in a message line that always exists (a live region), and sets `aria-invalid`. `optional` adds "(optional)"; `trailing` holds a unit or a status icon |
| `Combobox` | A searchable select (WAI-ARIA combobox): the caller feeds options from the typed text (local filter or API search), optional groups ("Needs maintenance" first), a detail line and a trailing badge per option. Escape closes only the list |
| `TextAreaField` | The multi-line floating-label field (descriptions, notes) |
| `ViewTabs` | One control for "which rows?": named views with counts (`aria-pressed`), plus an optional menu for rare ones. Use it instead of a stat card, a dropdown and a switch that filter the same thing (Vehicles) |
| `FilterSelect` | The filter-bar pill: label, value, an animated listbox. Arrow keys, Home/End, Enter/Space, Escape. Tinted while a filter is applied |
| `Dialog`, `Drawer` | Portal, focus trap, Escape and backdrop close, scroll lock, focus returned on close. Drawers are floating sheets inset 8px from the edge; use them for forms and detail instead of new pages |
| `Card`, `Badge`, `Skeleton`, `Spinner` | Surfaces; tinted pills with a dot or icon; shimmering placeholders the size of what they replace |
| `StatCard`, `StatShare` (`components/shared`) | One cell of a summary strip: put cells in a `<section className="stat-strip">` (one panel, hairline dividers; 2 columns on phones, 4 from `xl`). A cell is a figure with an icon and a share bar; tinted while its filter applies to the table below |
| `ToastProvider`, `useToast` | Confirmations after an action ("Vehicle registered"). Errors belong next to what failed, not in a toast |
| `AppShell` (`components/layout`) | A dark navy sidebar (`side` tokens) with the screens the user may open (from `router/routes.tsx`, filtered by permission): full from 1024px, an icon rail from 768px, a slide-in menu below. A 56px top bar with the portal name, `ThemeToggle` and the bell, a skip link, and an `ErrorBoundary` around each screen |

Shared by several screens: `features/documents` (the documents drawer, expiry rules, document hooks) and `features/depots` (`useDepots`).

## A screen, step by step

1. Add the route to `router/routes.tsx` with its `permission` and `nav` entry.
2. Header: the title (`text-xl sm:text-2xl`), one line of description, the
   primary action on the right, a hairline underneath.
3. A summary strip, then one panel: search and filters go in `DataTable`'s
   `toolbar` prop so they sit on top of the rows in the same card. All five
   states (loading skeleton, empty, error, data, skeleton while filters change).
4. Filters in the URL (`useSearchParams`), so views can be shared and Back works.
5. Create and edit in a `Drawer`; irreversible actions through `ConfirmDialog`.
6. Check it at 390px, 820px and 1440px, in light and dark mode, and with the
   keyboard alone.
