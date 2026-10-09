# Design system

Every FMS screen uses this system. It aims for the calm, precise feel of a
modern SaaS product: a lot of whitespace, one accent colour, soft depth and
quick, quiet motion. Usability and accessibility come first.

Code: `packages/frontend/src/components/ui/` (building blocks, import from
`@/components/ui`) and `src/components/shared/` (money, fuel, status, tables,
states and dialogs, see `docs/shared-ui.md`). See each one in every state on
`/dev/ui` under `npm run dev`.

## Foundations

**Colour.** Tokens are CSS variables in `src/index.css`, exposed as Tailwind
colours in `tailwind.config.js`. Use the tokens, never raw hex or Tailwind
greys, so light and dark mode both work. Dark mode follows the system setting.

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

**Type.** Inter (variable, self-hosted via `@fontsource-variable/inter`), 14px
body. Page titles `text-2xl`/`text-3xl font-semibold tracking-tight`; section
labels `text-xs font-semibold uppercase tracking-wider text-ink-subtle`;
numbers in tables and stats use `tabular` (tabular figures). Nothing smaller
than 12px.

**Space.** An 8px grid: paddings and gaps in steps of 8 (`2`, `4`, `6`, `8`
in Tailwind units), with 4px only inside small components. Table rows are
64px; controls are 40px (fields 56px with the floating label).

**Shape and depth.** Controls 12px corners (`rounded-control`), cards 16px
(`rounded-card`), sheets and dialogs 20px (`rounded-sheet`). Shadows:
`shadow-soft` on controls, `shadow-card` on cards, `shadow-elevated` on
anything floating (menus, drawers, toasts), `shadow-glow` on the primary
button's hover. Frosted glass (`backdrop-blur` over a translucent surface) is
for chrome that floats over content: the sidebar, the mobile top bar, menus,
toasts.

**Motion.** 150-300ms with `ease-smooth`. Things enter (`animate-scale-in`,
`animate-slide-in-right`, `animate-pop-in`, `animate-fade-in`); cards lift
2px on hover; buttons press down 1px. `prefers-reduced-motion` turns it all
off (`index.css`).

**Focus.** One style everywhere: `focus-ring` (a soft brand halo on keyboard
focus only). Never remove an outline without it.

## Components

| Component | Notes |
|---|---|
| `Button`, `IconButton` | `primary`, `secondary`, `ghost`, `danger`; `sm`/`md`/`lg`; `loading` shows a spinner and sets `aria-busy`. `type` defaults to `button`. An `IconButton` needs a `label` (its accessible name and tooltip) |
| `TextField`, `SelectField` | Floating label: a real `<label>`, inside the control until there is a value. `error` replaces `hint` in a message line that always exists (a live region), and sets `aria-invalid`. `optional` adds "(optional)"; `trailing` holds a unit or a status icon |
| `FilterSelect` | The filter-bar pill: label, value, an animated listbox. Arrow keys, Home/End, Enter/Space, Escape. Tinted while a filter is applied |
| `Dialog`, `Drawer` | Portal, focus trap, Escape and backdrop close, scroll lock, focus returned on close. Drawers are floating sheets inset 8px from the edge; use them for forms and detail instead of new pages |
| `Card`, `Badge`, `Skeleton`, `Spinner` | Surfaces; tinted pills with a dot or icon; shimmering placeholders the size of what they replace |
| `StatCard`, `StatShare` (`components/shared`) | A clickable figure with an icon and a share bar; pressed while its filter applies to the table below (vehicles, drivers) |
| `ToastProvider`, `useToast` | Confirmations after an action ("Vehicle registered"). Errors belong next to what failed, not in a toast |
| `AppShell` (`components/layout`) | Frosted sidebar with the screens the user may open (from `router/routes.tsx`, filtered by permission), a top bar and slide-in menu below 1024px, a skip link, and an `ErrorBoundary` around each screen |

Shared by several screens: `features/documents` (the documents drawer, expiry rules, document hooks) and `features/depots` (`useDepots`).

## A screen, step by step

1. Add the route to `router/routes.tsx` with its `permission` and `nav` entry.
2. Header: an optional eyebrow pill, the title, one line of description, the
   primary action on the right.
3. Content in `Card`s on the canvas; lists in `DataTable` with all five states
   (loading skeleton, empty, error, data, skeleton while filters change).
4. Filters in the URL (`useSearchParams`), so views can be shared and Back works.
5. Create and edit in a `Drawer`; irreversible actions through `ConfirmDialog`.
6. Check it at 390px, 820px and 1440px, in light and dark mode, and with the
   keyboard alone.
