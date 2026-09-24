# MODERN_GUI — Revel-Inspired Interface Guide

> Branch: `ui-modernization` · Reference: [revel.io](https://www.revel.io/) (RevelTest / RevelC2)
>
> Revel builds browser-based hardware test & control software (aerospace, energy, defense).
> Its UI is the closest commercial analogue to this ground-control station: live telemetry,
> P&ID-style system diagrams, valve/sequence control, and test verification. This document
> describes its visual language in enough detail to rebuild a UI "in the same family" —
> **inspiration, not a copy**: don't reuse their logo, name, fonts, or artwork.

Observations come from the product screenshots on revel.io (Sept 2026): the Hardware
Discovery modal, the Telemetry channel table, the Test/verification runner, the turbine
control dashboard, and the tank/valve P&ID dashboard. Exact hex values are estimates
from screenshots unless marked *measured*.

**How to read this document.** §1–6 are the original study of Revel's UI and still stand
as a description of *their* design. §7–8 record what GC4 adopted and where it lives in the
code. §9–12 are what we learned building it — what worked, what did not, and the
engineering traps — and are the part to read before changing the UI further. Where GC4
deliberately departs from Revel, §1–6 are annotated **GC4:**.

---

## 1. Design Philosophy (the "feel")

1. **Black, quiet, instrument-grade.** Near-pure black canvas; the data is the only thing
   with color. Chrome (borders, labels, nav) recedes into dim greys.
2. **Color = meaning, never decoration.** Green = open/running/pass, red = closed/fail/hot,
   blue = cold/cryo/nominal-flow, amber = warning. Everything else is greyscale.
3. **Two typefaces, two jobs.** A clean grotesk sans for UI/prose; a monospace for
   *every* channel name, value, unit, timestamp, IP address and code.
4. **Density without clutter.** Very small type (11–12px) and tight rows, but generous
   *negative* space around groups. Thin 1px hairlines instead of boxes and shadows.
5. **Engineering vocabulary on screen.** Raw `snake_case` channel IDs (`test_a_tank_1_fill`,
   `compressor_inlet_temp`) are shown verbatim, in mono, as labels. No prettified names.
   **GC4:** human names ("LOX Tank Downstream") lead and the tag (`PT4`) follows in mono.
   Operators scan a wall of cards for the name and read the tag back on comms.
6. **The diagram *is* the dashboard.** Values are pinned directly onto the schematic next
   to the component they measure, not off in a separate table.

---

## 2. Color System

### 2.1 Neutrals (≈95% of pixels)

| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#000000` (*measured*, marketing) / `#0a0a0a` app | Page / canvas |
| `--bg-1` | `#0f0f10` | Sidebar, panels |
| `--bg-2` | `#161618` | Cards, value tiles, modal body |
| `--bg-3` | `#1f1f22` | Hover rows, pressed buttons, active nav item |
| `--line-1` | `#1c1c1f` | Row dividers, grid lines |
| `--line-2` | `#2a2a2e` | Panel/card borders, input borders |
| `--line-3` | `#3a3a3f` | Focus/active borders, diagram pipes (inactive) |
| `--fg-0` | `#e5e5e5` (*measured* body text) | Primary text, values |
| `--fg-1` | `#a1a1a6` | Secondary text, messages |
| `--fg-2` | `#6b6b70` | Labels, channel names, units, column headers |
| `--fg-3` | `#45454a` | Disabled, faded rows, axis ticks |

Note there's **no pure white text**: the brightest text is ~`#e5e5e5`. That's a big part
of why it looks calm.

### 2.2 Semantic accents (use sparingly, saturated)

| Token | Value | Meaning |
|---|---|---|
| `--ok` | `#22c55e` | Valve open, pass ✓, running, play button |
| `--bad` | `#ef4444` | Valve closed/fail ✕, hot-side fluid line, abort |
| `--cold` | `#3b82f6` | Cryogenic tank fill, cold line, primary series |
| `--warn` | `#f59e0b` | Warnings, stale data |
| `--violet` | `#8b5cf6` | Extra plot series |
| `--accent` | `#e5e5e5` on `#262626` | "Primary" buttons are *neutral*, not colored |

- **Fluid lines on the P&ID** are colored by medium: red for the hot/oxidizer/fuel path,
  blue for cryo, grey for inert/idle.
- **Tank fill** is drawn as a solid colored bottom portion inside the tank outline
  (red tank / blue tank), height = fill %.
- **Sparklines** in tables use a desaturated blue/indigo (`#6366f1` at ~70% opacity).
- Plot series swatches are tiny filled squares (6×6px) left of the channel name.

---

## 3. Typography

| Role | Family | Size | Weight | Tracking |
|---|---|---|---|---|
| Marketing hero | Grotesk sans ("UntitledSans" on their site) | 48–64px | 400 | **-2.4px** (*measured*, ≈ -0.04em) |
| Page / modal title (`Discovered 5 Devices`) | Sans | 20–24px | 400 | -0.02em |
| UI text, nav, buttons | Sans | 12–13px | 400/500 | 0 |
| Section label / eyebrow (`REVEL-SYSTEM-124`, `CASE STUDY`) | Mono or sans caps | 10–11px | 500 | +0.08em, UPPERCASE |
| Channel names, table cells | Mono | 11–12px | 400 | 0 |
| Live values (`1,620.5`) | Mono, **tabular numerals** | 13–16px | 600 | 0 |
| Units (`°C`, `bar`, `%`, `rpm`) | Mono | 9–10px | 400, `--fg-2` | 0 |

Rules:
- **Headings are light (400), never bold.** Hierarchy comes from size and color, not weight.
- **Values are the only bold text** in the app.
- Unit is rendered *smaller and dimmer* right after the number: `24.3` `bar`.
- Use `font-variant-numeric: tabular-nums` so live values don't jitter.
- Free alternatives: **Inter / Geist / Söhne-like** for sans; **JetBrains Mono / Geist Mono /
  IBM Plex Mono** for mono.

---

## 4. Layout & App Shell

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚡LOGO  Dashboards  Telemetry  Code  Config            UPDATED …  ⚙ ⋮   │ ← 36–40px top bar
├───────────────┬──────────────────────────────────────────────────────────┤
│ DASHBOARDS + ▢│ INCOM-T65 Turbine Control                               │ ← 32px breadcrumb/title strip
│ Propellant Lo │                                                          │
│▌Turbine Ctrl  │           (canvas: diagram + tiles + plots)              │
│ Thermal Matrix│                                                          │
│ Interlocks    │                                                          │
│ Fuel Cond.    │                                                          │
│ Vibration     │                                                          │
└───────────────┴──────────────────────────────────────────────────────────┘
   ~180–200px
```

- **Top bar:** logo mark + wordmark at left, then flat text tabs (`Dashboards · Telemetry ·
  Code · Config`). Active tab = brighter text (`--fg-0`), inactive = `--fg-2`. No underline,
  no pill. Right side: tiny status text (`UPDATED 12/10/2025, 3:57:38 PM`), an action button,
  icon buttons.
- **Left sidebar:** caps eyebrow header (`DASHBOARDS`, `SYSTEMS`) with `+` and a
  layout-toggle icon at right. List items are 12px text, 24–28px tall; the **active item gets
  a `--bg-3` fill** with 4px radius — no colored bar needed.
- **Content header:** single line with the current page name, 1px bottom hairline.
- **Canvas:** full-bleed, no page padding card. Everything sits directly on the dark bg.
- **Split bottom:** dashboards commonly end with 2 plot panels side by side (50/50).
- Borders everywhere are **1px `--line-1/2`**. Radius is small: **2–4px** on tiles/buttons,
  **6px** max on modals. No drop shadows in-app (modals use a dim backdrop, not a shadow).

Spacing scale: `4 · 8 · 12 · 16 · 24 · 32`. Rows 24–28px; tiles padding 6–8px.

---

## 5. Components (big features)

### 5.1 Telemetry Channel Table
Columns: `Subsystem | Channel Name | [sparkline] | Value`
- Subsystem column in `--fg-3` mono (e.g. `siteA_system`), channel in `--fg-1` mono.
- **Inline sparkline** column fills the middle (~40% width), 1px line, no axes, shows last
  N seconds. Step signals (pumps, valves) render as square waves.
- Value column right-aligned, `--fg-0`, with dim unit (`-183 °C`, `75 %`, `FALSE`).
- Booleans shown as `TRUE` / `FALSE` in caps mono.
- Row separators 1px `--line-1`; **rows fade out** toward the bottom (gradient mask) in
  marketing shots — nice touch for scroll containers.

### 5.2 P&ID / System Diagram Dashboard
- Components are drawn as **thin outline line-art** (1–1.5px stroke, `--fg-1`): tanks as
  capsules, valves as circle-with-bar, pumps as circle-with-blades, check valves as
  triangles, regulators as diamonds.
  **GC4:** valves stay ISA (bowtie, solenoid coil can, diaphragm operator, check-valve
  diode, diamond filter). Engineers read ISA without a key; generic circles bought nothing
  on a propulsion drawing.
- **Valve state = stroke color + fill ring**: green ring = open, red = closed, grey = unknown.
- Pipes are 1.5px lines with right-angle routing; colored by fluid when active.
- **Value callouts** sit beside components: a mono label (`compressor_inlet_temp`) in
  `--fg-2` over a boxed value (`42.3 °C`) on `--bg-2` with 1px border.
- Small **mini-sparkline tiles** (label, value, 1px trend line) float in empty areas.
- Can embed a detailed blueprint-style illustration (the turbine) rendered in blue/orange
  x-ray style, with value callouts connected by thin leader lines. Hero moment only.

### 5.3 Value Tile (the atomic unit)
```
compressor_outlet_temp      ← 10px mono, --fg-2
┌────────────────┐
│    520.1 °C    │          ← 14px mono 600 + 9px unit, right-aligned
└────────────────┘          ← --bg-2, 1px --line-2, 2px radius
```
Variant with sparkline under the number, and a variant with an edit pencil `✎` next to a
setpoint (`MAX POWER HOLD ✎`).

### 5.4 Segmented Toggle (command control)
`ENABLED | DISABLED`, `LOCK | UNLOCK` — two caps mono labels in a 1px-bordered group.
Active segment gets `--bg-3` + `--fg-0`; inactive is `--fg-2`. Tiny (20px tall). Used for
ignitors, interlocks, bypass modes. Label (`ignitor`, `turbine_enable`) sits above in `--fg-2`.

### 5.5 Sequence / Procedure Card
```
turbine                              [⏸][▶][■]
THROTTLE PROFILE SEQUENCE ✎
```
Small eyebrow (subsystem) + caps name, with a **cluster of 3 square icon buttons**
(pause / play-in-green / stop). Stacked vertically in a right column.

### 5.6 Time-Series Plot Panel
- Toolbar row: **time-window chips** `1s 1m 10m 1h 5h 1d` — mono, active chip boxed —
  then title (`Power Dynamics`) and dim unit/sub-label.
- **Legend inside the plot, top-left**: swatch square + channel + live value, right-aligned
  values in a mini table.
- Grid: very faint (`--line-1`), dashed or solid; y-axis labels on the **right**, mono, `--fg-3`.
- Lines 1–1.5px, no fill, no markers, no smoothing. Dual y-axes allowed (left %, right units).

### 5.7 Test Runner / Verification List
- Header: test name + `Status: RUNNING` (status in a boxed caps chip).
- Grouped by check block (`batt_1a.VERIFY_STABILITY.loop`), group header prefixed with a
  big ✓/✕.
- Columns `Result | Last Run | Message` — result icon green ✓ / red ✕, relative time
  (`10s ago`) in `--fg-2`, message in `--fg-1`.
- Paired with a **code pane** (RevelCode, Python-like) in mono with muted syntax colors.

### 5.8 Modal / Wizard (Hardware Discovery)
- Centered, ~500px, `--bg-1`, 1px border, 6px radius, black 60% backdrop.
- Header row: title left, `Cancel` text button + `✕` icon right.
- Eyebrow system ID in caps mono, then a big light title (`Discovered 5 Devices`).
- **Step tabs**: `1 Merge new devices · 2 Edit existing · 3 Review` — active step has a
  thin underline in `--fg-0`, others dim.
- Table rows: device, IP (mono), `3 modules, 42 channels` with **the number bolded**, and a
  checkbox at the far right.
- Footer: `‹ Prev` / `Continue ›` ghost buttons at bottom corners.

---

## 6. Small Details (the polish that sells it)

- **Bold the number, not the noun**: `3 modules, **42** channels`.
- **Status timestamp** in the top bar: caps mono `UPDATED …` — shows data freshness.
- **Pencil icon** `✎` after editable setpoints/sequence names — inline edit affordance.
- **Arrow CTAs**: `Learn More →` on a `#1a1a1a` block button, 2px radius.
- **Eyebrow labels everywhere** above values/groups (lowercase `snake_case` or UPPER CAPS).
- **Faded overflow**: lists fade to transparent at the bottom instead of hard clipping.
- **Hairline separators** between sections (1px, full-width) instead of cards.
- **Icon buttons are 20–24px squares**, 1px border, monochrome glyphs; color only for play.
- **No emoji, no gradients, no glow** on UI (a subtle glow is OK only on the hero illustration).
  **GC4:** the P&ID vessels are that hero illustration — they carry the only glow and
  gradients on the station (§9).
- **Relative times** (`Just now`, `10s ago`) for events; absolute times on hover.
- **Units always visible**, always dim, always after the value.
- **Consistent casing**: channel IDs lowercase snake, states/buttons UPPERCASE, prose Sentence.
- Checkbox: 12px square, 1px border, 2px radius.
- Hover: row bg → `--bg-3`, 80–120ms transition. No scale/transform effects.

---

## 7. Tokens as Implemented (`public/css/base.css`)

The starter names in the first draft of this guide (`--bg-0`, `--fg-2`…) were mapped onto
the token names the codebase already used, so no component had to be renamed:

| Guide | `base.css` (dark) | Notes |
|---|---|---|
| `--bg-0` | `--bg: #0a0a0a` | page, header, sidebar, P&ID stage |
| `--bg-1` | `--surface: #0f0f10` | cards, tables, bang-bang cards |
| `--bg-2` / `--bg-3` | `--surface-2 #161618` / `--surface-3 #1f1f22` | tiles, hover, active segment |
| `--line-1/2` | `--border #232326` / `--border-strong #34343a` | every hairline |
| `--fg-0/1/2` | `--text #e5e5e5` / `--text-muted #a1a1a6` / `--text-faint #6b6b70` | no pure white anywhere |
| semantic | `--ok #22c55e`, `--warn #f59e0b`, `--danger #ef4444`, `--info #3b82f6` | `*-bg` variants are 11–12% `color-mix` tints, not solid fills |
| trace ink | `--spark #818cf8` (dark) / `#6366f1` (light) | nominal trend lines — never green |
| hologram | `--holo-rim`, `--holo-line` (`pid.css`) | vessel rim light and outlines; silver on dark, graphite on light |
| radii | `--radius-sm 2px`, `--radius 4px`, `--radius-lg 6px` | |
| `--accent` | `#3b82f6`, from `stand.json` `ui.accent` | a *signal* colour: focus, progress, the running sequence — never a button fill |

A light theme exists with the same restraint inverted (zinc greys). Every colour is a token,
so both themes come from one block.

**Type scale.** Seven sizes, as tokens: `--fs-2xs 9` (chips, tiny caps) · `--fs-xs 10` (eyebrows, units) · `--fs-sm 11` (hints, secondary) · `--fs-md 12` (UI text) · `--fs-base 13` (body) · `--fs-lg 15` (card titles) · `--fs-xl 20` (page titles). Before this there were nineteen ad-hoc sizes (8, 8.5, 9, 9.5 … 12.5 px), which is what made the site look inconsistent more than any choice of face. Live values and the brand keep their own sizes, and so does text inside the P&ID drawing, which is in drawing units and overlap-checked (§12). Weights: 400 text, 500 emphasis and caps labels, 600 live values, 700 only for ABORT, ARMED and the login brand. Caps labels are tracked `.08em`. A switch label is plain 400. It was 600, which made every settings form look shouty.

Fonts: `--sans` Inter → Geist → Segoe UI Variable; `--mono` JetBrains Mono → Geist Mono →
Cascadia Mono. **No web fonts are fetched** — the stand has no internet — so a station
without Inter/JetBrains Mono installed renders the Windows fallbacks. Vendoring the two
font files is the one step left to make every station match exactly.

---

## 8. What Was Applied, and Where

| Revel pattern | Status in GC4 | Code |
|---|---|---|
| §4 top bar: flat text tabs, active = brighter ink + hairline | Done | `base.css` `.nav` |
| §4 content header strip with controls | Done on the P&ID (toolbar strip above the drawing) | `page-pid.js` `buildToolbar`, `pid.css` `.pid-toolbar` |
| §5.1 telemetry table with inline sparklines | Done — Data page "Telemetry" mode | `page-data.js` `buildTelemetry` |
| §5.2 P&ID line art, fluid-coloured live lines, pinned values | Done, and extended (see §9) | `pid-symbols.js`, `pid.css`, `page-pid.js` |
| §5.3 value tile with trace | Done — replaces the ISA bubbles on the P&ID | `renderInstrument` |
| §5.4 segmented control | Done — ARM/DISARM, Cards/Telemetry, window chips | `.seg`, `.arm-btn`, `.win-chips` |
| §5.6 time-window chips | Done — Data page and P&ID toolbar (`10s 30s 1m 2m 5m`) | `spark.js` `windowChips` |
| §5.6 plot panels with in-plot legend and right axis | **Partly** — the P&ID hover card has a trace with its range on the right; no standalone plot panels yet | `page-pid.js` hover card |
| §5.5 sequence cards with pause/play/stop cluster | **Not done** — sequences are a hairline list of rows | `components.css` `.seq-list` |
| §5.7 test / verification runner | Not done | — |
| §4 sidebar list, §5.4 segments, §5.6 chips, §5.8 step tabs, §6 pencil / bold number | Done — the autosequence editor (§9a) | `seq-editor.js`, `seq-model.js`, `components.css` `.sq-*` |
| §5.8 discovery wizard modal | Not done | — |
| §6 `UPDATED` freshness stamp | Done, on the P&ID toolbar only | `page-pid.js` `updateStamp` |

**Safety note, as implemented:** ABORT is the one deliberate exception to "buttons are
neutral" — solid red, caps mono, with an inset white hairline so it is never just another
red rectangle. ARMED is the only other solid red on the station. Both survived every
restyle unchanged in meaning.

---

## 9. The P&ID: What It Became

The P&ID needed the most extension of Revel's language, because a propulsion drawing
carries more than their dashboards do.

**Vessels are drawn as the hardware on the stand, as a soft hologram.** The cue is the
turbine x-ray render (§5.2), in neutral silver rather than blue:
- a near-clear body, rim light at the silhouette (a black/white gradient overlay, so one set
  of stops works in both themes), faint scanlines, and a soft glow on the outline;
- x-ray cues: the back half of every weld seam as a dashed hidden line, an inner liner wall,
  and internals (pressurant diffuser, outlet baffle, the dewar's inner vessel);
- shapes true to the equipment: 2:1-head run tanks with straps and bosses; 6K cylinders with
  neck, valve, handwheel and pigtails into a manifold; a dewar with crown ring and casters;
  a compressor as receiver + motor + finned pump head; horizontal receivers on saddles
  (surge tanks, MOE fuel storage);
- the only colour inside a tank is its liquid — translucent, with a glowing free-surface
  ellipse that tracks the level. The engine's warm core lights only while it is firing.

**Pipes are hairlines, grey at rest, full fluid colour when live.** An idle line keeps ~38%
of its fluid colour mixed into grey; a pressurized or flowing section takes the full colour.
Colour on the drawing therefore *means* "live", which reads from across the room. Line
weights keep the config's ratios at ~45% of the old widths.

**Valve state is a boxed chip** under the tag (`CLOSED` / `OPEN` / `VENT` / `SEALED`), fixed
width, lit green — red for hazardous valves — when open. The valve body takes a green
outline and tint rather than a solid fill. Multi-line tags (`GROUND\nLOX FILL`) push the
chip down.

**Sensors are value tiles**, not ISA bubbles: tag, value + dim unit, and a hairline trend,
with the group colour as a 2px tick. Hovering opens a card with the full name, rate, a
readable trace with its range on the right, and window min/max. `pid.tag` gives a stand
short labels; a tag too long for the tile shrinks rather than spilling past its edge.

**The toolbar is a strip above the drawing**, holding the trend-window chips, zoom, lock,
tank-level tare, a `KEY` button (the legend opens on demand), a `SIM` chip in the simulator,
and the `UPDATED` stamp.

**The default view fits the drawing's contents**, up to 110%, never clipping anything.
`0` returns to it, and it refits on resize until the operator pans or zooms.

**The control sidebar fits the window and never scrolls.** Its columns are laid out at
fixed design widths and zoomed as one (`--fit`, set by `sidebar-fit.js`) to the largest
value at which everything fits the window height *and* the sidebar takes at most ~36% of
the width. The two bang-bang cards always stack. Measured: 23% of the width at 2560×1440,
34% at 1600×900, 33% at 1067×600 (≈150% browser zoom), with nothing below the fold.

### 9a. The autosequence editor

The old editor was four stacked cards: settings, a strip of unlabelled ticks, a
table of dropdowns per step, and abort conditions. Retiming meant typing, and
seeing when a valve was open meant finding two rows that could be ten apart.

It is now drawn as what the sequence **does**. There is one swimlane per
actuator, and an open window is a lit bar between the step that opens it and the
step that closes it. This is the P&ID's rule applied to time: colour means live,
green open, red for a hazardous actuator, blue for a regulating controller.
Steps are handles you drag, and they snap to the grid and to each other. Under
the timeline the same run reads as a countdown sheet (`T+`, gap, action), and a
single inspector edits whatever is selected. The page follows the rest of the
station:
- a picker list as in §4;
- an eyebrow-labelled toolbar strip with segmented `SNAP` / `MOVE` / `ZOOM`
  controls;
- the P&ID's state chips in the lane gutter, showing each lane's state under
  the cursor;
- step tabs in the inspector;
- an inline-editable title with ✎, and a meta line that bolds the numbers.

Selection, the insert pin and the preview playhead use the accent, the signal
colour. The only amber is the live playhead and lint.

What a sequence means over time lives in `seq-model.js`, with no DOM. It covers
SAFE ALL and ABORT STATES moving every valve, momentary pulses closing
themselves, and END/ABORT cutting off what follows. The lanes, the script and
the lint therefore agree, and all of it is unit-tested.

---

## 10. What Worked

- **Colour only for meaning.** Taking colour off everything that is not a state — buttons,
  tab highlights, sparklines, pipes at rest — made the colour that remains (an open valve, a
  live line, an alarm) the first thing the eye finds. Green sparklines were the clearest
  case: on this screen green means "open"/"pass", so nominal traces became indigo.
- **Hairlines and a step in surface tone instead of shadows.** Flat, calm, and it scales.
- **Mono for every number, tabular numerals, dim smaller units.** Live values stop jittering.
- **Tokens first.** Retuning `:root` did most of the restyle before any component was
  touched; the rest was removing bold, pills and shadows.
- **Drawing hardware as hardware.** Accurate silhouettes — heads, bosses, straps, valves on
  bottles — did more for the "serious" feel than any amount of styling.
- **Translucency over shading.** The hologram shell reads as 3D, keeps the liquid visible,
  and, being a neutral overlay, works in both themes with no extra colours.
- **Fit-to-screen as a rule, not a zoom level.** Both the drawing and the sidebar compute
  their scale from what they must show; neither hard-codes a size.
- **A measured overlap check** (§12) instead of eyeballing a dense drawing.
- **One trace implementation** (`spark.js`): binary-search windowing and per-pixel min/max
  decimation keep a 5-minute, 50 Hz window as cheap as a 10-second one — and keep the spike.

## 11. What Did Not Work (and What Replaced It)

| Tried | Problem | Replaced by |
|---|---|---|
| Solid dark "metal" vessel shading | Heavy; read as clip-art next to hairline pipes | Soft translucent hologram shell |
| Rounded symbols, 2px strokes, a big "S" glyph, a filled lightning-bolt igniter | Looked light and toy-like | Mitred 1.25px line art, coil-can solenoid, diaphragm operator, spark-gap igniter |
| A blue hologram, like the reference render | Every tank read as LOX | Neutral silver; only the liquid is coloured |
| Orange combustion glow always on | A glowing engine that is not firing is a false reading | Glow fades in with the plume; dark at rest |
| Dotted grid behind the drawing | Did not match the rest of the site | Plain `--bg` |
| Legend and stamp floating in the canvas corners | Covered the dewar label and the `PB1–PB6` flag | Moved into the toolbar; legend on demand (`KEY`) |
| Reserving an empty band under the drawing for those overlays | Wasted ~8% of the screen permanently | Removed once the overlays moved to the toolbar |
| A floating toolbar panel over the drawing | Grew with each control until it covered the title block | A toolbar strip above the drawing |
| A flat 110% default zoom | The drawing is wider than most stages; 110% cut off the right edge or the bottom row on every layout tested | Fit-to-content, *capped* at 110% (lands ~100–104%) |
| Page-colour halos on labels painted over shaded tanks | Smudged | No halo on vessel labels |
| Bang-bang cards side by side on short screens | Card position changed with screen shape, and where a card sits is part of how an operator knows which tank they are acting on | Always stacked; the sidebar zooms instead |
| Fixed-px sidebar widths with media-query breakpoints | At high browser zoom the sidebar took over half the width | Proportional zoom capped at ~36% of the width |

**Still unresolved: the empty space around the P&ID is a shape problem, not a zoom
problem.** The drawing is ~1.5:1; the stage beside the sidebar is taller than that and a
full-width stage is wider. Removing the space means changing the drawing's proportions
(spreading it vertically), not zooming it.

## 12. Engineering Lessons and Traps

**Layout**
- CSS `zoom` scales layout (unlike `transform`), so a zoomed column still sizes and
  hit-tests correctly — but **a flex container sizes itself from its children's *unzoomed*
  widths**, leaving a dead strip beside them. State the container's width from the zoom.
- Give a zoomed column `height: calc(var(--sb-h) / var(--fit))` so it renders at exactly
  the window height.
- **`requestAnimationFrame`, `ResizeObserver` callbacks and `resize` events all pause while
  a page is not being painted** (minimised or covered window). Anything that must stay
  correct — the sidebar fit — is scheduled with `setTimeout`. When testing in a background
  browser, force a frame (take a screenshot) before measuring.
- The P&ID SVG uses `preserveAspectRatio="xMinYMin meet"`; the view transform lives on an
  inner group, and the default view is computed from that group's `getBBox()` with the
  invisible plume excluded (otherwise it reserves room for an exhaust that is not there).

**Verifying a dense drawing**
- The check that caught every real collision: collect the screen boxes of every label,
  state chip, value tile and symbol body; map them into drawing units through the world
  group's CTM; test every pair with different owners. Test the HTML overlays (toolbar,
  legend, stamp) against the drawing too.
- It compares **rectangular bounding boxes**, so a tile beside a tank's curved head can be
  a false positive (PT23 against the fuel tank). Confirm a hit by eye before moving anything.
- When walking stylesheets, a `CSSStyleRule` now has its own `cssRules` list (CSS nesting):
  test `instanceof CSSStyleRule` first or the walker skips every rule. And
  `rule.style.width` reads back empty for a `var()` value — search `cssText` instead.

**Config and data**
- `stand.json` round-trips through `JSON.stringify(…, null, 2)` byte-for-byte and can be
  edited as data; **`moe.json` does not** — edit it with exact text replacements. Check
  before writing.
- The server reads the stand config at startup: restart the simulator to see a drawing change.
- When moving a component, keep its **pipe attachment points** — bottle-bank manifold at
  `y − h/2 − 24`, dewar withdrawal at `y − h/2 − 17`, compressor discharge at `y + 35`,
  run-tank ports at `y ± h/2` — or move the pipe endpoints with it.
- Operators' work shares files with the UI (`stand.json` sequences, `chrome.js`,
  `base.css`). Commit UI work by staging only the UI hunks, or by building the staged file
  from `HEAD` plus the UI-owned sections, and read the staged diff before committing.

**Scripted edits**
- A splice that searched for "the next `.section-title {`" matched `.rec-files
  .section-title {` earlier in the file and duplicated ~180 lines of `base.css`; the stale
  copy then won the cascade. Anchor a replacement on text that is unique *and* after the
  start point, assert exactly one match, and diff against `HEAD` afterwards.

**Keys**
- **Esc is ABORT on every page** (`chrome.js`), from inside text fields too. Never
  bind it to anything local ("deselect", "close panel"). An editor that teaches
  "press Esc to deselect" teaches operators to abort the stand. Testing the
  sequence editor with Esc-to-deselect latched an abort on the simulator. Only
  a modal dialog may take Esc, and it stops the event first.
- `t` (theme) and `\` (sidebar) are global too. Check `chrome.js` before adding
  a single-key shortcut.

**Merging**
- `git merge-tree --write-tree A B` previews a merge without touching the working tree —
  use it to see which files will really conflict before starting.
- Do not settle a restyle-vs-feature conflict with `-X ours`: it merges cleanly and silently
  drops the other side's behaviour (here it would have lost MOE's two-line valve tags and
  `pid.tag`). Keep the restyled code and port the feature into it.

**Performance**
- Trim rolling history in chunks (let it run ~10% long, then drop the excess), not with
  `splice(0, 1)` per sample; at 30 channels × 50 Hz × 15,000 samples the per-sample shift
  was the most expensive thing the page did.
- Redraw hairline traces at ~6 Hz, not at the stream rate.

---

## Sources
- [Revel – homepage & product screenshots](https://www.revel.io/)
- [Revel Series B announcement (BusinessWire, Feb 2026)](https://www.businesswire.com/news/home/20260226807932/en/Revel-Raises-$150M-Series-B-to-Modernize-the-Software-Layer-Behind-Hardware-Test-and-Control)
