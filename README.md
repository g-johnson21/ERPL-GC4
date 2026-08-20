# ERPL GC-4 — Ground Control

Local webserver ground control software for a collegiate liquid rocket test stand.
Valve and solenoid actuation, live instrumentation, bang-bang pressure control,
preset autosequences, and CSV data recording — all driven from one config file.

**Zero npm dependencies.** Node built-ins only, so it runs on a laptop at the pad
with no internet and no install step.

```
node server/index.js
```

Then open <http://localhost:8080>. It starts in **simulator** mode with a full
physics model of the Draco LOX/ethanol stand, so you can exercise every screen,
sequence and interlock before you ever touch hardware.

---

## Contents

- [Quick start](#quick-start)
- [The four pages](#the-four-pages)
- [Safety model](#safety-model)
- [Customizing for your stand](#customizing-for-your-stand)
- [Connecting real hardware](#connecting-real-hardware)
- [Data recording](#data-recording)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Testing](#testing)

---

## Quick start

Requires Node 18+ (developed on 22).

```bash
node server/index.js                    # simulator, port 8080
node server/index.js --port=9000        # different port
node server/index.js --driver=udp --host=192.168.1.50
node server/index.js --config=config/stand-b.json
```

The banner prints a LAN URL as well as localhost — open that on a second laptop
or a tablet and you have a second operator station. Every station sees identical
state; the server is the single authority.

Try this to see the whole system work:

1. **Pneumatics On** in the sidebar — charges the actuator supply.
2. **ARM** (top of the sidebar), confirm.
3. Enable both bang-bang controllers — watch the tanks come up to setpoint.
4. **HOT FIRE** — 10 s countdown, igniter, ox lead, 5 s burn, cutoff and purge.
   Recording starts automatically; the CSV appears in the sidebar when it stops.

Press **ABORT** at any point to see everything drive safe.

---

## The four pages

Each is a separate page, so you can pull them into separate browser windows
across separate monitors — grid on one screen, P&ID on another.

### Control Grid (`/`)

Every actuator as a button, grouped by system (Pressurization, Vent & Relief,
Main Propellant, Fill & Drain, Auxiliary). Each button shows its tag, description,
type, and live state. Interlocked valves are dimmed with a padlock and a tooltip
saying why. A compact readout strip across the top keeps every sensor visible
while you work the valves; toggle it off if you want the buttons full-screen.

### P&ID (`/pid.html`)

The same actuators laid out on a real piping and instrumentation diagram, drawn
with ISA symbols — bowtie valve bodies, solenoid coil boxes, pneumatic ball valve
actuators, regulator diaphragms, check valves, rupture disks, filters, vent
stacks, quick disconnects. Click any valve symbol to command it.

Instruments render as ISA bubbles showing live values, colour-coded by alarm
state, with dashed lead lines to their tap points. Tanks show liquid level from
their load cells. Lines animate when propellant is actually flowing through them.
The engine grows an exhaust plume scaled to chamber pressure.

Scroll to zoom, drag to pan, `0` to reset. The **padlock** button in the toolbar
freezes the view so a stray scroll or drag during a test cannot move the
diagram out from under you; the setting sticks across reloads.

### Data (`/data.html`)

All instrumentation in a grid, grouped by type — pressure transducers,
thermocouples, load cells. Each card carries the live value, a sparkline over a
selectable window (15/30/60/120 s), min and max across that window, a range bar,
and the hardware channel. Switch to **Table** for a dense sortable view of every
channel at once.

### Config (`/config.html`)

Three tabs:

- **Autosequences** — a full visual editor. Pick a sequence from the list, then
  edit its name, style, ARM requirement and confirmation prompt; add, duplicate,
  retime and delete steps in a table; and set abort conditions with a sensor,
  comparison and threshold. A timeline shows every step laid out against the
  clock, colour-coded by action — click a mark to jump to that row. Steps re-sort
  themselves whenever you change a time, and valve steps are tagged `ARM` when
  the valve they command needs the stand armed. **New**, **Duplicate** and
  **Delete** manage whole sequences.

  Step times can be entered two ways, switchable per sequence:

  | Mode | You type | Good for |
  |---|---|---|
  | **T+ from start** | seconds from T+0 | matching a written countdown |
  | **Δ from previous** | the gap since the step before | "hold 2 s, then open the mains" |

  Relative mode also prints each step's absolute `T+` beside the box, so you
  always know where you are on the clock. Changing a gap shifts every later step
  with it, preserving their spacing — retiming one step never silently rewrites
  the rest of the sequence. Either way the file stores absolute times, so what
  the sequencer executes is unchanged.
- **General** — the settings that change most often: branding, accent colour,
  theme, grid density, loop and CSV rates, recording directory, ARM policy.
- **Advanced (JSON)** — the raw file, for the P&ID layout and calibrations.

All three edit one draft; an *Unsaved changes* chip appears as soon as you touch
anything, and leaving the page warns you. The action bar stays pinned to the top
of the page, so **Validate** and **Save & Apply** (`Ctrl+S`) stay reachable no
matter how far down a long step list you have scrolled. Saving validates
server-side, writes a timestamped backup of the old file, then hot-reloads every
connected browser. Saving is refused while the stand is armed or a sequence is
running.

---

## Safety model

Every interlock lives on the server. The browser is a view, never the authority —
a stale tab, a dropped network link, or a second operator on another laptop
cannot bypass a rule.

| State | Behaviour |
|---|---|
| **DISARMED** | Valves marked `requiresArm` cannot be opened. Bang-bang controllers are forced off. |
| **ARMED** | Full manual and sequence control. |
| **ABORT** | Latched. Every actuator is driven to its `abortState`. Only safe-direction commands are accepted until cleared; clearing leaves the stand DISARMED. |

The rule that makes this workable in practice:

> **A command toward a valve's configured `safeState` is always permitted** —
> disarmed, mid-abort, whenever. You can always make the stand safer, never less
> safe.

So a normally-open vent (`safeState: "open"`) can always be opened, even during
an abort, while a drain valve (`safeState: "closed"`) cannot be opened until the
abort is cleared.

Other protections, all per-item configurable:

- **Momentary actuators** — igniters auto-revert after `momentaryMs` even if the
  operator walks away or the browser closes.
- **Controller watchdog** — `maxOpenSeconds` trips a bang-bang controller off if
  its valve stays open without reaching setpoint. That is a leak or a dead
  transducer, and it stops the controller from dumping the whole pressurant
  bottle into the atmosphere.
- **Abort thresholds** — `abortAbove` on a controller and `abortConditions` on a
  sequence are evaluated every control tick.
- **Config is locked while armed** — you cannot save a new configuration with the
  stand armed or a sequence running.
- **Safe on exit** — Ctrl+C, an uncaught exception, or a SIGTERM all drive every
  actuator to its safe state before the process dies.

> **Note on hardware watchdogs.** This software safes the stand when *it* fails.
> It cannot help if the laptop loses power or the link drops. Your stand
> controller must implement its own watchdog and drive outputs safe on loss of
> comms. The `udp`/`serial` drivers send a heartbeat to support this.

---

## Customizing for your stand

Everything lives in [`config/stand.json`](config/stand.json). Nothing about a
particular stand is hard-coded anywhere in the UI. `config/stand.schema.json`
gives you autocomplete and inline validation in VS Code and most editors.

### Adding a valve

```json
{
  "id": "SV-HE-ISO",
  "name": "Helium Isolation",
  "group": "press",
  "type": "solenoid",
  "channel": 13,
  "normallyOpen": false,
  "requiresArm": true,
  "confirm": false,
  "safeState": "closed",
  "abortState": "closed",
  "pid": { "x": 340, "y": 260, "rot": 90 }
}
```

It appears on the Control Grid, on the P&ID, in the CSV columns, and as a valid
target for autosequences immediately. `rot` is `0` for a horizontal pipe run and
`90` for a vertical one.

### Adding a sensor

```json
{
  "id": "PT-701", "name": "Regen Jacket Inlet",
  "kind": "pressure", "units": "psi", "channel": 16, "decimals": 1,
  "min": 0, "max": 1000,
  "warnHigh": 600, "dangerHigh": 750,
  "calibration": { "slope": 0.2442, "offset": -122.1 },
  "pid": { "x": 900, "y": 420, "lead": [960, 420] }
}
```

`kind` decides which group it lands in on the Data page. `calibration` converts
raw ADC counts to engineering units: `value = raw * slope + offset`. The `lead`
is the point on the drawing the instrument taps; a dashed line is drawn from the
bubble to it.

### Writing an autosequence

Use the **Autosequences** tab on the Config page — no JSON required. The format
below is what it produces, for reference or for editing by hand.

Steps fire when elapsed time reaches `t`, in order. If a tick runs late, any
steps it skipped over still fire, in order — the sequence keeps real time rather
than silently dropping commands.

```json
{
  "id": "seq-chill", "name": "LOX Chill-In", "style": "caution",
  "requiresArm": true, "confirm": true,
  "abortConditions": [
    { "sensor": "PT-301", "op": ">", "value": 250, "message": "Ox tank overpressure during chill" }
  ],
  "steps": [
    { "t": 0,  "action": "log",   "message": "Chill-in start" },
    { "t": 0,  "action": "valve", "target": "SV-OV", "state": "open" },
    { "t": 1,  "action": "valve", "target": "SV-LOX-FILL", "state": "open" },
    { "t": 45, "action": "valve", "target": "SV-LOX-FILL", "state": "closed" },
    { "t": 46, "action": "bangbang", "target": "bb-ox", "enabled": true, "setpoint": 120 }
  ]
}
```

Actions: `valve`, `bangbang` (`target: "*"` hits every controller), `log`,
`safeAll`, `abortStates`, `abort`, `end`.

### Redrawing the P&ID

`pid.components` are the static symbols, `pid.pipes` are polylines between
`[x, y]` points. A coordinate shared by two or more pipes is automatically dotted
as a tee. `flowWhen` lists the valves that must all be open for a line to animate:

```json
{ "id": "p-fuel-run", "fluid": "fuel",
  "points": [[470,510],[470,790],[1150,790],[1150,620],[1240,620]],
  "flowWhen": ["MV-F"] }
```

Add a service by adding a key to `pid.fluids` — it gets a colour, a line width,
and a legend entry automatically.

### Look and feel

`ui.accent` retints the whole interface (text colour on the accent is chosen
automatically for contrast). `ui.defaultTheme` sets light or dark for operators
who have not picked one on their machine. `ui.gridColumns` and
`ui.sensorGridColumns` control grid density. Remove an entry from `ui.pages` to
hide that page from the header.

### Branding

Two logo slots, each with a light and a dark variant:

```json
"ui":   { "logo":      { "light": "/img/erpl-black.png", "dark": "/img/erpl-white.png", "height": 19 } },
"meta": { "standLogo": { "light": "/img/draco.png",      "dark": "/img/draco-white.png", "height": 24 } }
```

`ui.logo` is the organization wordmark at the far left; `meta.standLogo` is the
stand badge beside its name. The P&ID title block takes its own mark from a
`logo` component in `pid.components` (`src` plus `srcDark`).

Supply **both** variants. These marks are silhouettes on transparency, so the
wrong one is invisible rather than merely off-colour. Full-resolution originals
live in [`assets/`](assets/); the web-sized copies actually served are in
`public/img/`.

---

## Connecting real hardware

Drivers live in [`server/hal/`](server/hal/). Pick one at startup:

```bash
node server/index.js --driver=simulator                              # default
node server/index.js --driver=udp --host=192.168.1.50 --driver-port=5000
node server/index.js --driver=serial --port-name=COM4 --baud=921600
```

`udp` is dependency-free. `serial` needs `npm install serialport` — the only
package this project will ever ask you for, and only if you use that driver.

Both speak the same ASCII line protocol, small enough to implement on a Teensy
or ESP32 in an afternoon:

```
GC  -> controller     SET <channel> <0|1>      energize / de-energize an output
                      SAFE                      drive all outputs safe
                      PING <seq>

controller -> GC      T <millis> <ch>:<raw> <ch>:<raw> ...   telemetry frame
                      PONG <seq>
```

`raw` is whatever your ADC produces; per-sensor `calibration` converts it. The
driver handles normally-open valves for you — a NO valve is energized to *close*,
so `SET` always carries the correct coil state for the commanded flow state.

To support different hardware (LabJack, NI DAQ, Pi GPIO, Modbus PLC), implement
five methods and register the class in `server/hal/index.js`:

```js
async init(config)            // one-time setup
setValve(valveCfg, state)     // state is 'open' | 'closed'
read()                        // -> { sensorId: engineeringValue }
get status()                  // -> { name, connected, detail }
async close()
```

`safeAll()` is optional but recommended.

---

## Data recording

Recording controls sit at the bottom of the sidebar on both actuation pages.
Type a test name, hit **START**, and every sample lands in
`data/{stand}_{date}_{time}_{name}.csv`. Sequences listed in
`recording.autoStartOnSequence` start recording on their own.

One row per sample at `recording.rateHz` (default 50 Hz):

| Column | Notes |
|---|---|
| `iso_time`, `epoch_ms`, `elapsed_s` | Absolute and test-relative time |
| `PT-101 (psi)`, `TC-201 (°F)`, … | One per sensor, tag and units in the header |
| `MV-F (state)`, … | One per valve, `1` open / `0` closed |
| `bb-fuel setpoint`, `bb-fuel enabled` | Controller settings as they change |
| `armed`, `sequence` | Stand state and the running sequence id |
| `event` | Log lines emitted since the previous row |

Because commands, arm state, and sequence progress are all *in the same file* as
the data, a single CSV tells the whole story of a test — you can see exactly what
the chamber pressure was doing the instant the main valve was commanded.

A `.meta.json` sidecar next to each CSV stores the complete config used for that
run — calibrations, setpoints, sequences — so a trace can still be interpreted
correctly months later, after the stand has been rebuilt twice.

Files are listed in the sidebar with download links, newest first.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `T` | Toggle light / dark theme |
| `\` | Show / hide the control sidebar |
| `0` | Reset P&ID zoom and pan |
| `+` / `-` | Zoom the P&ID |
| `L` | Lock / unlock the P&ID view |
| `Ctrl+S` | Save the configuration (Config page) |
| `Esc` | Cancel a confirmation dialog |

There is deliberately **no keyboard shortcut for ABORT or for valve actuation** —
a mis-key during a test should never move hardware.

---

## Architecture

```
server/
  index.js         HTTP, REST API, SSE telemetry stream, static files
  state.js         StandController — authoritative state, interlocks, tick loop
  config-store.js  load / validate / hot-reload, timestamped backups
  bangbang.js      hysteresis controllers with leak and abort watchdogs
  sequencer.js     time-based autosequence engine + abort condition monitor
  recorder.js      CSV writer and metadata sidecars
  hal/
    index.js       driver registry
    simulator.js   lumped-parameter stand model
    udp.js         Ethernet controller (dependency-free)
    serial.js      USB serial controller (needs `serialport`)
config/
  stand.json       THE config — everything is generated from this
  stand.schema.json  JSON Schema for editor autocomplete
public/
  *.html           one page per window
  js/bus.js        the only module that talks to the network
  js/chrome.js     shared header and control sidebar
  js/pid-symbols.js  ISA symbol library
  js/page-*.js     per-page logic
```

The control loop runs at `telemetry.sampleRateHz` (50 Hz default). Each tick
reads sensors, runs controllers, advances the sequencer, and feeds the recorder.
Snapshots are pushed to browsers at `telemetry.streamRateHz` (20 Hz) over
Server-Sent Events; commands go back over plain `POST`. SSE was chosen over
WebSockets because it needs no dependency, reconnects on its own, and telemetry
is inherently one-way — command latency over local HTTP is a few milliseconds.

Every command response carries a fresh state snapshot, so the UI reflects the
true post-command state immediately rather than optimistically predicting it. A
rejected command can never leave a valve looking open when it is closed.

### API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/stream` | SSE: `state`, `log`, `config` events |
| `GET` | `/api/state` `/api/config` `/api/history` `/api/events` | Snapshots |
| `POST` | `/api/arm` `/api/abort` `/api/abort/clear` | Stand state |
| `POST` | `/api/valve` `/api/safe-all` | Actuation |
| `POST` | `/api/controller` | Bang-bang settings |
| `POST` | `/api/sequence/start` `/api/sequence/stop` | Autosequences |
| `POST` | `/api/record/start` `/api/record/stop` | Recording |
| `GET` | `/api/record/list` `/api/record/download/:name` | Recorded files |
| `PUT` | `/api/config` | Validate, back up, save, hot-reload |

---

## Testing

The simulator exists so the software can be exercised end to end without
hardware. It models pressurant blowdown, tank pressurization and venting, injector
flow against chamber pressure, combustion, thrust, and thermal response. A hot
fire produces a sustained ~400 psi chamber pressure at ~630 lbf on the shipped
config.

It is tuned for *plausible traces to shake out the UI and sequences*, not for
engineering-grade prediction. **Do not size hardware from these numbers.**

Two things worth knowing if you modify it:

- Physics is integrated in fixed 5 ms sub-steps regardless of how long the host
  actually took between ticks. These are explicit-Euler relaxations, so a
  stretched tick (timer jitter, GC pause, a busy laptop) would otherwise let
  chamber pressure leap past tank pressure, zero the injector Δp, and "flame out"
  an engine that is physically running fine.
- `pressGain` is deliberately modest. Set it high enough that a tank fills faster
  than one control tick can react and bang-bang will overshoot its whole
  deadband — a simulator artefact, not something a real solenoid does.

Role-to-tag mapping lives at the top of `simulator.js`; edit it if your stand
uses different tags, or just run against `--driver=udp`.
