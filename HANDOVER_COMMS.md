# ERPL_GC Communication Handover

**Purpose:** everything needed to re-implement NI-DAQ and PANDA connectivity in a different ground-control application. This documents the wire protocols, framing, timing, calibration math, the bang-bang control interface, and the complete set of messages each side can emit — precisely enough to reimplement from scratch without reading this repo's source.

Reference implementations in this repo:

- NI-DAQ acquisition: [ni_daq/daq_streamer.py](ni_daq/daq_streamer.py), [ni_daq/devices/](ni_daq/devices/)
- NI-DAQ fan-out: [ni_daq/server.js](ni_daq/server.js)
- PANDA bridge: [panda/main.py](panda/main.py)
- Second PANDA implementation (richer line parsing): [moe/server.py](moe/server.py)
- Example browser client: [panda/moeui.html](panda/moeui.html)

Where the two PANDA implementations disagree, both readings are given and the conflict is flagged. **Do not assume either is correct without checking against firmware.**

---

## 1. Topology at a glance

```
   NI cDAQ-9189 chassis                       Teensy "PANDA" board
   192.168.8.236 (Ethernet)                   USB CDC serial, 460800 8N1
            |                                          |
      NI-DAQmx driver                             pyserial
            |                                          |
   daq_streamer.py (Python)                    main.py (Python, asyncio)
            |                                          |
      TCP :5001  -- JSON lines, push-only        +- WebSocket :3941  (bidirectional)
            |                                    +- HTTP :8090       (static UI files)
      server.js (Node)                           +- UDP multicast 239.255.0.1:5005 (one-way)
            |
      WebSocket :3000 (bidirectional)
      HTTP :3000 (static UI + /api/*)
            |
        Browser UIs
```

Two entirely independent stacks. They share only the master sensor workbook `sensor_config.xlsx` and the fact that one browser page ([panda/moeui.html](panda/moeui.html)) opens sockets to both.

**Key asymmetry:** the NI-DAQ path has a *two-process* split (Python acquires, Node fans out) with a one-way TCP hop between them. PANDA is a single process that owns both the serial link and the WebSocket server. If you are reimplementing, you can collapse the NI-DAQ split into one process — the TCP hop exists only because acquisition is Python (NI-DAQmx bindings) and the original server was Node.

---

## 2. NI-DAQ subsystem

### 2.1 Hardware and driver layer

Chassis `cDAQ9189-2462EFD` at `192.168.8.236`, gRPC port 31763 (see [ni_daq/config.py](ni_daq/config.py)). Modules are addressed as `<chassis>Mod<slot>`.

| Slot | Module | Role | Channels | Native rate |
|------|--------|------|----------|-------------|
| 1 | NI-9237 | Bridge / load cells | 4 (`ai0:3`) | 100 Hz (forced) |
| 2 | NI-9208 | 4–20 mA current / PTs | 16 (`ai0:15`) | 100 Hz |
| 3 | NI-9211 | Thermocouples | 4 (`ai0:3`) | ~1–3 Hz, on-demand only |

Each driver auto-detects its module by scanning `nidaqmx.system.System.local().devices` for a name starting with the chassis and a `product_type` containing the model number, falling back to the configured slot. Requires the **NI-DAQmx Runtime** plus the `nidaqmx` Python package.

### 2.2 Channel configuration (must be replicated exactly)

**PT — NI-9208** ([ni_daq/devices/pt_card.py](ni_daq/devices/pt_card.py)):

```python
task.ai_channels.add_ai_current_chan(
    f"{device}/ai0:15",
    min_val=-0.022, max_val=0.022,          # Amps
    terminal_config=TerminalConfiguration.DEFAULT)
task.timing.cfg_samp_clk_timing(rate=100.0,
    sample_mode=AcquisitionType.CONTINUOUS,
    samps_per_chan=1000)                     # 10 s onboard buffer
task.in_stream.input_buf_size = 6000         # 60 s host buffer
task.ai_channels.all.ai_adc_timing_mode = ADCTimingMode.HIGH_SPEED  # required >= 50 Hz
task.ai_channels.all.ai_digital_filter_enable = False
```

`HIGH_SPEED` is mandatory at 100 Hz (2 ms/channel). `HIGH_RESOLUTION` is 52 ms/channel (~19 S/s) and will not keep up.

**LC — NI-9237** ([ni_daq/devices/lc_card.py](ni_daq/devices/lc_card.py)):

```python
task.ai_channels.add_ai_bridge_chan(
    f"{device}/ai0:3",
    min_val=-0.025, max_val=0.025,           # V/V
    units=BridgeUnits.VOLTS_PER_VOLT,
    bridge_config=BridgeConfiguration.FULL_BRIDGE,
    voltage_excit_source=ExcitationSource.INTERNAL,
    voltage_excit_val=10.0,                  # 286 mW into a 350 ohm bridge
    nominal_bridge_resistance=350.0)
task.timing.cfg_samp_clk_timing(rate=100.0, sample_mode=CONTINUOUS, samps_per_chan=1000)
task.ai_channels.all.ai_adc_timing_mode = ADCTimingMode.HIGH_RESOLUTION  # CRITICAL
for ch in task.ai_channels: ch.ai_auto_zero_mode = AutoZeroType.NONE
```

**The `HIGH_RESOLUTION` line is load-bearing.** The 9237 is a delta-sigma part; in `HIGH_SPEED` it coerces to ~1612.9 Hz (12800/8) and you get continuous `-200279` buffer overruns. `HIGH_RESOLUTION` allows decimation down to 100 Hz. The code reads back the coerced rate and, if it still landed in high-speed, switches to draining with `READ_ALL_AVAILABLE` and a chunk size derived from the host loop rate.

**TC — NI-9211** ([ni_daq/devices/tc_card.py](ni_daq/devices/tc_card.py)):

```python
for ch in range(4):
    task.ai_channels.add_ai_thrmcpl_chan(
        f"{device}/ai{ch}",
        min_val=-320.0, max_val=2282.0,      # degF; -328 is the Type-K poly floor
        units=TemperatureUnits.DEG_F,
        thermocouple_type=ThermocoupleType.K,   # per-channel from config
        cjc_source=CJCSource.BUILT_IN, cjc_val=77.0)
# NO cfg_samp_clk_timing — the 9211 has no sample clock.
```

The 9211 **cannot** be hardware-timed. It is read on-demand, one sample per channel per call, ~350 ms per call, from a dedicated background thread (`_tc_reader_thread`). The main loop never blocks on it; it consumes the last cached frame under a lock.

### 2.3 Why there is no hardware sync

Deliberately disabled (`hw_sync_enabled = False`). The 9237 (simultaneous delta-sigma) and 9208 (multiplexed scanning) have incompatible ADC architectures and cannot share a sample clock. Each module runs its own task with its own timebase; alignment is done by **host-side timestamping at the 100 Hz loop**. A combined-task path exists (`use_combined_task`) but defaults off as it is flaky across mixed modules.

### 2.4 Acquisition loop

Per-device persistent tasks, main loop paced to `samples_per_read / sample_clock_hz` (default 10/100 = 100 ms, i.e. **10 Hz loop reading 10 samples each**). Pacing uses an absolute `time.perf_counter()` deadline that resyncs if it slips a full period.

Reads request the most recent window rather than draining from the head:

```python
task.in_stream.read_relative_to = ReadRelativeTo.MOST_RECENT_SAMPLE
task.in_stream.offset = -read_count
raw = task.read(number_of_samples_per_channel=read_count, timeout=read_timeout_s)
```

This trades throughput for freshness — the UI always sees current data even if the host stalls. Error recovery you must replicate:

- `-200277` / "Invalid combination of position and offset" → fall back to `CURRENT_READ_POSITION` + `READ_ALL_AVAILABLE`
- `-200279` / "keep up with the hardware" → fall back to `CURRENT_READ_POSITION`, read 1 sample
- Repeated misses per device trigger a task stop/close/reconfigure/start cycle (`_restart_device_task`)

### 2.5 Engineering-unit conversion

**PT (4–20 mA → psi):**

```
psi = (current_mA - zero_ma) * (max_psi / 16.0) - tare_offset[ch]
```

`zero_ma` defaults to 4.0, span is fixed at 16 mA. `max_psi` comes from per-channel config; an alternate `max_psi_alt` can be selected at runtime per channel. Raw is Amps from DAQmx, so `mA = A * 1000`. Status is `disconnected` when `mA < 3.0` or `mA > 25.0`; an unconfigured channel raises and is reported `unconfigured` with 0.0.

**LC (V/V → lbf):**

```
lbf = slope * v_per_v + offset - tare_offset[ch]
```

With `slope_alt` selectable per channel. If no slope is configured it is derived from capacity and a 3.0 mV/V assumed rated output: `slope = capacity_lbf / (rated_mV_per_V / 1000)`, times an optional `mechanical_gain`.

**TC:** DAQmx returns °F directly; only a per-channel `offset` and tare are applied. `disconnected` when NaN, `< -450 °F`, or `> 3500 °F` (note: −350 °F is *valid* for LOX, so the threshold must stay below it).

The per-channel UI value uses the **latest** sample for PT and the **mean** of the window for LC and TC. Every sample in the window is still emitted separately for CSV logging.

### 2.6 Wire format: Python → Node (TCP 5001)

Python is the **client**, connects out to `localhost:5001`. Newline-delimited JSON, one object per line, UTF-8. Socket is persistent, `TCP_NODELAY` on, `SO_KEEPALIVE` on, **non-blocking**. On `BlockingIOError` (send buffer full) the frame is **dropped** rather than blocking the acquisition loop. On any connection error the socket is closed and a background reconnect thread retries every 1 s.

One merged frame per loop iteration (~10 Hz):

```json
{
  "timestamp": 1756046742.183,
  "source": "Merged",
  "channels": [
    {"channel":0,"name":"PT0","id":"PT1E","group":"other","current_ma":4.512,
     "status":"ok","pressure_psi":320.0,"units":"psi","cal_mode":"primary","cal_label":"Primary"},
    {"channel":0,"name":"LC0","id":"LC1","group":"other","v_per_v":0.000123,
     "lbf":42.5,"status":"ok","units":"lbf","cal_mode":"primary","cal_label":"Primary"},
    {"channel":0,"name":"TC0","id":"TC1","group":"thermocouple","temp_raw":72.3,
     "temp_f":72.3,"status":"ok","units":"degF"}
  ],
  "performance": {"avg_latency_ms":2.1,"max_latency_ms":11.4,"stale_reads":0,
                  "total_reads":48291,"stale_percentage":0.0,"sample_rate_hz":100.0,
                  "loop_index":48291,"task_restarts":0,"restart_counts":{}}
}
```

Notes for a reimplementation:

- `timestamp` is a float **Unix seconds** here (Node also tolerates absence and substitutes wall clock).
- **Channel indices are per-card and restart at 0.** A consumer distinguishes PT/LC/TC by which value key is present — `pressure_psi` / `lbf` (or `v_per_v`) / `temp_f` — *not* by index. This is the single easiest thing to get wrong.
- `source` is matched case-insensitively against `/Merged/i`. Per-device frames (`source` = `"PT Card (NI-9208)"` etc.) are supported by the server but disabled by default (`send_per_device = False`).
- If you send per-device frames instead, the server keeps last-known PT and LC frames and concatenates them into a synthetic merged frame — TC is not merged on that path.

### 2.7 Wire format: Node → browsers (WebSocket 3000)

Three outbound message types, all `{type, ..., timestamp: <ISO8601 string>}`:

**`welcome`** — sent on connect, then immediately the last merged frame as a `data` message if one exists.

**`data`** — real-time, one per merged frame (~10 Hz). The Python frame verbatim under `data`:

```json
{"type":"data","data":{ "...merged frame..." },"timestamp":"2026-08-24T13:45:47.500Z"}
```

**`batch`** — flushed every 100 ms, a compact columnar accumulation for plotting:

```json
{"type":"batch","data":{
   "ts_unix_us": 1756046742183000,
   "dt_us": 10000,
   "channels": ["PT0_psi","LC0_lbf","TC0_degF"],
   "data": {"PT0_psi":[320.1,320.3],"LC0_lbf":[42.5,42.6],"TC0_degF":[72.3,72.3]}
 },"timestamp":"..."}
```

Keys are `PT<n>_psi`, `LC<n>_lbf`, `TC<n>_degF`. `dt_us` is *estimated* from inter-frame arrival (clamped 1–50 ms), defaulting to 10000 — it is not authoritative timing.

**`heartbeat`** — every 30 s, carries the client count.

### 2.8 Control surface: browser → Node → Python

Node accepts JSON `{action: ...}` over the WebSocket. Critically, **Node does not have a channel back to Python.** The TCP link is push-only. Commands are therefore passed by **writing sentinel files** into the `ni_daq/` directory, which the Python loop polls once per iteration and unlinks after consuming.

| WS action | Extra fields | File Node writes | Effect |
|-----------|--------------|------------------|--------|
| `start_logging` | — | `start_logging.cmd` | Python opens CSV logs |
| `stop_logging` | — | `stop_logging.cmd` | Python closes CSV logs |
| `get_logging_status` | — | *(reads `logging_status.json`)* | replies with status |
| `tare_lc` | — | `tare_lc.cmd` | tare all load cells |
| `tare_pt` | — | `tare_pt.cmd` | tare all PTs |
| `tare_lc_channel` | `channel` (int) | `tare_lc_ch<N>.cmd` | tare one LC |
| `tare_pt_channel` | `channel` (int) | `tare_pt_ch<N>.cmd` | tare one PT |
| `get_tare_config` | — | *(reads `tare_config.json`)* | `{type:"tare_config",data:{...}}` |
| `set_lc_cal_mode` | `channel`, `use_alt` (bool) | `lc_cal_ch<N>.cmd` | switch to `slope_alt` |
| `get_lc_cal_status` | — | *(reads `lc_cal_status.json`)* | `{type:"lc_cal_status",data:{...}}` |
| `set_pt_cal_mode` | `channel`, `use_alt` (bool) | `pt_cal_ch<N>.cmd` | switch to `max_psi_alt` |
| `get_pt_cal_status` | — | *(reads `pt_cal_status.json`)* | `{type:"pt_cal_status",data:{...}}` |

Cal-mode file contents are `set_cal_mode:<channel>:<alt|primary>`. `shutdown_daq.cmd` (written by the stop scripts, not by Node) terminates the streamer.

Python writes back through JSON status files it refreshes as state changes: `logging_status.json`, `tare_config.json`, `lc_cal_status.json`, `pt_cal_status.json`.

**If you are reimplementing, do not copy the file-based command channel.** It exists only because the TCP hop is one-way. Collapse acquisition and fan-out into one process, or make the TCP link bidirectional, and issue commands in-band.

Node also serves HTTP on the same port 3000: static `ni_daq/public/`, plus `GET /interface_config.json`, `GET /api/config` (same file), and `GET /api/status` (`{clients, messages, uptime, lastMessage}`).

### 2.9 CSV logging (Python-side)

Written to `ni_daq/logs/<MMDD>/<HHMM>_{pt,lc,tc,raw}.csv`, one row **per hardware sample** (not per loop), with timestamps interpolated across the window from the sample rate. Collisions get a `_<n>` suffix.

- `_pt.csv`: `timestamp, elapsed_ms, wall_ms, loop_index, pt_ok, PT0_psi..PT15_psi, PT0_mA..PT15_mA`
- `_lc.csv`: `timestamp, elapsed_ms, wall_ms, loop_index, lc_ok, LC0_lbf..LC3_lbf, LC0_VperV..LC3_VperV, LC0_cal..LC3_cal`
- `_tc.csv`: `timestamp, elapsed_ms, wall_ms, loop_index, tc_ok, TC0_degF..TC3_degF`
- `_raw.csv`: `timestamp, device, channel, num_samples, values_json`

---

## 3. PANDA: link, framing, and signal conditioning

### 3.1 Link parameters

USB CDC serial. **460800 baud, 8N1**, read timeout 2 s. Port defaults to `COM5` — note the constant `FORCE_SERIAL_PORT = "COM5"` in [panda/main.py](panda/main.py) **overrides whatever port a client requests** in a `connect` action; the `--port` CLI argument is honoured only for the initial auto-connect. Auto-detect prefers ports matching `usbmodem|usbserial|ttyACM|ttyUSB`, else takes the first enumerated port.

### 3.2 Framing

Line-oriented ASCII, `\n`-terminated (`0x0A`). The reader accumulates raw bytes into a `bytearray` and splits on `0x0A`; lines are decoded ASCII with `errors='replace'` and stripped. Lines go onto a `queue.Queue` consumed by the asyncio broadcast task, so the serial read thread never blocks on network I/O.

If 16384 bytes accumulate with no newline, the buffer is dumped with a diagnostic that scores alternate byte interpretations (as-is, XOR 0xFF, high-bit strip/set, bit-reverse) by newline count — this catches RS-485 A/B polarity inversion and wrong-baud conditions. Worth replicating; it turns a silent hang into a one-line answer.

### 3.3 Dispatch order — a correctness requirement

**Classify by line prefix BEFORE testing for commas.** Status lines are colon-delimited, telemetry lines are comma-delimited, but *some status lines contain commas in their payload* — specifically `EVT:...:CFG_PUSH:...` whose detail is a comma-separated `k=v` list.

[panda/main.py](panda/main.py) gets this wrong. Its dispatcher is:

```python
for line in lines:
    if ',' not in line:            # <-- comma test comes FIRST
        if line.startswith("BB:"): ...
        if line.startswith(("EVT:", "BB_ERROR:", ...)): device_msgs.append(...)
        continue
    tokens = line.split(',')       # CFG_PUSH events land here
    ...
```

**Consequence:** any `EVT:` line containing a comma — which is every `CFG_PUSH` config confirmation — is never emitted as a `device_message`. It falls into the CSV branch, matches no known ID character, and is silently passed through inside the `content` field only. Config confirmations therefore never reach the terminal on this path.

[moe/server.py](moe/server.py) has the correct order (prefix checks first, comma test last). Replicate that:

```
function classify(line):
    if line.startswith("BB:")                      -> bb_heartbeat
    if line.startswith("EVT:")                     -> event
    if line.startswith("BB_ERROR:"|"CMD_ERROR:")   -> error
    if line.startswith("SEQ_"|"Arming!"|"Disarming!"
                       |"Panda Initialized!"|"Firing sequence!") -> ack
    if "," in line                                 -> telemetry (dispatch on line[0])
    otherwise                                      -> passthrough
```

### 3.4 PT conversion — the subtle part

Current PandaV2 "scuffed-bangbang" firmware emits **raw voltage across the PT shunt** (~0.7 V at idle), so `pt_input_mode = "volts"`.

```
mA   = (V / R_shunt[ch]) * 1000            # per-channel shunt, default 47 ohm
norm = clamp((mA - 4.0) / (20.0 - 4.0), 0, 1)
psi  = range_min + norm * (range_max - range_min) - pt_offsets[ch]
```

Two mechanisms derive `R_shunt`:

1. **Auto-shunt at startup** — averages the first 5 PT frames and solves `R = V_mean / 0.004` so ambient maps to 4 mA. Runs once, then disables itself.
2. **`tare_pts` action** — per channel, `R[ch] = |V[ch]| / 0.004`, then recomputes engineering values and stores them as `pt_offsets[ch]` so the display zeroes at ambient.

`pt_input_mode` also supports `"ma"` (pass through) and `"auto"` (≤2 V → volts, −2..30 → mA, else reject). Because the normalisation clamps to [0,1], **PSI can never read below `range_min` or above `range_max`** regardless of tare — worth knowing when a reading looks pinned.

`range_min`/`range_max` come from the per-channel metadata loaded from `sensor_config.xlsx` (`PT_Sensors` sheet), defaulting to `[0, 1000]`.

### 3.5 DC channel index mapping

The `s` line's positional order does **not** match logical channel IDs. The UI remaps with:

```js
const dcOrder = [7,6,5,4,3,2,1,0,11,10,9,8];   // wire position -> zero-based logical index
```

i.e. two groups (eight, then four), each reversed. Then `raw_index = logical + 1` is looked up in `panda/configs/dc_channels.json` to get the display ID. **This mapping is a hardware wiring artifact — verify it against your board before trusting it.** Note the bridge's own CSV logger does *not* apply this remap; it logs `s` values in wire order.

---

## 4. PANDA → ground control: complete data reference

Everything the board can emit, and everything the bridge forwards. Two layers: raw serial lines (§4.1) and the WebSocket frames the bridge wraps them in (§4.2).

### 4.1 Board → host: raw serial line types

Every line is ASCII, `\n`-terminated. Classification is by prefix, per §3.3.

#### 4.1.1 Summary table

| Prefix | Kind | Delimiter | Payload |
|--------|------|-----------|---------|
| `p` | PT telemetry | comma | 16 raw values (shunt volts on current firmware) |
| `P` | PT telemetry, pre-scaled PSI (legacy V1) | comma | **discarded by the host** |
| `l` | Load cells (legacy) | comma | 6 values |
| `t` | Combined LC + TC | comma | see §4.1.3 — implementations disagree on the split |
| `s` | Solenoid/DC currents | comma | up to 16 values, **Amps** |
| `BB:` | Bang-bang heartbeat | colon | see §5.2 |
| `EVT:` | Audit event | colon (detail may contain commas) | see §4.1.5 |
| `BB_ERROR:` | Bang-bang command rejected | free text | forwarded verbatim |
| `CMD_ERROR:` | General command rejected | free text | forwarded verbatim |
| `SEQ_*` | Sequence lifecycle ack | free text | forwarded verbatim |
| `Arming!` | Arm confirmation | — | sets host `armed = true` |
| `Disarming!` | Disarm confirmation | — | sets `armed = false`, clears BB state |
| `Panda Initialized!` | Boot banner | — | ack (MOE only) |
| `Firing sequence!` | Sequence start | — | ack (MOE only) |
| *(other)* | Unknown | — | passed through untouched |

#### 4.1.2 Numeric token parsing

Each comma-separated token is parsed by **stripping every character that is not a digit, `+`, `-`, or `.`**, then `float()`. An empty or sign-only result yields `0.0`. This means the leading ID letter is absorbed by the same routine, so `p6.500` and `6.500` both parse to `6.5`, and only the *first* token actually carries the ID letter in practice.

```python
def to_float(tok: str) -> float:
    s = ''.join(c for c in tok if c.isdigit() or c in '+-.')
    return float(s) if s not in ('', '+', '-') else 0.0
```

Note this strips embedded letters anywhere, not just a prefix, and does not validate that `.` or `-` appear at most once — malformed tokens raise and are caught as `0.0`.

> **CORRECTION — observed on hardware, 2026-08-27.** "Only the first token actually carries the ID letter" is **not true of this board's `s` lines**. Every token carries it:
>
> ```
> s0.00049,s0.00039,s0.00038,s0.00038,s0.00038,s0.00037,s0.00051,s0.00037,s0.00041,s0.00041,s0.00040,s0.00040
> ```
>
> The strip-everything-non-numeric rule absorbs it either way, which is exactly why that rule is worth keeping rather than replacing with a "slice off the first character" shortcut — the latter would turn `s0.00039` into `.00039` on eleven of twelve channels. Do not assume a leading-character strip is sufficient.
>
> Also worth recording from the same capture: **idle DC channels read ~0.4 mA, not 0.** That is sense-resistor leakage, it wanders continuously, and it is three orders of magnitude below a pulled-in coil (~600 mA). Any display of these values has to adapt its units or every idle channel renders as a frozen zero.

#### 4.1.3 Telemetry line detail

**`p` — pressure transducers.** 16 values. On current firmware these are **volts across the shunt**, not milliamps (§3.4). The host stores them as `_last_pt_raw`, derives `_last_pt_mA`, and rebuilds the line in engineering units before forwarding.

```
p0.712,0.698,0.705,0.700,0.694,0.703,0.711,0.699,0.702,0.697,0.708,0.701,0.696,0.705,0.700,0.703
```

**`P` — legacy V1 pre-scaled PSI.** Explicitly **dropped** by both implementations (`if id_char == 'P': continue`). The host recomputes PSI from the `p` stream so that raw / mA / psi stay mutually consistent. If your firmware emits only `P`, you must change this.

**`l` — load cells, legacy.** 6 values, mapped to LC channels 1–6.

**`t` — combined LC + TC.** **The two implementations disagree, and this is a real conflict:**

| Implementation | LC take | TC take |
|----------------|---------|---------|
| [panda/main.py](panda/main.py) (logging path) | first **8** | next **8** |
| [moe/server.py](moe/server.py) | first **6** | next **6** |
| [panda/moeui.html](panda/moeui.html) (display path) | first **6** | next **6** |

So within the *same* system, the CSV log and the on-screen display index TC differently — the log reads TC from offset 8, the UI from offset 6. At least one is wrong. **Determine the true split from firmware before replicating.** The README's channel inventory (6-ch LC, 6-ch TC) favours the 6/6 reading.

**`s` — solenoid / DC currents.** Up to 16 values in **Amps**. Boolean state is derived host-side, not sent by the board:

```
state[i] = current[i] >= dc_threshold      # dc_threshold default 0.100 A
```

Positional order needs the `dcOrder` remap in §3.5.

#### 4.1.4 `BB:` — bang-bang heartbeat

Full grammar and semantics in §5.2.

#### 4.1.5 `EVT:` — audit events

```
EVT:<ms>:<category>:<side>:<detail>
```

Split on `:` with **maxsplit=4**, so `<detail>` may itself contain colons and commas.

| Field | Meaning |
|-------|---------|
| `ms` | Firmware millisecond timestamp (board uptime, not wall clock) |
| `category` | Event class. `CFG_PUSH` is the only one parsed structurally |
| `side` | `l`, `f`, or empty for non-BB events |
| `detail` | Category-specific. For `CFG_PUSH`, a comma-separated `key=value` list |

Example:

```
EVT:184320:CFG_PUSH:l:sp=200.0,db=10.0,wait=500,maxOpen=0,ventTrig=250.0,ventAuto=1
```

MOE keeps a 200-entry ring buffer of parsed events and exposes it as `state.events`. `CFG_PUSH` details update the cached config (§5.5).

#### 4.1.6 Error and ack lines

`BB_ERROR:` and `CMD_ERROR:` are free-text rejections — forwarded verbatim, never parsed. They are the **only** negative acknowledgement in the protocol; a command that is silently ignored by firmware produces nothing at all.

`SEQ_*`, `Arming!`, `Disarming!`, `Panda Initialized!`, `Firing sequence!` are positive acks. `Arming!`/`Disarming!` mutate host arm state, and `Disarming!` additionally resets both BB sides to `OFF`/closed, mirroring the firmware's `forceSafe()`.

The browser client further sniffs any string containing `firing idx`, or `sequence` together with one of `ack|received|upload|packet|firing|saved|complete`, and treats it as a sequence acknowledgement for UI purposes. That is a heuristic on free text, not a protocol guarantee.

### 4.2 Host → client: WebSocket frame types (port 3941)

Bound `0.0.0.0:3941`. All frames are JSON objects. There is no envelope versioning; discriminate on `type`, then on `action`, then on presence of characteristic keys.

#### 4.2.1 `data` — the telemetry frame

Emitted once per processed serial line (so at the board's line rate, per line type).

```json
{
  "type": "data",
  "content": "p320.100000,318.400000,...",
  "raw":     "p0.712,0.698,...",
  "pt_mA":   [4.51, 4.49],
  "dc":      {"timestamp":"2026-08-24T13:45:47.500Z",
              "currents":[0.0,0.512],
              "states":[false,true]},
  "devices": {"rocket_panda":{"bb":{
      "l":{"enabled":true,"valve_open":false,"pressure":312.4,
           "state":"SUS","press":false,"vent":false},
      "f":{"enabled":false,"valve_open":false,"pressure":0.0,
           "state":"OFF","press":false,"vent":false}}}}
}
```

| Field | Presence | Meaning |
|-------|----------|---------|
| `type` | always | literal `"data"` |
| `content` | always | processed line. For `p` lines, PT rebuilt as `p%.6f` per channel in engineering units. For all other line types, **identical to `raw`** |
| `raw` | always | the original board line, unmodified |
| `pt_mA` | `p` lines only | 16 floats, the derived milliamp values |
| `dc` | `s` lines only | `{timestamp, currents[], states[]}`; `timestamp` is host ISO-8601 UTC with `Z` |
| `devices` | always | last-known bang-bang mirror for both sides — see §5.2 for field semantics |

`devices` is attached to **every** data frame regardless of line type, so a client can read BB state without waiting for a `BB:` line to arrive.

#### 4.2.2 `device_message` — status line passthrough

```json
{"type":"device_message",
 "message":"EVT:184320:BB_STATE:l:OFF->SUS",
 "timestamp":"2026-08-24T13:45:47.500Z"}
```

Emitted for `EVT:`, `BB_ERROR:`, `CMD_ERROR:`, `Arming!`, `Disarming!`, `SEQ_*`. Sent **after** the `data` frame for the same batch. Subject to the comma bug in §3.3 — `CFG_PUSH` events never appear here on the panda/main.py path.

#### 4.2.3 Command replies

Every `{action: ...}` request gets exactly one reply on the same socket. The general shape is `{"success": bool, "message": str}`, with these variants:

| Trigger | Reply shape |
|---------|-------------|
| `list_ports` | `{"ports": ["COM3","COM5"]}` |
| `connect` / `disconnect` / `send` / all `bb_*` writes | `{"success":bool,"message":str}` |
| `ping` | `{"success":true,"message":"pong"}` |
| `debug_serial` | `{"success":true,"debug_print_serial":bool,"throttle_sec":float}` |
| `start_logging` / `stop_logging` / `create_new_log` | `{"success":bool,"message":str,"filename":str,"rows":int?}` |
| `get_logging_status` | `{"active":bool,"filename":str\|null,"rows":int,"elapsed_sec":float}` |
| `tare_pts` | `{"success":bool,"message":str}` |
| `bb_get` | `{"success":true,"bb":{"lox":{...},"fuel":{...}}}` — see §5.5 |
| `preset_save` | `{"success":bool,"action":"preset_save",...}` |
| `preset_load` | `{"success":true,"action":"preset_load","presets":{...}}` |
| `save_pid_layout` | `{"success":bool,"action":"save_pid_layout"}` |
| `load_pid_layout` | `{"success":bool,"action":"load_pid_layout","layout":{...}}` |
| malformed JSON | `{"success":false,"message":"Invalid JSON"}` |

**Replies are not correlated to requests by any id.** There is no request/response tag; a client that pipelines commands must match replies by order or by the `action` echo where present. Only preset and layout replies echo `action`. This is a weakness worth fixing in a reimplementation — add a request id.

#### 4.2.4 Client lifecycle

No handshake, no authentication, no subscription model. A client that connects starts receiving `data` frames immediately and receives everything. Dead clients are detected on send failure, closed, and dropped from the list. There is no server-initiated ping; a half-open TCP connection is only noticed on the next send.

### 4.3 UDP multicast mirror

Every processed line is also sent to **239.255.0.1:5005**, TTL 1, `IP_MULTICAST_LOOP` enabled:

```json
{"type":"data","content":"p320.100000,318.400000,..."}
```

Only `type` and `content` — no `raw`, `pt_mA`, `dc`, or `devices`. Fire-and-forget, no retry, no ordering guarantee. Useful for passive listeners that must not perturb the primary path.

### 4.4 CSV logging

Auto-starts when the server comes up. `panda/logs/<MMDD>/<HHMM>.csv`, one row per processed serial line, flushed every 10 rows:

```
timestamp, elapsed_ms,
PT1_psi..PT16_psi, LC1_lbf..LC4_lbf, TC1_degF..TC16_degF, DC1_V..DC16_V
```

Column counts are fixed at 16/4/16/16 regardless of how many channels the board actually reports; missing entries are empty strings. Despite the `_V` suffix, DC values are **Amps**. Because a row is written per *line*, and each line type only updates its own columns, every row is a mix of fresh and carried-over values — the file is not a synchronised snapshot series.

A sibling `<HHMM>_commands.csv` (`timestamp, elapsed_ms, command`) records every command sent, flushed immediately — it is the flight record of operator actions. Bang-bang commands are logged here in their raw firmware form.

MOE's logger additionally emits per-side BB columns: `<device>.BB_<side>_state`, `_press`, `_vent`, `_psi`.

### 4.5 HTTP server

Static files from `panda/` on port **8090**, with automatic fallback to a free port if occupied. Serves `moeui.html`, `panda-daq-ui.html`, `sequencer.html`, `pid.html`.

---

## 5. Bang-bang control

### 5.1 Architecture and authority

The bang-bang pressure regulator **runs on the Teensy, not on the ground station.** Ground control's role is limited to:

1. pushing configuration (setpoint, deadband, timing, vent, mass-flow),
2. enabling or disabling the loop,
3. issuing manual vent and abort overrides,
4. displaying the state the board reports back.

This split is deliberate and safety-relevant: if the serial link, the bridge process, or the browser dies, the board keeps regulating with the last configuration it accepted. A ground station that runs the loop itself would drop the valve on a disconnect.

Two independent buses, each with its own PT, press solenoid, and vent solenoid:

| Bus | Command char | Heartbeat char | Default press DC | Default PT |
|-----|--------------|----------------|------------------|------------|
| LOX | `L` | `l` | DC1 | NI-DAQ ch 0 |
| Fuel | `F` | `f` | DC2 | NI-DAQ ch 1 |

Defaults from [public/configs/bb_config.json](public/configs/bb_config.json). Note the case convention throughout: **uppercase command letter = configure, lowercase = actuate**; and the heartbeat reports sides in lowercase regardless.

### 5.2 State machine and the `BB:` heartbeat

The board emits a heartbeat line per side. Grammar:

```
BB:<side>:<state>:<press01>:<vent01>:<pressure_psi>
```

```
BB:l:SUS:1:0:312.4
```

| Field | Type | Meaning |
|-------|------|---------|
| `side` | `l` \| `f` | LOX or Fuel. Lowercase |
| `state` | enum | `OFF` \| `SUS` \| `AV` \| `ABT` (see below) |
| `press01` | `0` \| `1` | Press solenoid currently actuated |
| `vent01` | `0` \| `1` | Vent solenoid currently actuated |
| `pressure_psi` | float | Latest PT reading the board is regulating on. **Optional** — parsers must tolerate a 5-field line |

Parsing tolerance differs: [panda/main.py](panda/main.py) requires `len(parts) >= 5` (i.e. `BB:l:SUS:1:0` is accepted, pressure defaults to last value); [moe/server.py](moe/server.py) requires `line.count(':') >= 4`. Both read `pressure` only `if len(parts) > 5`.

States, as documented in [moe/server.py](moe/server.py):

| State | Meaning |
|-------|---------|
| `OFF` | Loop inactive. Valves commanded closed |
| `SUS` | Sustain — the regulating state, cycling the press valve against the deadband |
| `AV` | Auto-vent — vent trigger exceeded, venting |
| `ABT` | Abort — latched safe state |

**`panda/main.py` does not validate the state string**; it stores whatever arrives. `moeui.html` derives `enabled = (state !== "OFF")`. So an unrecognised state reads as "enabled" downstream. Validate against the enum in a reimplementation.

The bridge mirrors the last heartbeat per side into `bb_runtime` and attaches it to every outgoing `data` frame as:

```json
"devices": {"rocket_panda": {"bb": {
  "l": {"enabled": true,        // derived: state != "OFF"
        "valve_open": false,    // alias of press
        "pressure": 312.4,
        "state": "SUS",
        "press": false,
        "vent": false}}}}
```

`enabled` and `valve_open` are **host-derived convenience fields**, not board data. `state`, `press`, `vent`, `pressure` are verbatim.

### 5.3 Configuration commands

All are ASCII, newline-terminated by the bridge, sent over the same serial link as telemetry. There is no acknowledgement in the command itself — confirmation arrives asynchronously as an `EVT:...:CFG_PUSH:...` line (§5.5) or a `BB_ERROR:` rejection.

Notation: `<side>` is `L` or `F` (uppercase for commands).

#### `B` — core regulator config

```
B<side><setpoint>,<deadband>,<wait_ms>,<max_open_ms>
```

```
BL200.0,10.0,500,0
```

| Parameter | Units | Meaning |
|-----------|-------|---------|
| `setpoint` | psi | Target pressure |
| `deadband` | psi | **Full band width, centred on setpoint.** The UI computes `hi = setpoint + deadband/2`, `lo = setpoint - deadband/2`. A deadband of 10 means ±5 psi |
| `wait_ms` | ms | Minimum dwell between valve state transitions — anti-chatter |
| `max_open_ms` | ms | Maximum continuous open time for the press valve. `0` = unlimited |

**Number formatting differs between the two implementations:**

| Implementation | Format |
|----------------|--------|
| [panda/main.py](panda/main.py) | `f"B{c}{sp:.1f},{db:.1f},{wait},{maxOpen}"` → `BL200.0,10.0,500,0` |
| [moe/server.py](moe/server.py) | `f"B{c}{int(sp)},{int(db)},{wait},{maxOpen}"` → `BL200,10,500,0` |

Both are presumably accepted by a firmware `atof`, but MOE's integer truncation **silently discards fractional setpoints**. Prefer the `.1f` form.

#### `V` — vent config

```
V<side><trigger_psi>,<auto_on01>
```

```
VL250.0,1
```

| Parameter | Meaning |
|-----------|---------|
| `trigger_psi` | Pressure at which auto-vent engages (drives the `AV` state) |
| `auto_on` | `1` enables automatic venting, `0` disables |

Same formatting split: main.py uses `:.1f`, MOE uses `int()`.

#### `M` — mass-flow / dynamic setpoint config

```
M<side><mdot>,<sp_min>,<sp_max>,<gain>,<rho>,<enable01>
```

```
ML0.850,150.000,400.000,0.02500,1141.000,1
```

| Parameter | Format | Meaning |
|-----------|--------|---------|
| `mdot` | `%.3f` | Target mass flow rate |
| `sp_min` | `%.3f` | Lower clamp on the computed setpoint |
| `sp_max` | `%.3f` | Upper clamp on the computed setpoint |
| `gain` | `%.5f` | Controller gain mapping flow error to setpoint adjustment |
| `rho` | `%.3f` | Propellant density |
| `enable` | `0`\|`1` | Engage mass-flow setpoint scheduling |

When enabled, the firmware computes the pressure setpoint from the mass-flow target rather than using the static `B` setpoint, clamped to `[sp_min, sp_max]`. The exact control law lives in firmware and is not visible from the host code — treat `gain` and `rho` as opaque pass-through parameters and tune against hardware.

Both implementations format `M` identically (`.3f`/`.5f`), so this command is consistent.

### 5.4 Actuation commands

Lowercase. These change state immediately; they do not persist configuration.

| Command | Form | Effect |
|---------|------|--------|
| Enable / disable sustain | `b<side><0\|1>` | `bL1` enters `SUS`; `bL0` returns to `OFF` and closes the press valve |
| Manual vent | `v<side><0\|1>` | `vL1` opens the vent solenoid, `vL0` closes it. Independent of `auto_on` |
| Abort | `x<side>` | `xL` — **latched** per-side abort. Enters `ABT` |

**Abort is latched.** Nothing in the host code clears it; recovery presumably requires a disarm/rearm or a power cycle. Confirm against firmware before relying on any clear path.

The global disarm `r` (§6.2) additionally triggers the firmware's `forceSafe()` across **both** sides — the host mirrors this by resetting both sides to `OFF`/closed on seeing `Disarming!`.

### 5.5 Config confirmation and the host cache

Two separate notions of "current config" exist, and they can diverge:

**Host optimistic cache (`bb_configs`).** Updated when a `bb_*` WebSocket action's serial write succeeds:

```python
result = await self.send_command(cmd)
if result.get("success"):
    self.bb_configs[bus]["setpoint"] = sp   # ... etc
```

`result["success"]` only means *the bytes left the host*. It says nothing about firmware acceptance. `bb_get` returns this cache:

```json
{"success":true,"bb":{
  "lox": {"setpoint":200.0,"deadband":10.0,"wait_ms":500,"max_open_ms":0,
          "vent_trigger":0.0,"vent_auto":false,
          "mdot_target":0.0,"sp_min":0.0,"sp_max":0.0,"gain":0.0,"rho":0.0,
          "enable":false},
  "fuel": { "..." }}}
```

**Firmware echo (`CFG_PUSH`).** The board confirms what it actually stored:

```
EVT:184320:CFG_PUSH:l:sp=200.0,db=10.0,wait=500,maxOpen=0,ventTrig=250.0,ventAuto=1
```

Recognised keys and their mapping:

| Key | Maps to | Type |
|-----|---------|------|
| `sp` | `setpoint` | float |
| `db` | `deadband` | float |
| `wait` | `wait_ms` | int |
| `maxOpen` | `max_open_ms` | int |
| `ventTrig` | `vent_trigger` | float | **see correction below** |
| `ventAuto` | `vent_auto` | `=='1'` | **see correction below** |
| `mdot` | `mdot_target` | float |
| `spMin` | `sp_min` | float |
| `spMax` | `sp_max` | float |
| `gain` | `mdot_gain` | float |
| `mdotOn` | `mdot_on` | `=='1'` |

Unknown keys are ignored. **`rho` is sent in the `M` command but has no `CFG_PUSH` key in the parser** — either firmware does not echo it or the host parser is incomplete. It cannot currently be verified from the ground station.

> **CORRECTION — observed on hardware, 2026-08-27.** The table above was written from the reference implementations and is wrong about the vent keys, and about the shape of the echo. On the PandaV2 board on this stand:
>
> - **The vent keys are `avTrig` and `avAuto`**, not `ventTrig`/`ventAuto`. "av" for auto-vent, matching the `AV` state name.
> - **The echo is emitted PER COMMAND, not as a full config dump.** A `B` followed by a `V` produces two separate `CFG_PUSH` lines, each carrying only its own command's fields:
>
>   ```
>   EVT:...:CFG_PUSH:f:sp=50.0,db=2.0,wait=250,maxOpen=500
>   EVT:...:CFG_PUSH:f:avTrig=650.0,avAuto=0
>   ```
>
>   So no single line is the board's full configuration. **A client must accumulate echoes** rather than treating the latest one as complete, and must not conclude a field is unset because the most recent echo omitted it.
>
> The four core keys (`sp`, `db`, `wait`, `maxOpen`) are confirmed correct as documented. **Every `mdot*` key remains unverified** — GC-4 does not send the `M` command, so no echo for it has ever been observed. Expect those spellings to be wrong in the same way, and watch for an "unrecognised key" warning the first time one is pushed.

Only MOE consumes `CFG_PUSH`. The panda/main.py path cannot — the comma bug in §3.3 prevents these lines from ever being classified as events. **Treat the firmware echo as authoritative and the host cache as a display convenience.**

### 5.6 Recommended command sequence

```
1. BL200.0,10.0,500,0        push core config
2. VL250.0,1                 push vent config       (optional)
3. ML0.850,150.0,400.0,0.025,1141.0,1   push mdot config (optional)
   -> wait for EVT:...:CFG_PUSH:l:...  and verify the echoed values
   -> a BB_ERROR: instead means rejected; do not proceed
4. bL1                       enable sustain
   -> confirm via BB:l:SUS:... heartbeat
...
5. bL0                       disable when done
```

Do not enable before the echo confirms config. Enabling with stale or partially-applied configuration regulates to the wrong setpoint.

### 5.7 The duplicate client-side loop — hazard

[panda/moeui.html](panda/moeui.html) contains a **second, independent bang-bang loop running in the browser** (`bbTick`, 50 ms interval), started whenever either bus is enabled in the UI. Despite the source comment claiming it is "only for PT display updates (not control)", it actually actuates:

```js
if (pressure > hi && !st.valveOpen) {
    st.valveOpen = true;  st.lastSwitch = now;  controlDC(dcId, 1);   // opens valve
} else if (pressure < lo && st.valveOpen) {
    st.valveOpen = false; st.lastSwitch = now;  controlDC(dcId, 0);   // closes valve
}
```

`controlDC` sends a raw `S<ch><state>` solenoid command over the same link. Three problems:

1. **Two controllers drive the same valve.** The firmware loop and this browser loop both command the press solenoid, with no arbitration.
2. **It reads a different sensor.** `pressure` comes from `nidaqPT[...]` — the **NI-DAQ** PT over the separate `:3000` socket — while the firmware regulates on the board's own PT. The two loops can see different pressures.
3. **The polarity is inverted relative to pressurisation.** It opens the valve when `pressure > hi` and closes when `pressure < lo`. That is vent logic. A press-valve regulator opens when pressure falls *below* `lo`. Either `valve.dc_id` is wired to a vent, or this loop is backwards.

**Do not port this loop.** Ground control should push config and enable, then observe. If you need a host-side fallback regulator, it needs explicit arbitration with the firmware loop and a single agreed pressure source.

### 5.8 Replication pseudocode

Minimal correct client, transport-agnostic:

```
# --- outbound ---
def bb_push_config(side, sp, db, wait_ms, max_open_ms):
    send(f"B{side}{sp:.1f},{db:.1f},{int(wait_ms)},{int(max_open_ms)}\n")

def bb_push_vent(side, trigger_psi, auto_on):
    send(f"V{side}{trigger_psi:.1f},{1 if auto_on else 0}\n")

def bb_push_mdot(side, mdot, sp_min, sp_max, gain, rho, enable):
    send(f"M{side}{mdot:.3f},{sp_min:.3f},{sp_max:.3f},"
         f"{gain:.5f},{rho:.3f},{1 if enable else 0}\n")

def bb_enable(side, on):  send(f"b{side}{1 if on else 0}\n")
def bb_vent(side, open_): send(f"v{side}{1 if open_ else 0}\n")
def bb_abort(side):       send(f"x{side}\n")
# side is 'L' or 'F'

# --- inbound ---
def on_line(line):
    if line.startswith("BB:"):
        p = line.split(":")
        if len(p) >= 5:
            side = p[1].lower()                    # 'l' | 'f'
            state[side].mode  = p[2]               # OFF|SUS|AV|ABT
            state[side].press = (p[3] == "1")
            state[side].vent  = (p[4] == "1")
            if len(p) > 5: state[side].pressure = float(p[5])
        return

    if line.startswith("EVT:"):
        _, ms, category, side, detail = line.split(":", 4)
        if category == "CFG_PUSH":
            for kv in detail.split(","):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    confirmed[side.lower()][k.strip()] = v.strip()
        log_event(ms, category, side, detail)
        return

    if line.startswith(("BB_ERROR:", "CMD_ERROR:")):
        on_command_rejected(line); return

    if line.startswith(("SEQ_", "Arming!", "Disarming!",
                        "Panda Initialized!", "Firing sequence!")):
        if line == "Arming!":    armed = True
        if line == "Disarming!": armed = False; force_safe_all_sides()
        on_ack(line); return

    if "," in line:
        on_telemetry(line)                          # dispatch on line[0]
        return

    on_unknown(line)
```

Invariants to hold: prefix checks precede the comma test; the heartbeat is the only authority on actual valve state; `BB_ERROR:` is the only rejection signal, so a command that produces neither an echo nor an error within a timeout should be treated as lost.

---

## 6. Ground control → PANDA: command reference

### 6.1 WebSocket actions (client → bridge, port 3941)

All requests are `{"action": "..."}` plus fields.

**Connection / plumbing**

| Action | Fields | Notes |
|--------|--------|-------|
| `list_ports` | — | → `{"ports":[...]}` |
| `connect` | `port` | Ignores `port`, always opens `FORCE_SERIAL_PORT` |
| `disconnect` | — | |
| `ping` | — | → `"pong"` |
| `debug_serial` | `enable`, `throttle_sec` | Toggle raw-line console echo |

**Raw passthrough**

| Action | Fields |
|--------|--------|
| `send` | `command` — written verbatim to serial with a trailing `\n`, and logged to the command CSV |

**Logging:** `start_logging`, `stop_logging`, `create_new_log` (stop+start), `get_logging_status`.

**Calibration:** `tare_pts` — per-channel shunt recalibration and PSI zeroing (§3.4).

**Bang-bang** — full semantics in §5:

| Action | Fields | Firmware command emitted |
|--------|--------|--------------------------|
| `bb_config` | `bus` (`lox`\|`fuel`), `setpoint`, `deadband`, `wait_ms`, `max_open_ms` | `B<L\|F><sp:.1f>,<db:.1f>,<wait>,<maxOpen>` |
| `bb_vent_config` | `bus`, `trigger`, `auto_on` | `V<L\|F><trig:.1f>,<0\|1>` |
| `bb_mdot_config` | `bus`, `mdot`, `sp_min`, `sp_max`, `gain`, `rho`, `enable` | `M<L\|F><mdot:.3f>,<spMin:.3f>,<spMax:.3f>,<gain:.5f>,<rho:.3f>,<0\|1>` |
| `bb_enable` | `bus`, `enable` | `b<L\|F><0\|1>` |
| `bb_vent` | `bus`, `open` | `v<L\|F><0\|1>` |
| `bb_abort` | `bus` | `x<L\|F>` |
| `bb_get` | — | *(none — returns host cache)* |

`bus` must be exactly `"lox"` or `"fuel"`; anything else returns `{"success":false,"message":"Invalid bus"}` without touching the serial link.

**Presets and layout:** `preset_save` (`name`, `sequence`), `preset_load`, `save_pid_layout` (`layout`), `load_pid_layout`.

### 6.2 Firmware command strings (sent via `send`)

Raw ASCII the board understands. Each is newline-terminated by the bridge.

| Command | Meaning |
|---------|---------|
| `S<ch><state>` | Set solenoid. `<ch>` is hex-ish: `1`–`9` then `A`,`B`,`C` for 10–12. `<state>` is `0`/`1`. e.g. `SA1` = channel 10 on |
| `a` | Arm → board replies `Arming!` |
| `r` | Disarm / emergency stop / abort → replies `Disarming!`, runs `forceSafe()` on both BB sides |
| `B1<0\|1>`, `B2<0\|1>` | Legacy bang-bang enable (fuel / lox) used by the older UI. **Collides in prefix with the modern `B<L\|F>...` config command** — disambiguated only by the second character being a digit rather than `L`/`F`. Avoid in new code |
| `s<chHex><state>.<delay5>` | Sequence step: act, then wait. Delay is **5 zero-padded digits of milliseconds**, max `99999`. Steps concatenate: `s11.00500s10.01000` |

The sequencer UI builds a `command:`-prefixed string for display and strips the prefix before sending.

---

## 7. Shared configuration

`sensor_config.xlsx` at the repo root is the master. Sheets: `PT_Sensors`, `LC_LoadCells`, `TC_Sensors`, `DC_Channels`, with a `system` column of `ni_daq` or `panda`.

[generate_configs.py](generate_configs.py) derives the runtime JSON from it. **PANDA regenerates its configs from the workbook on every launch** (`subprocess` call to `generate_configs.py --target panda`, 30 s timeout, non-fatal on failure). NI-DAQ does not — it reads `interface_config.json` and the workbook directly at device-init time.

Generated artifacts:

- `ni_daq/interface_config.json` — PT sensors with `{channel, name, id, group, calibration:{max_psi, zero_ma, units, max_psi_alt?}, serial?}`; also `lc_channels.json`, `tc_channels.json`
- `panda/configs/{pt,lc,tc,dc}_channels.json` — arrays of `{<type>: {id, raw_index, name, short_name, units, range:[min,max], calibration?, type?, bb?}}`

`raw_index` is the position in the serial line; `id` is the logical/display channel. Keep them distinct.

**Bang-bang bus definition** lives separately in [public/configs/bb_config.json](public/configs/bb_config.json), keyed by bus:

```json
{"buses": {"lox": {
  "label":"LOX Bus", "device":"rocket_panda",
  "setpoint_psi":200.0, "deadband_psi":10.0, "wait_ms":500, "max_open_ms":0,
  "vent_trigger_psi":0, "vent_auto":false,
  "mdot_target":0, "mdot_sp_min":0, "mdot_sp_max":0, "mdot_gain":0, "mdot_enable":false,
  "pt_channel":0, "press_dc":1, "vent_dc":0,
  "pt_sensors":[{"ni_daq_channel":0,"label":"LOX Tank PT"},
                {"ni_daq_channel":1,"label":"LOX Feed PT"}],
  "valve":{"dc_id":1,"label":"S1 LOX Press (DC1)"}}}}
```

Note `pt_channel` (the board's own PT index, used by firmware) and `pt_sensors[].ni_daq_channel` (NI-DAQ channels, used only for the browser display and the client-side loop in §5.7) are **different sensors on different hardware**. Do not conflate them.

---

## 8. Porting checklist

**Minimum viable NI-DAQ ingest** — if you only need data, skip the two-process split: open the three DAQmx tasks with the exact channel/timing configuration in §2.2, run the TC card on its own thread, pace a loop at 10 Hz reading 10 samples, apply §2.5 conversions. The TCP/WebSocket layers are transport, not substance.

**Minimum viable PANDA ingest** — open serial at 460800, split on `\n`, classify by prefix *before* testing for commas (§3.3), apply the volts→mA→psi chain in §3.4. To command: write ASCII strings from §5.3/§5.4/§6.2 with a trailing newline.

Things that will bite you:

1. **NI-9237 `HIGH_RESOLUTION`.** Omit it and you get `-200279` overruns forever.
2. **NI-9211 has no sample clock.** Never call `cfg_samp_clk_timing` on it; read it on-demand from a separate thread.
3. **Never share a sample clock** between the 9237 and the 9208.
4. **NI-DAQ channel indices restart at 0 per card.** Discriminate by value key, not index.
5. **PANDA `p` lines are volts, not mA,** on current firmware. Getting this wrong silently yields plausible-looking garbage.
6. **Classify serial lines by prefix before testing for commas** — otherwise `CFG_PUSH` events are lost (§3.3).
7. **The `t` line split is disputed** — 8/8 in the logger, 6/6 in the UI and MOE (§4.1.3). Resolve against firmware.
8. **Deadband is full width, not half.** `hi = sp + db/2`, `lo = sp - db/2`.
9. **`FORCE_SERIAL_PORT` overrides the requested port** in `connect`. Remove that constant in a port.
10. **`dcOrder` remapping is a wiring artifact** applied by the UI but not the logger. Re-verify per board.
11. **PANDA PSI is clamped** to the channel range by the 0–1 normalisation — a pinned reading may be clamping, not saturation.
12. **`success: true` on a `bb_*` action only means the bytes were written.** Wait for `CFG_PUSH` before enabling.
13. **Do not port the browser-side bang-bang loop** (§5.7) — it double-drives the valve from a different sensor with inverted polarity.
14. **NI-DAQ frames are dropped, not queued,** when the socket backs up. Do not assume a contiguous frame series.
15. **`dt_us` in `batch` messages is estimated** from arrival times. Use `_raw.csv` or the per-sample CSVs for real timing.
16. **WebSocket replies carry no request id.** Add correlation if you pipeline commands.

### Known defects in this repo

Recorded so a reimplementation does not inherit them:

- **`EVT:` lines containing commas are misrouted** in [panda/main.py](panda/main.py) (§3.3). Every `CFG_PUSH` confirmation is affected — config echoes never reach clients as `device_message` frames on that path.
- **The `t` line LC/TC split is inconsistent** between the logging path (8/8) and the display path (6/6) within the same system (§4.1.3). At minimum one of them mislabels channels.
- **The browser bang-bang loop actuates while documented as display-only**, using a different pressure source than the firmware loop and with apparently inverted polarity (§5.7).
- **`moe/server.py`'s `NIDAQConnection` cannot work as written.** It connects *as a TCP client* to port 5001 and parses a `{"pt":{...},"lc":{...}}` dict. But 5001 is where `daq_streamer.py` **pushes** (it is the client; Node is the server), and the streamer never emits that shape. Do not use it as a protocol reference — §2.6 and §2.7 are authoritative for NI-DAQ.
- **`rho` has no `CFG_PUSH` echo key** (§5.5), so the mass-flow density parameter cannot be verified from the ground station.
- **`B1`/`B2` legacy enable collides in prefix with `BL`/`BF` config** (§6.2).
