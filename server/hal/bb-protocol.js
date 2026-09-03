/**
 * bb-protocol.js — the PANDA board's bang-bang wire protocol, both directions.
 *
 * The regulator runs ON THE BOARD. Ground control pushes configuration,
 * enables or disables the loop, issues vent and abort overrides, and displays
 * what the board reports. It never closes the loop itself. See
 * HANDOVER_COMMS.md §5.1 for why: if the serial link, the server or the
 * browser dies, the board keeps regulating with the last configuration it
 * accepted. A ground station that ran the loop would drop the valve on a
 * disconnect.
 *
 * This module is the only place that knows the byte-level format. The driver
 * (panda.js) uses it to encode commands and decode board lines; the simulated
 * firmware (bb-firmware.js) uses it in the opposite direction. Keeping both
 * ends on one module means the simulator exercises the real wire format
 * rather than a parallel shortcut — which matters, because the wire format is
 * the part we cannot test against hardware until we are at the pad.
 *
 * CASE CONVENTION (easy to get wrong, silently)
 *   Uppercase command letter = CONFIGURE   B / V / M
 *   Lowercase command letter = ACTUATE     b / v / x / e
 *   Side in a COMMAND is uppercase         L / F
 *   Side in a HEARTBEAT is lowercase       l / f
 *
 * DEADBAND
 *   `deadbandFull` here is the FULL band width centred on the setpoint, which
 *   is what the firmware wants: hi = sp + db/2, lo = sp - db/2. GC-4 speaks in
 *   ± half-bands everywhere else, so the doubling happens at the boundary in
 *   bangbang.js. The parameter is named `deadbandFull` rather than `deadband`
 *   so that a caller passing the wrong one has to ignore the name to do it.
 */

/** The four states the board's per-side machine can report. */
export const BB_STATES = ['OFF', 'SUS', 'AV', 'ABT'];

/** Human-readable state names, for the event log and the UI. */
export const BB_STATE_LABELS = {
  OFF: 'Off',
  SUS: 'Sustain',
  AV: 'Auto-vent',
  ABT: 'Abort',
};

/** Prefixes the board uses for positive acknowledgements. */
const ACK_PREFIXES = ['SEQ_', 'Arming!', 'Disarming!', 'Panda Initialized!', 'Firing sequence!'];

/** Prefixes the board uses to reject a command. The ONLY negative ack. */
const ERROR_PREFIXES = ['BB_ERROR:', 'CMD_ERROR:', 'PT_ERROR:'];

/**
 * Which of the board's own PT channels each bang-bang side regulates on.
 *
 * The board numbers them 0 and 1; the tare command spells the same two
 * channels as `L` and `F`. Both spellings appear in one four-command
 * vocabulary (`TL` but `T0,<offset>`), so the mapping lives here once rather
 * than at each call site.
 */
export const PT_CHANNEL = { L: 0, F: 1 };
export const PT_SIDE_OF_CHANNEL = { 0: 'L', 1: 'F' };

/**
 * `CFG_PUSH` echo keys -> our field names.
 *
 * THE VENT KEYS ARE NOT WHAT THE HANDOVER DOC SAYS. §5.5 lists them as
 * `ventTrig`/`ventAuto`; the PandaV2 board on this stand sends
 * `avTrig`/`avAuto` — "auto-vent", matching the `AV` state name. Observed on
 * hardware 2026-08-27, confirmed by the values echoing back exactly what a
 * `VF650.0,0` had just pushed. The documented spellings are kept as aliases
 * rather than replaced, because the doc was written from a second
 * implementation that may be running somewhere and the two cost nothing to
 * accept together.
 *
 * STILL UNVERIFIED: every `mdot*` key below. GC-4 never sends the `M` command
 * (nothing in stand.json configures mass-flow scheduling), so no echo for it
 * has ever been seen. Expect these spellings to be wrong in the same way the
 * vent ones were, and check the "unrecognised key(s)" warning the first time
 * an `M` is pushed — that warning is how the vent mismatch surfaced.
 *
 * `rho` is sent in `M` but has no echo key at all, so the density the board is
 * using cannot be verified from the ground. Treat it as write-only.
 */
export const CFG_PUSH_KEYS = {
  sp: ['setpoint', 'float'],
  db: ['deadbandFull', 'float'],
  wait: ['waitMs', 'int'],
  maxOpen: ['maxOpenMs', 'int'],
  avTrig: ['ventTrigger', 'float'],      // observed on hardware
  avAuto: ['ventAuto', 'bool'],          // observed on hardware
  ventTrig: ['ventTrigger', 'float'],    // documented in §5.5; kept as an alias
  ventAuto: ['ventAuto', 'bool'],        // documented in §5.5; kept as an alias
  mdot: ['mdotTarget', 'float'],
  spMin: ['spMin', 'float'],
  spMax: ['spMax', 'float'],
  gain: ['mdotGain', 'float'],
  mdotOn: ['mdotOn', 'bool'],
};

// ------------------------------------------------------------------ sides ---

/** Normalise any spelling of a side to the uppercase COMMAND form. */
export function commandSide(side) {
  const s = String(side || '').toUpperCase();
  return s === 'L' || s === 'F' ? s : null;
}

/** Normalise any spelling of a side to the lowercase HEARTBEAT form. */
export function heartbeatSide(side) {
  const s = String(side || '').toLowerCase();
  return s === 'l' || s === 'f' ? s : null;
}

// --------------------------------------------------------------- encoding ---

/**
 * `B<side><setpoint>,<deadbandFull>,<wait_ms>,<max_open_ms>`
 *
 * Formatted `%.1f` rather than as integers. The other reference implementation
 * truncates with int(), which silently discards a fractional setpoint — a
 * 200.5 psi target becomes 200 with no warning anywhere.
 */
export function encodeConfig(side, { setpoint, deadbandFull, waitMs = 0, maxOpenMs = 0 }) {
  const c = requireSide(side);
  return `B${c}${f1(setpoint)},${f1(deadbandFull)},${int(waitMs)},${int(maxOpenMs)}`;
}

/** `V<side><trigger_psi>,<auto01>` */
export function encodeVent(side, { trigger, auto }) {
  const c = requireSide(side);
  return `V${c}${f1(trigger)},${auto ? 1 : 0}`;
}

/** `M<side><mdot>,<sp_min>,<sp_max>,<gain>,<rho>,<enable01>` */
export function encodeMdot(side, { target, spMin, spMax, gain, rho, enabled }) {
  const c = requireSide(side);
  return `M${c}${f3(target)},${f3(spMin)},${f3(spMax)},${f5(gain)},${f3(rho)},${enabled ? 1 : 0}`;
}

/** `b<side><0|1>` — enter or leave SUS. */
export function encodeEnable(side, on) {
  return `b${requireSide(side)}${on ? 1 : 0}`;
}

/** `v<side><0|1>` — manual vent, independent of the auto-vent setting. */
export function encodeManualVent(side, open) {
  return `v${requireSide(side)}${open ? 1 : 0}`;
}

/** `x<side>` — per-side abort. LATCHED: nothing in this protocol clears it. */
export function encodeAbort(side) {
  return `x${requireSide(side)}`;
}

/**
 * `e<side><0|1>` — the board's predictive valve shutoff.
 *
 * Closes the press valve early, on where the pressure is HEADED rather than
 * where it is, so the rise after the valve shuts lands inside the band instead
 * of above it. Defaults OFF in firmware, and this is the only way to change
 * that — it has no `B` field and no CFG_PUSH echo key, so the board's setting
 * cannot be read back. GC's copy is what it last commanded, nothing more.
 *
 * ENABLING REQUIRES THE BOARD TO BE ARMED; disabling is accepted at any time.
 * The asymmetry is deliberate and worth preserving in every layer above this
 * one: the safe direction must never be gated on anything.
 */
export function encodePredictive(side, on) {
  return `e${requireSide(side)}${on ? 1 : 0}`;
}

/**
 * `T<side>` — zero the board's OWN transducer on that side, to whatever it is
 * reading right now. Persisted to the board's EEPROM, so it outlives a power
 * cycle and is not something GC re-asserts at startup.
 *
 * This is the pressure the REGULATOR runs on, not the DAQ channel of the same
 * tank. Zeroing it while that side is regulating tells the loop a pressurised
 * tank is at ambient, and the loop then presses to setpoint on top of what is
 * already in there. The interlock that refuses that lives in bangbang.js;
 * this function only builds bytes.
 *
 * Needs fresh PT data on the board — it answers `PT_ERROR:no_data` otherwise.
 */
export function encodePtTare(side) {
  return `T${requireSide(side)}`;
}

/** `Tz` — clear the offsets on BOTH channels at once. No per-side form. */
export function encodePtTareClear() {
  return 'Tz';
}

/**
 * `T<channel>,<offset>` — set one channel's offset explicitly, in PSI.
 *
 * Taken by side rather than by channel number so no caller has to carry the
 * L=0/F=1 mapping around. An offset of 0 is the per-side "clear": `Tz` is
 * all-or-nothing, and clearing one side without disturbing the other is
 * exactly what you want when only one transducer was re-zeroed.
 *
 * Formatted `%.1f`, matching every other pressure on this wire. The board
 * reports its PT to one decimal, so an offset carrying more precision than
 * that would be precision the reading cannot show.
 */
export function encodePtOffset(side, psi) {
  return `T${PT_CHANNEL[requireSide(side)]},${f1(psi)}`;
}

/** `BB:<side>:<state>:<press01>:<vent01>:<psi>` — the board's heartbeat. */
export function encodeHeartbeat(side, { state, press, vent, pressure }) {
  const s = heartbeatSide(side);
  if (!s) throw new Error(`bang-bang side must be "l" or "f", got "${side}"`);
  const head = `BB:${s}:${state}:${press ? 1 : 0}:${vent ? 1 : 0}`;
  return pressure === undefined || pressure === null ? head : `${head}:${f1(pressure)}`;
}

/** `EVT:<ms>:CFG_PUSH:<side>:<k=v,...>` — the board's config echo. */
export function encodeCfgPush(ms, side, fields) {
  const s = heartbeatSide(side) ?? '';
  const detail = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 1 : 0) : v}`)
    .join(',');
  return `EVT:${int(ms)}:CFG_PUSH:${s}:${detail}`;
}

// --------------------------------------------------------------- decoding ---

/**
 * Classify one board line.
 *
 * PREFIX CHECKS COME FIRST, and the comma test comes LAST. This ordering is a
 * correctness requirement, not a style choice: `EVT:...:CFG_PUSH:...` carries
 * a comma-separated k=v list in its detail, so any dispatcher that tests for a
 * comma first files every config confirmation as telemetry and they never
 * reach the operator. The reference implementation has exactly that bug.
 *
 * Returns `{kind, ...}` where kind is one of:
 *   heartbeat  {side, state, press, vent, pressure|undefined}
 *   event      {ms, category, side, detail, config?}
 *   error      {message}
 *   ack        {message}
 *   link       {armed, lost, silentMs}
 *   telemetry  {id, line}
 *   unknown    {line}
 */
export function parseLine(raw) {
  const line = String(raw).trim();

  if (line.startsWith('BB:')) {
    const parsed = parseHeartbeat(line);
    if (parsed) return parsed;
    return { kind: 'unknown', line, reason: 'malformed BB: heartbeat' };
  }

  if (line.startsWith('EVT:')) return parseEvent(line);

  if (line.startsWith('LINK:')) {
    const parsed = parseLinkStatus(line);
    if (parsed) return parsed;
    return { kind: 'unknown', line, reason: 'malformed LINK: status' };
  }

  if (ERROR_PREFIXES.some((p) => line.startsWith(p))) {
    return { kind: 'error', message: line };
  }

  if (ACK_PREFIXES.some((p) => line.startsWith(p))) {
    return { kind: 'ack', message: line };
  }

  // Telemetry only after every status prefix has had its chance.
  if (line.includes(',') || /^[a-zA-Z][-+0-9.]/.test(line)) {
    return { kind: 'telemetry', id: line[0], line };
  }

  return { kind: 'unknown', line };
}

/**
 * `LINK:<armed01>:<lost01>:<silentMs>` — the board's GC-link watchdog.
 *
 * The board cannot tell a quiet hold from a severed cable, because GC only
 * talks to it when the operator acts. So it watches for the `h` heartbeat:
 * 600 ms of silence forces its bang-bang controllers safe, 10 s disarms the
 * stand outright. This line is how it reports that watchdog's own state.
 *
 * `armed` is the field that matters. The watchdog is heartbeat-GATED — dormant
 * until it sees its first `h` — so `armed: false` means nothing is guarding the
 * link, which is the pre-watchdog firmware behaviour.
 *
 * Every field is validated and a malformed line is rejected outright rather
 * than partially parsed. Same reasoning as the BB state field: a garbled value
 * here must never read as "protected" downstream, because that is the one
 * direction this field must not fail in.
 */
export function parseLinkStatus(line) {
  const parts = line.split(':');
  if (parts.length < 4) return null;

  const [, armed, lost, silent] = parts;
  if (armed !== '0' && armed !== '1') return null;
  if (lost !== '0' && lost !== '1') return null;

  const silentMs = Number(silent);
  if (!Number.isFinite(silentMs) || silentMs < 0) return null;

  return { kind: 'link', armed: armed === '1', lost: lost === '1', silentMs };
}

/**
 * `BB:<side>:<state>:<press01>:<vent01>[:<pressure>]`
 *
 * The pressure field is optional — a 5-field heartbeat is legal and means
 * "no new reading", so the caller keeps the last one rather than zeroing it.
 * An unrecognised state is reported as `stateValid: false` instead of being
 * passed through: the reference client derives "enabled" from `state != OFF`,
 * so a garbled state reads as ENABLED downstream, which is the wrong way for
 * this particular field to fail.
 */
export function parseHeartbeat(line) {
  const parts = line.split(':');
  if (parts.length < 5) return null;

  const side = heartbeatSide(parts[1]);
  if (!side) return null;

  const state = parts[2];
  const out = {
    kind: 'heartbeat',
    side,
    state,
    stateValid: BB_STATES.includes(state),
    press: parts[3] === '1',
    vent: parts[4] === '1',
  };
  if (parts.length > 5) {
    const psi = Number(parts[5]);
    if (Number.isFinite(psi)) out.pressure = psi;
  }
  return out;
}

/**
 * `EVT:<ms>:<category>:<side>:<detail>` — split with a limit of 4, because the
 * detail may itself contain both colons and commas.
 */
export function parseEvent(line) {
  const parts = splitLimit(line, ':', 5);
  const [, ms, category = '', side = '', detail = ''] = parts;
  const out = {
    kind: 'event',
    ms: Number(ms) || 0,
    category,
    side: heartbeatSide(side) ?? '',
    detail,
  };
  if (category === 'CFG_PUSH') out.config = parseCfgPush(detail);
  return out;
}

/**
 * Parse a `CFG_PUSH` detail into our field names.
 *
 * Unknown keys are collected rather than dropped, so a firmware that starts
 * echoing something new (`rho`, say) shows up as an unrecognised key in the
 * log instead of vanishing.
 */
export function parseCfgPush(detail) {
  const fields = {};
  const unknown = {};
  for (const pair of String(detail).split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const spec = CFG_PUSH_KEYS[key];
    if (!spec) { unknown[key] = value; continue; }
    const [field, type] = spec;
    if (type === 'bool') fields[field] = value === '1';
    else if (type === 'int') fields[field] = Math.round(Number(value)) || 0;
    else fields[field] = Number(value);
  }
  return { fields, unknown };
}

/**
 * Decode a HOST->BOARD command. Only the emulated firmware needs this, but it
 * lives here so the encoders and decoders of one format cannot drift apart.
 *
 * Returns `{kind, side, ...}` or null if the line is not a bang-bang command.
 */
export function parseCommand(raw) {
  const line = String(raw).trim();
  if (!line) return null;

  const verb = line[0];

  // PT tare is decoded BEFORE the side lookup below, because two of its four
  // forms carry no side at all — `Tz` addresses both channels and `T0,`/`T1,`
  // address one by number. Falling through to `commandSide(line[1])` would
  // reject them on the 'z' and the '0'.
  if (verb === 'T') return parsePtTareCommand(line.slice(1));

  const side = commandSide(line[1]);
  if (!side) return null;
  const rest = line.slice(2);
  const parts = rest.split(',');
  const nums = parts.map(Number);

  switch (verb) {
    case 'B':
      if (parts.length < 2 || !nums.slice(0, 2).every(Number.isFinite)) return null;
      return {
        kind: 'config', side,
        setpoint: nums[0],
        deadbandFull: nums[1],
        waitMs: Number.isFinite(nums[2]) ? nums[2] : 0,
        maxOpenMs: Number.isFinite(nums[3]) ? nums[3] : 0,
      };
    case 'V':
      if (!Number.isFinite(nums[0])) return null;
      return { kind: 'vent', side, trigger: nums[0], auto: parts[1] === '1' };
    case 'M':
      if (parts.length < 6 || !nums.slice(0, 5).every(Number.isFinite)) return null;
      return {
        kind: 'mdot', side,
        target: nums[0], spMin: nums[1], spMax: nums[2],
        gain: nums[3], rho: nums[4],
        enabled: parts[5] === '1',
      };
    case 'b':
      return rest === '0' || rest === '1' ? { kind: 'enable', side, on: rest === '1' } : null;
    case 'v':
      return rest === '0' || rest === '1' ? { kind: 'manualVent', side, open: rest === '1' } : null;
    case 'x':
      return rest === '' ? { kind: 'abort', side } : null;
    case 'e':
      return rest === '0' || rest === '1' ? { kind: 'predictive', side, on: rest === '1' } : null;
    default:
      return null;
  }
}

/**
 * Decode the argument of a `T` command — everything after the verb.
 *
 *   `L` / `F`        tare that side to its current reading
 *   `z`              clear both channels
 *   `0,x` / `1,x`    set that channel's offset to x PSI
 *
 * `z` is tested before the side lookup: `commandSide` upper-cases, so a
 * future channel letter would be case-folded into a side if the order were
 * reversed. Anything else is null — an unrecognised `T` must not be
 * mistaken for one of these three.
 */
function parsePtTareCommand(arg) {
  if (arg === 'z') return { kind: 'ptTareClear' };

  const side = commandSide(arg);
  if (side) return { kind: 'ptTare', side };

  const m = /^([01]),(-?(?:\d+\.?\d*|\.\d+))$/.exec(arg);
  if (!m) return null;
  const offset = Number(m[2]);
  if (!Number.isFinite(offset)) return null;
  return { kind: 'ptOffset', side: PT_SIDE_OF_CHANNEL[m[1]], channel: Number(m[1]), offset };
}

/**
 * Pull the applied offsets out of a `PT_TARE` event's detail.
 *
 * UNVERIFIED FORMAT. The firmware note says success "emits EVT:…:PT_TARE:…"
 * without saying what the detail carries, so this accepts the two shapes it
 * could plausibly be — `k=v` pairs like CFG_PUSH uses, or bare comma-separated
 * numbers in channel order — and returns nothing at all rather than guessing
 * when it recognises neither.
 *
 * Nothing depends on this succeeding: the offsets GC displays are the ones it
 * commanded, and this only upgrades them to what the board confirmed. Check a
 * real PT_TARE line against this before trusting the confirmed values.
 */
export function parsePtTare(detail) {
  const text = String(detail ?? '').trim();
  if (!text) return {};

  const out = {};
  if (text.includes('=')) {
    for (const pair of text.split(',')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim().toUpperCase();
      const value = Number(pair.slice(eq + 1).trim());
      if (!Number.isFinite(value)) continue;
      const side = commandSide(key) ?? PT_SIDE_OF_CHANNEL[key.replace(/^(PT|CH)/, '')];
      if (side) out[side] = value;
    }
    return out;
  }

  const nums = text.split(',').map((v) => Number(v.trim()));
  if (nums.length && nums.every(Number.isFinite)) {
    nums.slice(0, 2).forEach((v, i) => { out[PT_SIDE_OF_CHANNEL[i]] = v; });
  }
  return out;
}

// ---------------------------------------------------------------- helpers ---

function requireSide(side) {
  const c = commandSide(side);
  if (!c) throw new Error(`bang-bang side must be "L" or "F", got "${side}"`);
  return c;
}

function f1(v) { return num(v).toFixed(1); }
function f3(v) { return num(v).toFixed(3); }
function f5(v) { return num(v).toFixed(5); }
function int(v) { return String(Math.round(num(v))); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** split() with a maxsplit, so the last field keeps its own delimiters. */
function splitLimit(s, sep, limit) {
  const parts = s.split(sep);
  if (parts.length <= limit) return parts;
  return [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(sep)];
}
