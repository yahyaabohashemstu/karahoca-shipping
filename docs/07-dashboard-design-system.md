# Dashboard design system

The dispatcher dashboard is looked at for eight hours a day, often from across
the room, by someone whose job is to notice one truck out of forty going quiet.
Every decision below follows from that sentence.

---

## Tokens

`apps/web/src/app/globals.css` holds two authored themes as CSS custom
properties, switched by `data-theme` on `<html>`. `tailwind.config.ts` maps them
to utility classes, so `bg-surface` means "whatever surface is in the active
theme".

Colours are stored as **space-separated RGB triplets**, not hex:

```css
--kh-surface: 255 255 255;
```

```ts
surface: 'rgb(var(--kh-surface) / <alpha-value>)'
```

The `<alpha-value>` placeholder is what keeps `bg-surface/50` working. A hex
value here breaks every opacity modifier in the codebase, silently.

The dark theme is authored separately rather than derived. Surfaces that read as
"quiet grey" on white read as muddy when inverted, and the accent colours have
to be lifted in lightness and dropped in saturation or they vibrate.

### Theme switching without a flash

`lib/theme.tsx` exports `THEME_SCRIPT`, a small blocking script inlined into
`<head>`. It reads the stored preference and sets `data-theme` **before first
paint**. Without it the page renders light, React hydrates, and the theme snaps
to dark — a white flash into the eyes of someone who chose dark mode precisely
because they stare at this screen all day. There is no React lifecycle early
enough to do this; it has to be the blocking script.

---

## The five signal states

This is the part of the interface that carries the most information per pixel,
and it is the part that was most broken.

The original badges encoded state in **hue alone**, and two of the five hues
were a pair of near-identical tans: DELAYED `#fef3c7` against STALE `#ffedd5` —
six values apart in green, fourteen in blue. At 11px they were the same pill.
Under a red-green deficiency, roughly 8% of men, LIVE / DELAYED / STALE / LOST
all collapsed toward one wash and the badge column carried no information at
all.

State is now encoded **three independent ways**, so any one of them surviving is
enough:

| State | Hue | Glyph | Fill |
|---|---|---|---|
| `LIVE` | green | ● filled disc | tinted |
| `DELAYED` | amber | ◐ half disc | tinted |
| `STALE` | **graphite** | ○ hollow ring | tinted |
| `LOST` | red | ■ square | **solid, inverted** |
| `NO_SIGNAL` | none | ◌ dashed ring | transparent |

Two choices are load-bearing:

**STALE is graphite, not orange.** "Ageing out" reads correctly as a fading
grey, and grey cannot be confused with amber under any form of colour-vision
deficiency — which orange absolutely could.

**LOST is the only solid, inverted badge in the entire product.** That is what
makes a dead truck findable while scrolling forty rows. Do not introduce another
small element filled with a saturated colour, or this stops working.

---

## One definition of freshness

`lib/signal.ts` is the only place that decides how fresh a truck is.

It used to exist twice. `FleetMap` recomputed freshness locally against the wall
clock while the sidebar badge, the sort order and the "Sessiz" counter all
trusted `signalState` as it arrived from the server. The map aged a truck to red
continuously; the list beside it stayed green until the next snapshot. Same
truck, two colours, side by side — and the header count agreed with the wrong
one.

Worse, the map's version only recomputed when a socket frame arrived. During the
exact outage where ageing matters most, every truck froze at whatever colour it
had when the feed died.

Both problems have the same fix: **one function, driven by a clock tick rather
than by data arrival.**

```ts
const now = useNow();               // 15s ticker, shared
const { state } = freshness(row, now);
```

Anything that displays or sorts by signal state must take `now` as an input. A
component that derives freshness from data alone will freeze during an outage.

---

## Loading, error, empty — three states, never two

The original dashboard collapsed two of them. A failed `/tracking/live` and an
empty fleet rendered byte-identical screens:

> Şu anda yolda araç yok.

A dispatcher read that as "every shipment is delivered" and stopped watching. In
a shipment control room the difference between *nothing is moving* and *I cannot
see what is moving* is the entire point of the screen.

Every list renders all three, from `components/ui/Feedback.tsx`:

- `SkeletonList` / `TableSkeletonRows` — reserve the real row height so nothing
  jumps on arrival
- `ErrorState` — `role="alert"`, the API's own message, and a retry button
- `EmptyState` — with the action that resolves it

`StaleBanner` is a fourth, distinct case: there *is* data on screen, but the
socket dropped and it is no longer trustworthy.

---

## Typography

Root font size is **14px**, not 16. Every `rem` in the app is therefore smaller
than its Tailwind default. This is an operations console: the stock scale wastes
roughly a third of the vertical space on a list someone needs to scan forty rows
of.

Inter and JetBrains Mono are downloaded at **build time** by `next/font` and
served from our own origin. Nothing is fetched from Google at runtime — no
third-party request from a factory office, no render-blocking round trip, and a
metric-matched fallback so there is no layout shift. The `latin-ext` subset is
not optional: the base `latin` subset has no ş, ğ, ı or İ, every one of which
would fall back to a different font mid-word.

**`.kh-num` on every number.** Plates, order numbers, distances, speeds, battery
percentages, timestamps. Without tabular figures a column of numbers does not
align and cannot be compared by eye. It is applied per element rather than
globally so prose keeps proportional figures.

Monospace is reserved for one thing: the claim code a dispatcher reads aloud
down a phone line. Proportional digits and an ambiguous 0/O are how a truck ends
up unable to start tracking.

---

## The map

The basemap is `positron` in light and `dark` in dark, selected in
`lib/mapStyle.ts`.

It used to be `liberty` — 111 layers of full-colour cartography built for people
looking at places. Two problems for a fleet overlay. It renders motorways in the
same amber as a DELAYED truck, and exactly where trucks are; and water in the
same blue as a destination pin. And 111 layers is a lot of style work on a page
left open for eight hours on office hardware. Positron is 55 layers, dark is 47,
and both are desaturated by design: roads are grey, so **the only saturated
pixels on screen are the trucks**.

Destination pins are violet — the one hue that appears nowhere else in the
product and nowhere on the basemap.

MapLibre paint properties are plain strings, not CSS. They cannot reference a
custom property and do not re-evaluate on theme change, so `mapColors()` reads
the computed values and **must be called again after every `setStyle`**.
`setStyle` also discards every source and layer the application added; that is
why layer setup is a named `installLayers` function called on both `load` and
`styledata`. Forget it and switching theme silently empties the map.

MapLibre is ~215 kB. Always load it with `next/dynamic`. Imported statically it
put `/sessions/[id]` at 353 kB against 143 kB for every other screen.

---

## Contrast is measured, not assumed

Every colour pair in this document was checked with an in-page WCAG contrast
script across four screens in both themes. It found three real failures that
looked fine to the eye:

| | Measured | Required |
|---|---|---|
| White on brand, dark theme | **2.88** | 4.5 |
| `--kh-text-3`, light theme | **3.11** | 4.5 |
| `--kh-text-3`, dark theme | **3.92** | 4.5 |

The button fix is worth knowing: buttons use **`text-ink-inverse`, never
`text-white`**. Because `--kh-text-inverse` is white in the light theme and
near-black in the dark one, a single class gives 5.9:1 on light and 6.7:1 on
dark with no per-theme override — and it works for `danger` and `success` too.

Re-run the check after any palette change. Both `--kh-text-3` ramps are already
at the edge of their budget.

---

## Components

`components/ui/` — import from the barrel, `@/components/ui`.

| | |
|---|---|
| `Button`, `ButtonLink`, `IconButton` | `loading` disables as well as decorates; `IconButton` requires `label` |
| `Input`, `Select`, `Textarea`, `Field` | real `<label>`, `aria-invalid`, errors in text not colour |
| `SearchInput`, `SegmentedControl` | |
| `SignalBadge`, `SignalDot`, `StatusBadge`, `Badge` | never render an empty badge for an unknown state |
| `Card`, `CardHeader`, `Row`, `Stat`, `PageHeader`, `Divider` | `Row` takes `loading` and renders a skeleton, not an em-dash |
| `Table`, `THead`, `TH`, `TR`, `TD`, `TRMessage`, `Pagination` | `TR` with `onClick` is keyboard-reachable |
| `Skeleton`, `EmptyState`, `ErrorState`, `StaleBanner`, `ConnectionPill` | |
| `Modal`, `ConfirmDialog` | built on `<dialog>` — focus trap, Escape and inertness come from the platform |
| `ToastProvider`, `useToast` | errors do not auto-dismiss |

Two rules that are not obvious from the types:

**Any irreversible action goes behind `ConfirmDialog`, and the dialog names the
plate and the order number.** "Emin misiniz?" is not a safeguard; "Complete
34 ABC 123 / SEV-2026-0001?" is.

**Any mutation goes through `useMutation`.** `Teslim edildi` was once a bare
async call whose rejection went nowhere — a 409 on an already-closed session
rendered exactly like success, and the dispatcher believed the shipment was
closed.

---

## Local development against the deployed API

```bash
KH_DEV_API_PROXY=https://track.karahoca.com NEXT_PUBLIC_API_URL=/api/v1 npm run dev
```

`next.config.mjs` rewrites `/api/*` to the target, so the browser talks to
localhost only and the deployed `CORS_ORIGINS` does not have to be widened to
include a laptop — a production config change made for a local convenience, and
the kind that gets left behind.

WebSockets are not proxied by rewrites, so the realtime feed shows as
disconnected. That is useful: it exercises the stale-data banner.

> On Windows, run this from PowerShell, not Git Bash. MSYS path conversion
> rewrites `/api/v1` into `C:/Program Files/Git/api/v1` before Next ever sees
> it, and the app then requests `file:///C:/Program Files/Git/api/v1/...`.
