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
- **Relative times** (`Just now`, `10s ago`) for events; absolute times on hover.
- **Units always visible**, always dim, always after the value.
- **Consistent casing**: channel IDs lowercase snake, states/buttons UPPERCASE, prose Sentence.
- Checkbox: 12px square, 1px border, 2px radius.
- Hover: row bg → `--bg-3`, 80–120ms transition. No scale/transform effects.

---

## 7. Starter Tokens (drop into `public/css/base.css`)

```css
:root {
  --bg-0:#0a0a0a; --bg-1:#0f0f10; --bg-2:#161618; --bg-3:#1f1f22;
  --line-1:#1c1c1f; --line-2:#2a2a2e; --line-3:#3a3a3f;
  --fg-0:#e5e5e5; --fg-1:#a1a1a6; --fg-2:#6b6b70; --fg-3:#45454a;
  --ok:#22c55e; --bad:#ef4444; --cold:#3b82f6; --warn:#f59e0b; --violet:#8b5cf6;
  --font-sans:"Inter","Geist",system-ui,sans-serif;
  --font-mono:"JetBrains Mono","Geist Mono",ui-monospace,monospace;
  --r-sm:2px; --r-md:4px; --r-lg:6px;
  --row:26px; --topbar:40px; --sidebar:192px;
}
body { background:var(--bg-0); color:var(--fg-0); font:12px/1.4 var(--font-sans); }
.mono, .value, .channel { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
.eyebrow { font:500 10px var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--fg-2); }
.value { font-weight:600; font-size:14px; }
.value .unit { font-weight:400; font-size:9px; color:var(--fg-2); margin-left:3px; }
.tile { background:var(--bg-2); border:1px solid var(--line-2); border-radius:var(--r-sm); padding:4px 8px; }
.seg { display:inline-flex; border:1px solid var(--line-2); border-radius:var(--r-sm); }
.seg > button { font:500 10px var(--font-mono); text-transform:uppercase; color:var(--fg-2); padding:3px 8px; background:none; border:0; }
.seg > button.on { background:var(--bg-3); color:var(--fg-0); }
.fade-bottom { mask-image:linear-gradient(to bottom,#000 70%,transparent); }
```

---

## 8. Applying It to ERPL-GC4

| GC4 screen | Revel pattern to borrow |
|---|---|
| P&ID view (`public/css/pid.css`) | §5.2 line-art components, fluid-colored pipes, pinned value tiles, green/red valve rings |
| Sensor list / DAQ channels | §5.1 channel table with inline sparklines |
| Plots | §5.6 window chips, in-plot legend with live values, right-side axis |
| Valve / ignitor / arm controls | §5.4 segmented `ENABLED/DISABLED`, `LOCK/UNLOCK` |
| Panda autosequencer | §5.5 sequence cards with pause/play/stop cluster; §5.7 step results list |
| Device connect (NI-DAQ, Panda, BangBang) | §5.8 discovery wizard modal |
| Chrome (`public/js/chrome.js`) | §4 top bar tabs + `UPDATED` freshness stamp + sidebar dashboard list |

**Safety note for a control GUI:** keep abort/hazard controls visually distinct even in this
minimal style — red outline + caps label + confirmation — since Revel's neutral-button
convention would otherwise make them blend in.

---

## Sources
- [Revel – homepage & product screenshots](https://www.revel.io/)
- [Revel Series B announcement (BusinessWire, Feb 2026)](https://www.businesswire.com/news/home/20260226807932/en/Revel-Raises-$150M-Series-B-to-Modernize-the-Software-Layer-Behind-Hardware-Test-and-Control)
