/**
 * panda.js — link to the custom "PANDA" Teensy board.
 *
 * The PANDA owns actuation: solenoids, main valves, igniter. It also reports
 * its own instrumentation (PT shunt voltages, load cells, thermocouples, and
 * per-solenoid current draw), which is useful for confirming that a coil
 * actually energized even when the NI-DAQ is the authority on process values.
 *
 * LINK
 *   USB CDC serial, 460800 8N1, line-oriented ASCII, '\n' terminated.
 *
 * INBOUND (board -> host), dispatched on the FIRST CHARACTER of the line:
 *   p<v>,<v>,...   PT raw. On current firmware these are the VOLTAGE across
 *                  each shunt (~0.7 V at idle), NOT milliamps. Getting this
 *                  wrong yields plausible-looking garbage rather than an
 *                  obvious failure, so `ptInputMode` is explicit.
 *   P...           Legacy pre-scaled PSI. Ignored: we recompute from `p` so
 *                  raw/mA/psi can never disagree.
 *   l<v>,...       Load cells (legacy layout).
 *   t<v>,...       Combined: first 8 load cells, next 8 thermocouples.
 *   s<v>,...       Per-channel solenoid current in AMPS. A channel counts as
 *                  energized at >= `dcThresholdA`.
 *
 * Status lines are classified by PREFIX, before any comma test — see
 * bb-protocol.js for why that ordering is a correctness requirement:
 *   BB:<side>:<state>:<press01>:<vent01>:<psi>   bang-bang heartbeat
 *   LINK:<armed01>:<lost01>:<silentMs>          GC-link watchdog status, 1 Hz
 *   EVT:... BB_ERROR:... CMD_ERROR:... Arming! Disarming! SEQ_...
 *
 * OUTBOUND (host -> board):
 *   S<ch><0|1>   set solenoid; <ch> is 1-9 then A,B,C for 10-12
 *   a            arm
 *   r            disarm / abort
 *   h            liveness heartbeat, 5 Hz   (see NOTE ON COMMS LOSS)
 *   B/V/M        bang-bang configuration   (see bb-protocol.js)
 *   b/v/x        bang-bang actuation
 *
 * NOTE ON ARM: the board has its own arm latch, independent of GC-4's
 * software interlocks. `armHardware` keeps them in step so a disarmed stand
 * cannot actuate even if a command escapes the server's checks.
 *
 * NOTE ON COMMS LOSS: the board only ever hears from GC when the operator acts,
 * so silence is not evidence of a dead link — during a hold it is the normal
 * case. It therefore watches for the `h` heartbeat: 600 ms of silence forces
 * both bang-bang controllers safe, 10 s disarms the stand outright. We beat
 * unconditionally, and stop the instant we stop HEARING the board — see
 * sendGcHeartbeat() for why that second rule is the important one.
 *
 * NOTE ON BANG-BANG: the board runs the regulator itself, on its own PT
 * channels. This driver pushes configuration and enable/disable, and mirrors
 * what the board reports back — it never closes the loop. Two controllers on
 * one solenoid with no arbitration is the failure mode HANDOVER_COMMS.md §5.7
 * documents in the previous ground station, and it is worth not repeating.
 */
import {
  parseLine,
  encodeConfig,
  encodeVent,
  encodeMdot,
  encodeEnable,
  encodeManualVent,
  encodeAbort,
  commandSide,
} from './bb-protocol.js';

const DEFAULT_BAUD = 460800;
const MAX_LINE_BYTES = 16384;

/** A side is stale if no heartbeat has arrived in this long. */
const HEARTBEAT_TIMEOUT_MS = 2000;

/** No line at all from the board for this long means the link is down. */
const RX_STALE_MS = 2000;

/**
 * How often we prove to the board that GC is still here.
 *
 * The board cannot tell a quiet hold from a severed cable — GC only talks to it
 * when the operator acts — so it runs a watchdog on this heartbeat: 600 ms of
 * silence forces its bang-bang controllers safe, 10 s disarms the stand. 5 Hz
 * gives three missed beats before the first stage trips.
 */
const GC_HEARTBEAT_MS = 200;

/** How long a talking board may go without a LINK: line before we call it. */
const NO_WATCHDOG_GRACE_MS = 10000;

/** Change on an `s` position that counts as movement, for the DC trace. */
const DC_TRACE_DELTA_A = 0.05;

export class PandaDriver {
  constructor(options = {}) {
    this.name = 'panda';
    this.portPath = options.port || options.portName || null;
    this.baud = Number(options.baud || DEFAULT_BAUD);
    this.ptInputMode = options.ptInputMode || 'volts';
    this.shuntOhms = options.shuntOhms || {};
    this.defaultShuntOhms = Number(options.defaultShuntOhms || 47);
    this.dcThresholdA = Number(options.dcThresholdA ?? 0.1);
    // Wire-position trace for the `s` line. Off unless asked for: it prints
    // twelve lines a second and is a bring-up tool, not telemetry.
    this.debugDc = options.debugDc ?? process.env.GC_DEBUG_DC === '1';
    // How many leading fields of a `t` line are load cells; the remainder are
    // thermocouples. Observed firmware: 12 fields = 8 LC + 4 TC.
    this.tLcCount = Number(options.tLcCount ?? 8);
    this.channelMap = options.channelMap || {};
    this.armHardware = options.armHardware !== false;

    // DC current sense. `dcOrder` maps wire position -> logical index; it is a
    // hardware wiring artifact, so a board that reports in logical order sets
    // it to null. `dcChannels` labels each logical channel and optionally ties
    // it to the valve it senses.
    this.dcOrder = Array.isArray(options.dcOrder) ? options.dcOrder : null;
    this.dcChannels = options.dcChannels || {};
    this.dcByValve = new Map();
    for (const [index, meta] of Object.entries(this.dcChannels)) {
      // `sensed: false` marks a position with no working current sense — an
      // unpopulated input, or one that sits at a fixed offset. Those report a
      // plausible-looking number that is not a measurement, and above the
      // threshold they read as a valve that is energized when it is not.
      //
      // Excluded here rather than filtered later, so the valve shows NO
      // current row at all. "We cannot measure this coil" is the honest
      // display; a number nobody should trust is worse than a blank, because
      // it is indistinguishable from one that matters.
      if (meta.valve && meta.sensed !== false) this.dcByValve.set(meta.valve, Number(index));
    }

    this.buffer = Buffer.alloc(0);
    this.raw = new Map();        // "<kind><index>" -> engineering value
    this.dc = { currents: [], states: [] };
    this.lastRxAt = 0;
    this.connected = false;
    this.rxCount = 0;
    this.port = null;
    this.onEvent = options.onEvent || (() => {});
    // Raw serial tap: (direction, bytes) for every framed line in and every
    // command out. Null unless --panda-tap asked for it.
    this.onRaw = options.onRaw || null;

    // Bang-bang mirror, per side. Everything here is what the BOARD said, not
    // what we asked for; `confirmed` is the CFG_PUSH echo, which §5.5 calls
    // the authority on what the board actually stored.
    this.bb = { l: freshBbSide(), f: freshBbSide() };
    // Whether this board echoes config at all. Until we have seen one
    // CFG_PUSH we cannot tell "the echo has not arrived yet" from "this
    // firmware never echoes", and the enable handshake needs to know.
    this.bbEchoes = false;
    this.onBbError = options.onBbError || null;

    // The board's GC-link watchdog, mirrored from its LINK: line. `armed`
    // starts false and only the board can set it: a watchdog we have not heard
    // from is an unprotected one, and this field decides whether we warn.
    this.link = { armed: false, lost: false, silentMs: 0, seen: false };
    this.warnedUnarmed = false;
    this.warnedNoWatchdog = false;
    this.firstRxAt = 0;
  }

  async init(config) {
    this.config = config;
    this.checkDcWiring(config);

    let SerialPort;
    try {
      ({ SerialPort } = await import('serialport'));
    } catch {
      throw new Error(
        'The panda driver needs the "serialport" package.\n' +
        '  Run:  npm install serialport'
      );
    }

    const path = this.portPath || (await autodetectPort(SerialPort));
    if (!path) throw new Error('No serial port found for the PANDA board');
    this.portPath = path;
    this.detail = `${path} @ ${this.baud}`;

    this.port = new SerialPort({ path, baudRate: this.baud, autoOpen: false });
    await new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });

    this.port.on('data', (chunk) => this.onData(chunk));
    this.port.on('error', (err) => {
      console.error('[panda] error:', err.message);
      this.connected = false;
    });
    this.port.on('close', () => { this.connected = false; });

    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastRxAt > RX_STALE_MS) this.connected = false;
      this.checkWatchdogPresence();
    }, 500);
    this.watchdog.unref?.();

    this.gcHeartbeat = setInterval(() => this.sendGcHeartbeat(), GC_HEARTBEAT_MS);
    this.gcHeartbeat.unref?.();

    return this;
  }

  // ------------------------------------------------------------- inbound ----

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    let nl;
    while ((nl = this.buffer.indexOf(0x0a)) !== -1) {
      const frame = this.buffer.subarray(0, nl);
      // Tapped BEFORE the trim, and as bytes. A raw view whose whole purpose
      // is showing what the board actually sent must not first tidy away the
      // trailing \r, the stray high bit, or the empty line — those are exactly
      // what someone turns this on to look at.
      this.onRaw?.('rx', Buffer.from(frame));
      const line = frame.toString('ascii').trim();
      this.buffer = this.buffer.subarray(nl + 1);
      if (line) this.onLine(line);
    }

    // A buffer this large with no newline means the framing is wrong, not that
    // the board is chatty. Diagnose it rather than growing without bound.
    if (this.buffer.length > MAX_LINE_BYTES) {
      console.error(`[panda] ${this.buffer.length} bytes with no newline — ${diagnoseFraming(this.buffer)}`);
      this.buffer = Buffer.alloc(0);
    }
  }

  onLine(line) {
    this.lastRxAt = Date.now();
    if (!this.firstRxAt) this.firstRxAt = this.lastRxAt;
    this.connected = true;
    this.rxCount++;

    // Prefix first, comma last. A board reporting a single channel sends
    // "p0.188" with no comma at all, and a CFG_PUSH event carries commas in
    // its payload — so neither the comma nor the leading letter can be the
    // first question asked. bb-protocol.js owns that ordering.
    const msg = parseLine(line);

    switch (msg.kind) {
      case 'heartbeat': return this.onHeartbeat(msg);
      case 'link':      return this.onLink(msg);
      case 'event':     return this.onBoardEvent(msg);
      case 'error':     return this.onBoardError(msg);
      case 'ack':       return this.onAck(msg);
      case 'telemetry': break;
      default:          return this.onEvent(msg.line, 'info');
    }

    const id = msg.id;
    if (!'pPlts'.includes(id)) return this.onEvent(line, 'info');

    const values = parseNumbers(line);

    switch (id) {
      case 'p':
        values.forEach((v, i) => this.raw.set(`pt${i}`, this.toPsi(i, v)));
        break;
      case 'P':
        break;                     // legacy pre-scaled PSI; recomputed from `p`
      case 'l':
        values.forEach((v, i) => this.raw.set(`lc${i}`, v));
        break;
      case 't':
        // Combined frame: `tLcCount` load cells, then the rest thermocouples.
        // Observed firmware sends 12 fields (8 LC + 4 TC), not the 8+8 the
        // old docs describe, so the TC count is taken from the line length
        // rather than assumed.
        values.slice(0, this.tLcCount).forEach((v, i) => this.raw.set(`lc${i}`, v));
        values.slice(this.tLcCount).forEach((v, i) => this.raw.set(`tc${i}`, v));
        break;
      case 's': {
        const currents = this.remapDc(values);
        this.dc = {
          currents,
          states: currents.map((a) => a >= this.dcThresholdA),
        };
        currents.forEach((v, i) => this.raw.set(`dc${i}`, v));
        if (this.debugDc) this.traceDc(line, values);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Prove to the board's link watchdog that GC is still here.
   *
   * TWO RULES, BOTH LOAD-BEARING.
   *
   * 1. Beat unconditionally. Never gate this on ARM state, on whether a
   *    regulator is running, or on operator activity — the whole point is that
   *    a quiet hold looks exactly like a severed cable from the board's side.
   *
   * 2. STOP beating the moment we stop HEARING the board, even though the port
   *    is still writable. A one-way failure — our RX dead, TX fine — would
   *    otherwise keep the watchdog satisfied on a stand we can no longer see,
   *    which is worse than no heartbeat at all: it actively suppresses the one
   *    mechanism still in a position to make the stand safe. Going quiet hands
   *    the board back to its own watchdog.
   *
   * The `rxCount` guard is what lets the first beats go out before the board
   * has said anything. Without it `lastRxAt = 0` reads as infinitely stale and
   * we would never send the `h` that arms the watchdog in the first place.
   */
  sendGcHeartbeat() {
    if (!this.port?.writable) return;

    if (this.rxCount > 0 && Date.now() - this.lastRxAt > RX_STALE_MS) {
      if (!this.rxLostWarned) {
        this.rxLostWarned = true;
        this.onEvent(
          'PANDA telemetry stopped — heartbeat withheld so the board can safe the stand itself',
          'error',
        );
      }
      return;
    }
    this.rxLostWarned = false;
    this.send('h');
  }

  /**
   * A board that is talking happily but has never sent a LINK: line is running
   * firmware from before the comms watchdog existed. That is the same exposure
   * as `armed: 0` — nothing on the board is guarding against a dead link — but
   * it is silent, because the absence of a line cannot raise its own alarm.
   * The board will not self-safe on comms loss until it is reflashed.
   */
  checkWatchdogPresence() {
    if (this.warnedNoWatchdog || this.link.seen || !this.connected) return;
    if (!this.firstRxAt || Date.now() - this.firstRxAt < NO_WATCHDOG_GRACE_MS) return;
    this.warnedNoWatchdog = true;
    this.onEvent(
      'PANDA firmware has no comms watchdog (no LINK: line in ' +
      `${Math.round(NO_WATCHDOG_GRACE_MS / 1000)}s) — the board will NOT safe itself if this link drops. Reflash to enable it.`,
      'error',
    );
  }

  /**
   * `LINK:` — the board reporting on its own GC-link watchdog.
   *
   * `armed: false` is the line that matters. The watchdog is heartbeat-GATED:
   * dormant until it sees its first `h`, so that firmware flashed ahead of a
   * heartbeat-capable ground station cannot nuisance-disarm. The cost is that
   * an unarmed watchdog is indistinguishable from the old, unprotected
   * firmware — so it is reported as an ERROR, not a note.
   *
   * The warning waits for a few seconds of frames rather than firing on the
   * first LINK line, because at startup `armed: 0` simply means our first
   * heartbeat has not been processed yet.
   */
  onLink(msg) {
    const wasLost = this.link.lost;
    const wasArmed = this.link.armed;
    this.link = { armed: msg.armed, lost: msg.lost, silentMs: msg.silentMs, seen: true };

    if (!msg.armed && !this.warnedUnarmed && this.rxCount > 100) {
      this.warnedUnarmed = true;
      this.onEvent(
        'PANDA link watchdog is NOT ARMED — the board is not guarding against comms loss',
        'error',
      );
    }
    if (msg.armed && !wasArmed) {
      this.warnedUnarmed = false;
      this.onEvent('PANDA link watchdog armed', 'info');
    }
    if (msg.lost && !wasLost) {
      this.onEvent('PANDA reports GC link loss — bang-bang forced safe on the board', 'error');
    }
  }

  /**
   * `BB:` — the board narrating what its regulator is actually doing.
   *
   * This is the only authority on valve state and on the pressure the loop is
   * regulating against. The pressure field is optional, so an absent one
   * keeps the last reading rather than zeroing it: a 5-field heartbeat means
   * "no new number", not "0 psi".
   */
  onHeartbeat(msg) {
    const side = this.bb[msg.side];
    if (!side) return;

    if (!msg.stateValid && msg.state !== side.state) {
      // Reported, not adopted. A client that derives "enabled" from
      // `state != OFF` reads an unrecognised state as ENABLED, so a garbled
      // field must not quietly become a running controller.
      this.onEvent(`PANDA bang-bang side ${msg.side}: unrecognised state "${msg.state}"`, 'error');
    }

    side.state = msg.state;
    side.stateValid = msg.stateValid;
    side.press = msg.press;
    side.vent = msg.vent;
    if (msg.pressure !== undefined) side.pressure = msg.pressure;
    side.lastBeatAt = Date.now();
  }

  /** `EVT:` — audit events. `CFG_PUSH` is the one we read structurally. */
  onBoardEvent(msg) {
    if (msg.category === 'CFG_PUSH' && msg.side) {
      const side = this.bb[msg.side];
      if (side) {
        this.bbEchoes = true;
        Object.assign(side.confirmed, msg.config.fields);
        side.confirmedAt = Date.now();
        const unknown = Object.keys(msg.config.unknown);
        if (unknown.length) {
          this.onEvent(
            `PANDA CFG_PUSH ${msg.side}: unrecognised key(s) ${unknown.join(', ')} — firmware is ahead of this parser`,
            'warn'
          );
        }
      }
    }
    this.onEvent(`PANDA ${msg.category}${msg.side ? `:${msg.side}` : ''} ${msg.detail}`.trim(), 'info');
  }

  /**
   * `BB_ERROR:` / `CMD_ERROR:` — the board's only negative acknowledgement.
   * A command it silently ignores produces nothing at all, which is why the
   * caller times out rather than waiting forever.
   */
  onBoardError(msg) {
    this.onEvent(msg.message, 'error');
    this.onBbError?.(msg.message);
  }

  /**
   * Positive acks. `Disarming!` additionally mirrors the firmware's
   * forceSafe() across both sides, so our view of the board does not keep
   * showing a running controller the board has already dropped.
   */
  onAck(msg) {
    if (msg.message.startsWith('Disarming!')) {
      for (const side of Object.values(this.bb)) {
        side.state = 'OFF';
        side.press = false;
        side.vent = false;
      }
    }
    this.onEvent(msg.message, 'info');
  }

  /**
   * PT chain: volts across the shunt -> mA -> psi.
   *
   * The normalisation clamps to [0,1], so a channel can never read below
   * `min` or above `max`. A pinned reading is usually clamping, not
   * saturation — check the raw mA before chasing a sensor fault.
   */
  toPsi(index, value) {
    let ma;
    if (this.ptInputMode === 'ma') {
      ma = value;
    } else if (this.ptInputMode === 'auto') {
      ma = Math.abs(value) <= 2 ? this.voltsToMa(index, value) : value;
    } else {
      ma = this.voltsToMa(index, value);
    }
    this.raw.set(`pt${index}_ma`, ma);

    const sensor = this.sensorForChannel('pt', index);
    const lo = sensor?.min ?? 0;
    const hi = sensor?.max ?? 1000;
    const norm = Math.min(1, Math.max(0, (ma - 4) / 16));
    return lo + norm * (hi - lo);
  }

  voltsToMa(index, volts) {
    const r = Number(this.shuntOhms[index] ?? this.defaultShuntOhms);
    return (volts / r) * 1000;
  }

  /**
   * Reorder an `s` line from wire position to logical channel.
   *
   * `dcOrder[i]` is the logical index of the value at wire position i. Values
   * past the end of the map pass through unmoved rather than being dropped —
   * a board reporting more channels than are mapped is a config gap, not a
   * reason to lose the reading.
   */
  remapDc(values) {
    if (!this.dcOrder) return values;
    const out = values.slice();
    for (let i = 0; i < values.length; i++) {
      const logical = this.dcOrder[i];
      if (logical !== undefined) out[logical] = values[i];
    }
    return out;
  }

  /**
   * Dump the `s` line by wire position, for pinning down which position
   * carries which solenoid.
   *
   * Enable with GC_DEBUG_DC=1. Prints once a second, plus immediately whenever
   * any position moves by more than `DC_TRACE_DELTA_A` — so the procedure is:
   * actuate ONE valve and watch which index jumps. That is the only reliable
   * way to establish the mapping, because the `s` line carries no channel
   * identifiers of its own and its order is a harness artifact that
   * HANDOVER_COMMS.md §3.5 explicitly says to verify per board.
   *
   * `min`/`max` accumulate across the whole session: a position that never
   * moves is the interesting case, and a single frame cannot show that.
   */
  traceDc(rawLine, wire) {
    const now = Date.now();
    this.dcTrace ??= new Map();

    let moved = null;
    wire.forEach((v, i) => {
      const seen = this.dcTrace.get(i) || { min: v, max: v };
      if (v < seen.min) seen.min = v;
      if (v > seen.max) seen.max = v;
      this.dcTrace.set(i, seen);
      if (Math.abs(v - (seen.last ?? v)) > DC_TRACE_DELTA_A) moved = i;
      seen.last = v;
    });

    if (moved === null && now - (this.lastDcTraceAt || 0) < 1000) return;
    this.lastDcTraceAt = now;

    const cols = wire.map((v, i) => {
      const meta = this.dcChannels[i];
      const span = this.dcTrace.get(i);
      const label = meta ? `${meta.id}${meta.valve ? `/${meta.valve}` : ''}` : '(unmapped)';
      const flat = span.max - span.min <= DC_TRACE_DELTA_A ? ' FLAT' : '';
      return `  [${String(i).padStart(2)}] ${v.toFixed(3)}A  ` +
             `range ${span.min.toFixed(3)}..${span.max.toFixed(3)}${flat}  ${label}`;
    });
    console.error(
      `[panda] s-line: ${wire.length} values${moved !== null ? `  *** position ${moved} MOVED ***` : ''}\n` +
      `  raw: ${rawLine}\n${cols.join('\n')}`
    );
  }

  /**
   * Check the current-sense wiring against the stand's actual valves.
   *
   * `dcByValve` is keyed by valve id, so a `dcChannels` entry naming a valve
   * that does not exist simply never matches and that actuator shows no
   * current reading — with nothing anywhere saying why. That is exactly what
   * happened when the stand's valves were renamed and this file was not: five
   * of eleven channels went dark and looked like a hardware fault.
   *
   * Both directions are reported, because they mean different things. A
   * channel naming an unknown valve is a stale or mistyped wiring file. A
   * valve with no channel may be correct — not every actuator is sensed — so
   * it is listed once at startup for confirmation, not warned about.
   */
  checkDcWiring(config) {
    const valves = new Set((config?.valves || []).map((v) => v.id));
    if (!valves.size) return;

    const orphans = [];
    const unsensed = [];
    for (const [index, meta] of Object.entries(this.dcChannels)) {
      if (!meta.valve) continue;
      if (meta.sensed === false) { unsensed.push(`${meta.id}/${meta.valve}`); continue; }
      if (!valves.has(meta.valve)) {
        orphans.push(`${meta.id || `DC${Number(index) + 1}`}→"${meta.valve}"`);
      }
    }
    // Said once at startup, not warned about: it is a deliberate declaration,
    // and an operator who sees no current row on a valve should be able to
    // find out from the log why rather than assuming the board went quiet.
    if (unsensed.length) {
      console.error(`[panda] current sense declared unavailable on: ${unsensed.join(', ')}`);
    }
    if (orphans.length) {
      this.onEvent(
        `PANDA current sense: ${orphans.length} channel(s) name a valve this stand does not have ` +
        `(${orphans.join(', ')}) — those actuators will show no current reading. ` +
        `Check dcChannels[].valve in your hardware config against stand.json.`,
        'error'
      );
    }

    const unmapped = [...valves].filter((id) => !this.dcByValve.has(id));
    if (unmapped.length) {
      console.error(`[panda] no current sense configured for: ${unmapped.join(', ')}`);
    }
  }

  /**
   * Per-channel current sense, keyed by the valve each channel watches.
   * Diagnostics for the UI: `{ 'SV-LOXBB': {id, amps, energized} }`.
   */
  dcStatus() {
    const out = {};
    for (const [valveId, index] of this.dcByValve) {
      const amps = this.dc.currents[index];
      if (amps === undefined) continue;
      out[valveId] = {
        id: this.dcChannels[index]?.id || `DC${index + 1}`,
        amps,
        energized: amps >= this.dcThresholdA,
      };
    }
    return out;
  }

  /**
   * The board's channel name for each valve: `{ 'SV-LOXBB': 'DC1' }`.
   *
   * Wiring, not telemetry — it comes from the hardware config and is
   * available before the board has said a word. The recorder builds its
   * header from this the instant a file opens, and a header that depended on
   * whether a current frame had arrived yet would name the same column two
   * different things across two runs.
   */
  dcLabels() {
    const out = {};
    for (const [valveId, index] of this.dcByValve) {
      out[valveId] = this.dcChannels[index]?.id || `DC${index + 1}`;
    }
    return out;
  }

  sensorForChannel(kind, index) {
    const key = `${kind}${index}`;
    const id = this.channelMap[key];
    return id ? this.config?.sensors.find((s) => s.id === id) : undefined;
  }

  // ------------------------------------------------------------ outbound ----

  send(line) {
    if (!this.port?.writable) return false;
    this.port.write(line + '\n');
    // Both directions, so the tap shows a command and the board's answer to it
    // in one stream. Half a conversation is much harder to read than all of it.
    this.onRaw?.('tx', Buffer.from(line, 'ascii'));
    return true;
  }

  /** Solenoid channels are 1-9 then A,B,C for 10-12. */
  static channelToken(channel) {
    const n = Number(channel);
    if (!Number.isInteger(n) || n < 1 || n > 12) return null;
    return n <= 9 ? String(n) : String.fromCharCode(65 + n - 10);
  }

  setValve(valve, state) {
    const token = PandaDriver.channelToken(valve.channel);
    if (token === null) {
      throw new Error(`${valve.id}: channel ${valve.channel} is outside the PANDA's 1-12 range`);
    }
    // A normally-open valve is energized to CLOSE, so the coil state is not
    // the flow state. Resolve it here so callers only ever speak flow state.
    const energize = valve.normallyOpen ? state === 'closed' : state === 'open';
    this.send(`S${token}${energize ? 1 : 0}`);
  }

  setArmed(armed) {
    if (this.armHardware) this.send(armed ? 'a' : 'r');
  }

  safeAll() {
    // Stop the regulator before dropping the outputs. 'r' triggers the
    // firmware's own forceSafe() across both sides, but a side left in SUS
    // would resume the moment the board is re-armed, so say it explicitly
    // rather than relying on a side effect we cannot see the source of.
    for (const side of ['L', 'F']) this.send(encodeEnable(side, false));

    // 'r' is the board's own disarm/abort: it drops every output itself,
    // which still works if a per-channel command is what went wrong.
    this.send('r');
    for (const v of this.config?.valves || []) {
      try { this.setValve(v, v.safeState); } catch { /* out-of-range channel */ }
    }
  }

  // ----------------------------------------------------------- bang-bang ----
  //
  // Command builders live in bb-protocol.js; these are the transport. Each
  // returns {ok, command, error} where `ok` means ONLY that the bytes left the
  // host. Firmware acceptance arrives later and separately, as a CFG_PUSH
  // echo or a BB_ERROR rejection — never as a return value here.

  /** Push the core regulator config: setpoint, band, dwell, pulse limit. */
  bbConfig(side, cfg) { return this.bbSend(() => encodeConfig(side, cfg)); }

  /** Push the vent config: auto-vent trigger and whether it is armed. */
  bbVent(side, cfg) { return this.bbSend(() => encodeVent(side, cfg)); }

  /** Push the mass-flow setpoint schedule. */
  bbMdot(side, cfg) { return this.bbSend(() => encodeMdot(side, cfg)); }

  /** Enter (`true`) or leave (`false`) the regulating state. */
  bbEnable(side, on) { return this.bbSend(() => encodeEnable(side, on)); }

  /** Manual vent override, independent of the auto-vent setting. */
  bbManualVent(side, open) { return this.bbSend(() => encodeManualVent(side, open)); }

  /** Per-side abort. Latched on the board — assume nothing clears it. */
  bbAbort(side) { return this.bbSend(() => encodeAbort(side)); }

  bbSend(build) {
    let command;
    try {
      command = build();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (!this.send(command)) {
      return { ok: false, command, error: 'serial port is not writable' };
    }
    return { ok: true, command };
  }

  /**
   * What the board says about each side, plus whether we are still hearing
   * from it. `stale` matters: a heartbeat that stopped arriving does not mean
   * the loop stopped — the board keeps regulating on its own — so the UI has
   * to distinguish "closed" from "no longer being told".
   */
  bbStatus() {
    const now = Date.now();
    const out = {};
    for (const [key, side] of Object.entries(this.bb)) {
      out[key] = {
        state: side.state,
        stateValid: side.stateValid,
        press: side.press,
        vent: side.vent,
        pressure: side.pressure,
        lastBeatAt: side.lastBeatAt,
        stale: side.lastBeatAt === 0 || now - side.lastBeatAt > HEARTBEAT_TIMEOUT_MS,
        confirmed: { ...side.confirmed },
        confirmedAt: side.confirmedAt,
        echoes: this.bbEchoes,
      };
    }
    return out;
  }

  /** Which board side, if any, a given command letter refers to. */
  static side(value) { return commandSide(value); }

  read() {
    const out = {};
    for (const [key, id] of Object.entries(this.channelMap)) {
      const value = this.raw.get(key);
      if (value === undefined) continue;
      const sensor = this.config?.sensors.find((s) => s.id === id);
      const { slope = 1, offset = 0 } = sensor?.calibration || {};
      out[id] = value * slope + offset;
    }
    return out;
  }

  /** Watchdog state, phrased for the status line. Never silently omitted. */
  linkLabel() {
    if (!this.link.seen) {
      return this.warnedNoWatchdog ? 'NO WATCHDOG IN FIRMWARE' : 'watchdog unknown';
    }
    if (!this.link.armed) return 'WATCHDOG UNARMED';
    return this.link.lost ? 'watchdog armed · BOARD SEES LINK LOSS' : 'watchdog armed';
  }

  get status() {
    return {
      name: this.name,
      connected: this.connected,
      lastRxAt: this.lastRxAt,       // 0 until the board says something
      link: { ...this.link },
      detail: this.connected
        ? `${this.detail} · ${this.rxCount} lines · ${this.linkLabel()}`
        : `${this.detail || 'no port'} · NO LINK`,
    };
  }

  async close() {
    clearInterval(this.watchdog);
    // Stop beating before safing. Once we are shutting down there is nobody
    // left to command the stand, so the board's watchdog should be allowed to
    // take over rather than being held open by a process that is exiting.
    clearInterval(this.gcHeartbeat);
    this.safeAll();
    await new Promise((r) => setTimeout(r, 50));   // let the safe writes flush
    await new Promise((r) => this.port?.close(() => r()) ?? r());
  }
}

function freshBbSide() {
  return {
    state: 'OFF',
    stateValid: true,
    press: false,
    vent: false,
    pressure: null,          // null, not 0: "the board has not said" is not 0 psi
    lastBeatAt: 0,
    confirmed: {},           // last CFG_PUSH echo — the board's own account
    confirmedAt: 0,
  };
}

/** Strip anything that is not part of a number, so "p6.500" parses as 6.5. */
function parseNumbers(line) {
  return line
    .slice(1)
    .split(',')
    .map((tok) => Number(tok.replace(/[^0-9+\-.]/g, '')))
    .map((n) => (Number.isFinite(n) ? n : NaN));
}

/**
 * Score alternate byte interpretations by how many newlines they would yield.
 * Turns a silent hang into a one-line answer: RS-485 A/B swapped, wrong baud,
 * or a stuck high bit all show up here.
 */
function diagnoseFraming(buf) {
  const score = (fn) => {
    let n = 0;
    for (const b of buf) if (fn(b) === 0x0a) n++;
    return n;
  };
  const options = {
    'as-is': score((b) => b),
    'inverted (XOR 0xFF)': score((b) => b ^ 0xff),
    'high bit stripped': score((b) => b & 0x7f),
    'bit-reversed': score((b) => Number(b.toString(2).padStart(8, '0').split('').reverse().join(''), 2)),
  };
  const best = Object.entries(options).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0
    ? `best interpretation "${best[0]}" (${best[1]} newlines) — check polarity/baud`
    : 'no newlines under any interpretation — check baud rate and wiring';
}

async function autodetectPort(SerialPort) {
  const ports = await SerialPort.list();
  const preferred = ports.find((p) => /usbmodem|usbserial|ttyACM|ttyUSB/i.test(p.path));
  return (preferred || ports[0])?.path || null;
}
