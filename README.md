# ERPL GC-4 — Ground Control

Local webserver ground control software for a collegiate liquid rocket test stand.
Valve and solenoid actuation, live instrumentation, bang-bang pressure control,
preset autosequences, and CSV data recording — all driven from one config file.

**Zero npm dependencies** for the simulator and the UDP driver — Node built-ins
only, so it runs on a laptop at the pad with no internet and no install step.
The serial-attached drivers (`serial`, `stand`) add `serialport`, and NI-DAQ
acquisition needs Python with `nidaqmx`.

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
- [The control sidebar](#the-control-sidebar)
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
3. Enable both bang-bang controllers — the emulated board takes over and the
   tanks come up to setpoint. Watch the board's PT and the DAQ's disagree
   slightly on the card; that divergence is modelled on purpose.
4. **HOT FIRE** — 10 s countdown, igniter, ox lead, 5 s burn, cutoff and purge.
   Recording starts automatically; the CSV appears in the sidebar when it stops.

Press **ABORT** at any point to see everything drive safe.

---

## The four pages

Each is a separate page, so you can pull them into separate browser windows
across separate monitors — grid on one screen, P&ID on another.

### Control Grid (`/`)

Every actuator as a button, grouped by system (Pressurization, Vent & Relief,
Runlines, Fill & Drain, Purge & Auxiliary). Each button shows its tag,
description, type, and live state. Interlocked valves are dimmed with a padlock
and a tooltip saying why. A compact readout strip across the top keeps every
sensor visible while you work the valves; toggle it off if you want the buttons
full-screen. The strip is ordered by sensor group and carries each group's
colour on the card edge, so the LOX channels read as a block and the fuel
channels as another. Every readout shows its rate of change.

**A valve click commands the valve. There is no confirmation dialog.** ARM is
the gate that makes actuators live, and once the stand is armed the operator is
working the valves — a modal between the click and the coil costs time exactly
when it is most expensive. The interlocks below still apply to every command;
what is gone is the second click, not the rule.

### P&ID (`/pid.html`)

The same actuators laid out on a real piping and instrumentation diagram, drawn
with ISA symbols — bowtie valve bodies, solenoid coil boxes, pneumatic ball valve
actuators, regulator diaphragms, check valves, rupture disks, filters, vent
stacks, quick disconnects. Click any valve symbol to command it.

Instruments render as ISA bubbles with dashed lead lines to their tap points.
**Each bubble takes its sensor group's colour** — LOX blue, fuel red,
thermocouples yellow, load cells purple — so the instrument types separate at a
glance without reading a single tag. Alarm state still repaints the bubble on
top of that: knowing a channel is a thermocouple matters less than knowing it
is in danger. Tanks show liquid level from
their load cells. Lines animate when propellant is actually flowing through them.
The engine grows an exhaust plume scaled to chamber pressure.

Scroll to zoom, drag to pan, `0` to reset. The **padlock** button in the toolbar
freezes the view so a stray scroll or drag during a test cannot move the
diagram out from under you; the setting sticks across reloads.

### Data (`/data.html`)

**Every channel on one screen, with nothing to scroll.** Each sensor group gets
a full-height column, and the cards are sized so the longest column fills the
viewport exactly. During a test an operator reads this page at a glance, and a
channel one flick of a scroll wheel away is a channel nobody is watching.

Groups come from `sensorGroups` in the config, so the Draco stand reads as
**LOX**, **Fuel**, **Pneumatic & Purge**, **Load Cells** and **Thermocouples**
rather than one undifferentiated wall of pressure transducers. Each column's
colour runs down the left edge of its cards — blue for LOX, red for fuel — and
the venturi channels sit with the propellant run they measure rather than in a
category of their own. Alarm state repaints the rest of the card's border but
never that stripe: which system a channel belongs to does not change because it
went out of range.

Each card carries, in this order:

- the **sensor's name**, the largest and boldest thing on it — that is what you
  scan for on a wall of twenty-two cards;
- the **tag** and hardware channel below it, in monospace, to confirm what you
  found;
- the live value and its **rate of change** (`▲ 12.4 psi/s`), a least-squares
  slope over the last 3 s rather than a two-point difference, so a noisy
  transducer reports its trend instead of its jitter. Direction is carried by
  an arrow as well as a colour, and a slope inside 0.05 % of full scale per
  second reads as flat rather than flickering between ▲ and ▼ on a still tank;
- a sparkline over the selectable window (15/30/60/120 s) and a range bar.

Window min/max moved to each card's tooltip to make room; it stays exact in the
Table view. Switch to **Table** for the dense view — same groups, same order,
plus a Rate column.

#### Taring

Zeroing happens here, in both views:

- **TARE** on any channel zeroes it against its current reading.
- **TARE ALL** in a group header does the whole group at once — one button for
  every pressure transducer.
- A tared channel's button shows the offset it is applying (`−12.4`) instead of
  the word TARE, and grows a **✕** that clears it. Clicking TARE again re-zeroes
  at the current reading rather than stacking a second offset.

The buttons appear only on channels the hardware can actually zero, so a card
that has gone quiet offers none. On the Draco stand that is the NI cDAQ: the
zero is applied inside the acquisition sidecar, before the reading is converted,
which is why it survives on the raw trace and not just on screen. See
[The Draco stand](#the-draco-stand---driverstand).

Every tare is written to the event log and therefore into the CSV. It has to
be: every row after that line means something different from the rows before
it, and a trace read back months later has to show where that happened.

While any offset is applied, a **TARE _n_** chip sits in the shared header on
every page, listing the affected channels in its tooltip. Zeroing is done here,
but it changes what the readings mean on the Control Grid and the P&ID too, and
an operator on those screens is entitled to know.

There is deliberately no confirmation dialog. A tare is visible for as long as
it is applied, reversible in one click, and recorded — which is a better safety
property than a modal, and it does not cost a click every time a channel is
zeroed before a test. What a tare *is* refused for is covered in the
[safety model](#safety-model).

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
connected browser.

**Autosequences can be edited and saved while the stand is ARMED.** Retiming a
countdown between attempts is ordinary test-day work, and requiring a disarm to
do it costs more than it buys. The save is compared against the running config
section by section: if anything outside `autosequences` differs, it is refused
until you disarm. An armed save also skips the browser reload — the sequence
list on every station updates in place rather than reloading a control screen
mid-test.

Wiring is a different matter. Channels, calibrations, safety policy and the
P&ID describe the hardware, and swapping those under a live stand would change
the meaning of every command already on screen — so those still require a
disarm. Saving of any kind is refused while a sequence is running.

---

## The control sidebar

The same sidebar mounts on both actuation pages, so switching views never means
re-learning a layout. Everything in it is generated from `stand.json`.

### Link indicators

The header carries one chip per hardware device — `NIDAQ`, `PANDA`, or whatever
single device a simpler driver presents. Each reads **LIVE** while data is
arriving, and switches to **the time since the last frame** the moment it stops:
`PANDA 4.2s`, `NIDAQ 3m 08s`. A device that has never sent anything reads
`NO LINK`.

An age is the number that matters during a fault. "NO LINK" alone cannot tell a
cable knocked out two seconds ago from a board that never came up, and those
are different problems in different racks. The age keeps counting between
telemetry frames, and keeps counting after they stop.

`LINK LOST` is separate, and means the *browser* lost its stream from the
server. The device chips beside it are then a snapshot of what was true when
the stream died.

### Bang-bang pressure control

**The regulator runs on the PANDA board, not here.** GC-4 pushes configuration,
asks the board to start and stop, issues vent and abort overrides, and displays
what the board reports. It never commands the press valve.

That split is deliberate and safety-relevant: if the serial link, this server,
or the browser dies, the board keeps regulating with the last configuration it
accepted. A ground station that closed the loop itself would drop the press
valve on a disconnect — mid-fill, with a tank at setpoint and nobody watching.
It is also why a second loop in the browser is a hazard rather than a feature:
two controllers on one solenoid, reading two different transducers, with no
arbitration between them.

The wire protocol is documented in `HANDOVER_COMMS.md` §5 and implemented in
[bb-protocol.js](server/hal/bb-protocol.js).

#### Which half owns what

| Board (authoritative) | Ground station |
|---|---|
| The hysteresis loop | What setpoint and band to use |
| Setpoint, deadband | The `requiresArm` interlock |
| `wait_ms` dwell | The leak trip |
| `max_open_ms` pulse limit | The abort threshold |
| Auto-vent trigger | Display, logging, the enable handshake |
| **The actual valve state** | |

The three ground-station trips exist because the protocol has no equivalent for
them. They are **supervisory**: each can send `b<side>0` or `x<side>` — stop
regulating, or abort — and nothing else. They cannot open a valve, they cannot
hold one open, and if the link drops they simply stop being able to intervene
while the board carries on. That is the cost of putting the loop on the board,
and it is the right trade: a watchdog that fails silent beats a control loop
that fails open.

#### The panel

| Setting | Runs on | What it does |
|---|---|---|
| **Setpoint** | board | Target pressure |
| **Deadband ±** | board | Board opens below `setpoint − deadband`, closes above `setpoint + deadband`. Sent to the board as the **full** band width, i.e. twice this |
| **Max pulse** (ms) | board | `max_open_ms`. One actuation holds the press valve open at most this long. `0` = no limit |
| **Dwell** (ms) | board | `wait_ms`, the board's minimum dwell between valve transitions. `0` = none |
| **Auto-vent at** | board | The `V` command's trigger. Pressure at which the board enters `AV` and vents. Empty = no vent config pushed |
| **Board may auto-vent** | board | Arms that trigger. Off by default — venting a tank is not something to start doing because a field was left unset |
| **Leak trip** (s) | ground | The board reporting its press valve open this long without reaching setpoint tells the board to stop. `0` = no trip |
| **Abort above** | ground | *Either* transducer above this latches a stand-wide ABORT and aborts the side. Empty = no threshold |

`VENT` is a manual override (`v<side>`), independent of auto-vent and accepted
by the board in any state. `ABORT SIDE` (`x<side>`) is **latched on the board**:
nothing in the protocol clears it, so recovery needs a disarm/rearm or a power
cycle. The card says so before you click it.

The values in `stand.json` are the *starting* values: once the server is
running these are runtime settings, and an edit survives a config hot-reload
rather than being overwritten by the file. Every change is written to the event
log and the CSV. Rules enforced server-side, which refuse an edit rather than
half-apply it:

- **Max pulse must be shorter than the leak trip.** Otherwise the trip fires
  first and drops the controller instead of limiting the pulse.
- **Auto-vent needs a trigger pressure.** Arming it with nowhere to vent at is
  refused.
- **A pulse or dwell may never delay a CLOSE.** Enforced in the emulated
  firmware; on real hardware it is a **property to verify** — see *Unverified
  against hardware* below.

#### What the card shows

The big number is **the board's own transducer** — the one the loop is actually
regulating against. The line beneath it is the DAQ's reading of the same tank
and the gap between them. Two sensors on one tank can legitimately disagree,
and a quiet disagreement is worth seeing before it matters rather than after.

The badge reports the board's state machine: `OFF`, `SUSTAIN`, `AUTO-VENT`,
`ABORT`, plus `FILLING` whenever the board says its press valve is open. Three
badges mean *the screen is not current*, which reads very differently from a
loop that is off:

- **CONFIRMING** — config pushed, waiting for the board's `CFG_PUSH` echo. The
  enable is not sent until it arrives: enabling on a setpoint the board has not
  confirmed regulates to the wrong pressure.
- **STARTING** — confirmed, waiting for the board to report `SUS`.
- **NO LINK** — no heartbeat. The board is probably still regulating, because
  the loop lives there; we have merely stopped being told about it.

While a side is live, **manual commands to its valves are refused**, with the
controller named in the error. Taring its sensor is refused too.

Autosequence `bangbang` steps can set the same fields, plus `vent` and `abort`.

#### Unverified against hardware

These could not be resolved from `HANDOVER_COMMS.md` alone, and are called out
in the code where they bite. **Check them against firmware before a hot fire.**

- **`wait_ms` may delay a CLOSE.** GC-4's old limit never could. The board's is
  documented as a dwell between *any* valve transitions. A dwell that can hold
  a press valve open past setpoint is a materially different safety property.
- **The vent solenoid mapping.** `ventValve` ships unset. Two things are open:
  whether the board's BB vent is the GN2 vent at all (`hardware.json` marks
  DC3/DC4 as pushbutton channels while the BB press valves are solenoids), and
  whether the heartbeat's `vent01` bit reports coil state or flow state. These
  vents are normally-open, so the two readings are opposites — setting it now
  makes the board's "not venting" reopen a vent the operator just closed.
- **`rho`** is sent in the `M` command but has no `CFG_PUSH` echo key, so the
  density the board is using cannot be verified from the ground.
- **Abort recovery.** Assumed to need a power cycle or a disarm/rearm.

---

## Safety model

Every interlock lives on the server. The browser is a view, never the authority —
a stale tab, a dropped network link, or a second operator on another laptop
cannot bypass a rule.

| State | Behaviour |
|---|---|
| **DISARMED** | Valves marked `requiresArm` cannot be opened. Bang-bang sides marked `requiresArm` are told to stop (`b<side>0`). |
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
- **Controller watchdog** — `maxOpenSeconds` tells the board to stop if it
  reports its press valve open that long without reaching setpoint. That is a
  leak or a dead transducer, and it stops the board from dumping the whole
  pressurant bottle into the atmosphere. Supervisory: it needs the heartbeat,
  so a dead link disables it while the board carries on regulating.
- **Abort thresholds** — `abortAbove` on a controller and `abortConditions` on a
  sequence are evaluated every control tick. A controller's threshold watches
  *both* the board's transducer and the DAQ's, because they are two different
  sensors on the same tank.
- **One controller per valve** — while a board bang-bang side is live, manual
  and sequence commands to its valves are refused. Two command sources on one
  solenoid with no arbitration is the failure mode this replaced.
- **Taring is interlocked against closed-loop control** — a tare changes what
  every subsequent reading *means*. Zeroing a tank transducer sitting at 450 psi
  tells the stand it is at ambient, and anything acting on that number will then
  try to put 450 psi on top of the pressure already there. So a tare is refused
  while a sequence is running, and refused for any sensor an **enabled**
  bang-bang controller is steering on. ARM alone is not a reason to refuse:
  finding a drifted zero after arming is exactly when an operator needs this,
  and with no controller enabled and no sequence running, a tare moves a number
  on a screen and in the CSV, not a valve.
- **Wiring is locked while armed** — valves, sensors, calibrations, safety policy
  and the P&ID cannot be saved with the stand armed. Autosequences can be:
  retiming a countdown does not change what any command on screen means.
  Nothing at all can be saved while a sequence is running.

Two things are deliberately *not* protected by a dialog:

- **Valve commands are never confirmed.** ARM is the gate; see
  [Control Grid](#control-grid-).
- **`requiresArm` is not editable from the control screen.** It is a policy for
  the stand, not a knob for the test, and a policy an operator can switch off
  mid-test is not a policy. It lives in the config file, behind the disarm.
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

`calibration` converts raw ADC counts to engineering units:
`value = raw * slope + offset`. The `lead` is the point on the drawing the
instrument taps; a dashed line is drawn from the bubble to it.

### Grouping sensors

`group` names an entry in `sensorGroups`, which decides the column a sensor
lands in on the Data page, the outline colour of its card, and the colour of
its bubble on the P&ID:

```json
"sensorGroups": [
  { "id": "lox",  "label": "LOX",           "color": "#3b82f6" },
  { "id": "fuel", "label": "Fuel",          "color": "#ef4444" },
  { "id": "temp", "label": "Thermocouples", "color": "#eab308" }
]
```

Group by the **system**, not by the instrument type: a venturi belongs with the
propellant run it measures. Where the type *is* the useful grouping — the
thermocouples, the load cells — a group per type says exactly that.

`group` defaults to `kind`, so a config that predates `sensorGroups` still
groups by type the way it always did. A group a sensor names but the file never
defines is synthesized with a neutral colour rather than dropped: losing a
channel to a typo is the one outcome not worth risking.

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
who have not picked one on their machine. `ui.gridColumns` controls the valve
grid's density; the Data page takes its columns from `sensorGroups` instead.
Remove an entry from `ui.pages` to hide that page from the header.

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
node server/index.js --driver=stand                                  # the Draco stand
node server/index.js --driver=udp --host=192.168.1.50 --driver-port=5000
node server/index.js --driver=serial --port-name=COM4 --baud=921600
```

`udp` is dependency-free. `serial` and `stand` need `npm install serialport` —
the only package this project will ever ask you for, and only for those drivers.

### The Draco stand (`--driver=stand`)

The stand splits reading from actuating across two boxes, so this driver
composes two devices behind the single HAL interface:

| Device | Hardware | Role |
|---|---|---|
| `nidaq` | NI cDAQ-9189 — 9237 (load cells), 9208 (4–20 mA PTs), 9211 ×2 (thermocouples) | Instrumentation |
| `panda` | Custom Teensy board, USB serial 460800 8N1 | Valves, igniter, arm latch |

Wiring lives in `config/hardware.json` — chassis name, card slots, serial port,
and the channel maps that tie hardware channels to sensor ids. Copy
[`config/hardware.example.json`](config/hardware.example.json) and edit it:

```bash
cp config/hardware.example.json config/hardware.json
npm run stand
```

It is deliberately a **separate file from `stand.json`**. That one is edited
through the Config page and rewritten wholesale on save; wiring should not be
reachable from a browser, nor churn when someone retimes a sequence. It is
also gitignored, because the COM port and chassis name are per-machine.

**Channel maps are the thing to get right.** DAQ channel indices restart at 0
on every card, so a bare channel number is ambiguous. Keys carry the card:

```json
"channelMap": { "pt2": "PT1", "lc0": "LC1", "tc3": "TC4" }
```

`pt0` is NI-9208 `ai0`; `tc0`–`tc3` are the slot-3 9211 and `tc4`–`tc7` the
slot-4 one. A channel not in the map is still acquired and logged, but never
becomes a sensor reading.

### Where the names come from

`sensor_config.xlsx` at the repo root is the master naming source, and
`Draco V4.00.pdf` is the drawing those names appear on. Sensor ids in
`stand.json` are the **P&ID tag** (`PT4`, `TC1`, `LC4`), because that is what
the diagram labels and what an operator reads off the stand.

Two traps the workbook sets, both of which will silently mis-wire a channel:

- **The `id` column is not the P&ID tag.** `id` is the DAQ-side label
  (`PT5E`), while the tag the drawing shows is the leading token of the
  `name` column (`PT4 LOX Tank Downstream` → `PT4`). They are offset from
  each other by the wiring.
- **A DC channel's report position is not its actuation channel.** The
  workbook's `channel` is where the board *reports* current on its `s` line;
  the numeric part of `id` is the channel it *actuates* (`S5`). Per the
  workbook the purges (DC7/DC8) report at positions 4/5 while the runlines
  (DC5/DC6) report at 6/7 — the two pairs are swapped, and position 8 is
  unpopulated. `hardware.json` keys `dcChannels` by report position and
  carries the actuation channel in `id`, so both stay explicit.

Valve `abbrev`s are prefixed with the drawing tag (`PB2 OX RUN`) so a button
in the UI can be matched to a symbol on the P&ID without a lookup table.

NI-DAQmx binds only to Python, so acquisition runs in
[`server/hal/devices/daq_streamer.py`](server/hal/devices/daq_streamer.py),
spawned as a child process speaking newline-JSON over stdio. You need the
NI-DAQmx Runtime and `pip install nidaqmx`. Because stdin is a real
back-channel, tare and calibration commands are ordinary messages rather than
sentinel files dropped in a polled directory.

Taring lives there rather than in the Node server on purpose: the sidecar
zeroes against the last raw sample the card actually took, in the card's own
units, *before* conversion to psi. A zero applied further up would only correct
the display, leaving the raw trace and the conversion disagreeing with it. Each
channel carries its current offset in every telemetry frame, so the host
re-learns the truth after a sidecar restart instead of reporting a stale zero.

A channel with no valid reading — an open transducer — keeps whatever tare it
already had and is named in the reply, rather than being silently zeroed to
nothing.

Three hardware notes that cost real time to rediscover:

- **The 9237 (DSUB) does not expose `ai_adc_timing_mode`** and rejects it with
  `-200452`. Its rate then coerces to 12800/8 = 1612.9 Hz; the streamer sizes
  the buffer to match and drains it each pass, which sustains that rate with
  no overruns. Optional DAQmx properties are all set best-effort for this
  reason — an unsupported one degrades the stream instead of killing the task.
- **The 9211 has no sample clock.** It is read on demand (~350 ms per call)
  from its own thread, so the control loop never blocks on it.
- **PANDA `p` lines carry volts across the shunt, not milliamps,** on current
  firmware. Getting this wrong yields plausible-looking garbage rather than an
  obvious failure, so `ptInputMode` is explicit in the config.

If the PANDA is marked `"required": false`, GC-4 will still come up on DAQ
data alone and refuse valve commands — useful for instrumentation checkouts.

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
get status()                  // -> { name, connected, detail, lastRxAt }
async close()
```

`safeAll()` is optional but recommended. So is the zeroing pair, which is what
puts TARE buttons on the Data page:

```js
tareSensors(ids, { clear })   // -> { ok, tared: [], unsupported: [], error? }
tareStatus()                  // -> { sensorId: offsetInSensorUnits }
```

`tareStatus()` must return an entry for every sensor the device *can* zero,
`0` included — the presence of the key is what tells the UI to offer a button,
and its value is what the button displays. A driver that implements neither
simply shows no tare controls. `unsupported` is an ordinary answer, not a
failure: a composite stand offers the same list of ids to each of its devices
and lets them claim what they own.

`lastRxAt` is when the driver last received data (`Date.now()`, or `0` if it
never has). The header's link indicator turns it into **LIVE** or an age, so a
driver that omits it reads as "never came up" the moment it disconnects. A
driver that synthesizes its data — the simulator — reports the current clock.

A driver that fronts several boxes reports `devices: [{ key, connected,
required, lastRxAt, detail }, ...]` as well, and gets one indicator per entry;
see `composite.js`. Everything else gets a single indicator automatically.

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
  bangbang.js      pushes config to the board's regulator; supervisory trips
  sequencer.js     time-based autosequence engine + abort condition monitor
  recorder.js      CSV writer and metadata sidecars
  hal/
    index.js       driver registry + the composed `stand` driver
    simulator.js   lumped-parameter stand model
    udp.js         Ethernet controller (dependency-free)
    serial.js      USB serial controller (needs `serialport`)
    nidaq.js       NI cDAQ instrumentation, via the Python sidecar
    panda.js       PANDA board actuation over USB serial
    bb-protocol.js the board's bang-bang wire format, both directions
    bb-firmware.js an emulation of the board's regulator, for the simulator
    composite.js   several devices behind one driver interface
    devices/
      daq_streamer.py   NI-DAQmx acquisition, newline-JSON over stdio
config/
  stand.json       THE config — everything is generated from this
  stand.schema.json  JSON Schema for editor autocomplete
  hardware.example.json  wiring template for --driver=stand
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
| `POST` | `/api/tare` | Zero instrumentation: `{sensors:[…]}` or `{kind:"pressure"}`, plus `clear` to undo |
| `POST` | `/api/controller` | Bang-bang: `enabled`, `setpoint`, `deadband`, `maxOpenMs`, `minIntervalMs`, `ventTrigger`, `ventAuto`, `maxOpenSeconds`, `abortAbove`, plus the overrides `vent` and `abort` |
| `POST` | `/api/sequence/start` `/api/sequence/stop` | Autosequences |
| `POST` | `/api/record/start` `/api/record/stop` | Recording |
| `GET` | `/api/record/list` `/api/record/download/:name` | Recorded files |
| `PUT` | `/api/config` | Validate, back up, save, hot-reload. While armed, accepts autosequence changes only |

---

## Testing

```bash
npm test
```

Unit tests cover the logic whose mistakes are silent on real hardware:

- **PANDA line parser** — volts→mA→psi, normally-open coil polarity, the
  `1`–`9`,`A`–`C` solenoid tokens, partial-chunk reassembly.
- **Composite driver** — routing, degraded-mode behaviour, the per-device link
  state the header indicators read, and which device a tare is routed to.
- **NI-DAQ addressing** — sensor id to card and channel. A tare that lands on
  the wrong channel zeroes a transducer nobody was looking at and leaves the
  intended one reading as before, with nothing on screen to say so.
- **Client lookups** (`public/js/bus.test.js`) — the rate-of-change fit and
  sensor grouping. "The tank is filling at 50 psi/s" is a number an operator
  acts on, and a sign error or a botched window reads as a plausible number
  rather than as a fault.
- **The bang-bang wire format** (`server/hal/bb-protocol.test.js`) — encoding
  byte for byte against `HANDOVER_COMMS.md` §5, and two decode properties that
  fail silently when they are wrong: prefix checks must precede the comma test
  (or every `CFG_PUSH` confirmation is filed as telemetry and never reaches the
  operator), and the heartbeat's pressure field must stay optional (or a legal
  5-field heartbeat reads a pressurised tank as 0 psi).
- **The ground station's half of the loop** (`server/bangbang.test.js`) — that
  the host never commands the valve, in a full run; that the deadband is
  doubled on the wire; that nothing is enabled before the board's echo confirms
  the config; and that nothing ever gates a *stop*. The fake board in these
  tests is the real emulated firmware driven over the real wire format, so they
  are end to end through the protocol rather than against a mock that agrees by
  construction.
- **The emulated board** (`server/hal/bb-firmware.test.js`) — the hysteresis
  band, the pulse and dwell timers, auto-vent, and the latched abort. These
  assert what the board is *believed* to do. A failure means the emulation
  drifted from the spec; a disagreement with real hardware means the spec was
  wrong.

They need no hardware attached.

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
