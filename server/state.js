/**
 * state.js — the stand controller: authoritative state, interlocks, tick loop.
 *
 * SAFETY MODEL
 *   DISARMED  valves whose `requiresArm` is true cannot be opened. Commands
 *             toward a valve's configured safeState are ALWAYS permitted, so
 *             an operator can always make the stand safer, never less safe.
 *   ARMED     full manual and sequence control.
 *   ABORT     latched. Every actuator is driven to its `abortState`. Only
 *             safe-direction commands are accepted until the abort is cleared.
 *
 * The browser is a view, never the authority. Every interlock lives here, so a
 * stale tab, a lost network link, or a second operator on another laptop
 * cannot bypass a rule.
 */
import { EventEmitter } from 'node:events';
import { BangBangBank } from './bangbang.js';
import { Sequencer } from './sequencer.js';
import { Recorder } from './recorder.js';

const MAX_EVENTS = 500;

export class StandController extends EventEmitter {
  constructor(configStore, driver, baseDir) {
    super();
    this.setMaxListeners(0);
    this.configStore = configStore;
    this.driver = driver;
    this.baseDir = baseDir;

    this.armed = false;
    this.armedAt = 0;
    this.abortState = { active: false, reason: null, at: 0 };

    this.valveStates = {};      // id -> 'open' | 'closed'
    this.valveMeta = {};        // id -> {at, source}
    this.readings = {};         // id -> engineering value
    this.history = new Map();   // id -> RingBuffer
    this.events = [];
    this.eventSeq = 0;
    this.momentaryTimers = new Map();
    this.tickCount = 0;
    this.lastBroadcast = 0;

    this.bangbang = new BangBangBank(this);
    this.sequencer = new Sequencer(this);
    this.recorder = new Recorder(this, baseDir);

    this.initFromConfig();

    configStore.on('reload', () => {
      this.initFromConfig(true);
      this.bangbang.sync();
      // Re-assert the bang-bang config on the board. A reload can change a
      // setpoint, and a board still holding the previous one is the exact
      // divergence the CFG_PUSH echo exists to catch.
      this.bangbang.pushAll('reload');
      this.log('info', 'Configuration reloaded', 'system');
      this.emit('config-reload', this.config);
    });

    this.on('sequence-start', (cfg) => {
      if (this.config.recording.autoStartOnSequence?.includes(cfg.id) && !this.recorder.active) {
        this.recorder.start(cfg.id.replace(/^seq-/, ''), `seq:${cfg.id}`);
      }
    });
    this.on('sequence-end', () => {
      const secs = this.config.recording.autoStopSecondsAfterSequence;
      if (this.recorder.active && secs > 0) this.recorder.scheduleAutoStop(secs);
    });
  }

  get config() { return this.configStore.get(); }

  initFromConfig(isReload = false) {
    const cfg = this.config;
    const historyLen = Math.max(60, Math.ceil(cfg.telemetry.historySeconds * cfg.telemetry.streamRateHz));

    for (const v of cfg.valves) {
      if (!(v.id in this.valveStates)) {
        this.valveStates[v.id] = v.safeState;
        this.valveMeta[v.id] = { at: Date.now(), source: 'init' };
      }
    }
    // Drop valves that no longer exist in the config.
    for (const id of Object.keys(this.valveStates)) {
      if (!cfg.valves.some((v) => v.id === id)) {
        delete this.valveStates[id];
        delete this.valveMeta[id];
      }
    }

    for (const s of cfg.sensors) {
      if (!this.history.has(s.id)) this.history.set(s.id, new RingBuffer(historyLen));
    }
    for (const id of [...this.history.keys()]) {
      if (!cfg.sensors.some((s) => s.id === id)) this.history.delete(id);
    }

    if (!isReload) this.log('info', `Loaded stand "${cfg.meta.standName}" — ${cfg.valves.length} actuators, ${cfg.sensors.length} sensors`, 'system');
  }

  async start() {
    await this.driver.init(this.config);
    this.log('info', `Hardware driver: ${this.driver.status.name} (${this.driver.status.detail})`, 'system');

    // Push every actuator to its configured safe state on startup.
    this.safeAll('system');

    // And push the bang-bang configuration, so the board holds the setpoints
    // this config file describes rather than whatever survived its last power
    // cycle. Nothing is enabled by this — it only means that when someone does
    // enable a side, the values it starts on are the ones on screen.
    this.bangbang.attach();
    this.bangbang.pushAll('system');

    const period = 1000 / this.config.telemetry.sampleRateHz;
    this.timer = setInterval(() => this.tick(), period);
    this.log('info', `Control loop running at ${this.config.telemetry.sampleRateHz} Hz`, 'system');
  }

  tick() {
    const now = Date.now();
    this.tickCount++;

    try {
      const fresh = this.driver.read();
      if (fresh) {
        for (const [id, value] of Object.entries(fresh)) {
          if (Number.isFinite(value)) this.readings[id] = value;
        }
      }
    } catch (err) {
      this.log('error', `Sensor read failed: ${err.message}`, 'driver');
    }

    this.bangbang.update(this.readings, now);
    this.sequencer.update(this.readings, now);
    this.recorder.sample(now, this.readings);

    const autoDisarm = this.config.safety.autoDisarmAfterSeconds;
    if (this.armed && autoDisarm > 0 && now - this.armedAt > autoDisarm * 1000 && !this.sequencer.running) {
      this.setArmed(false, 'auto-disarm timer');
    }

    const streamPeriod = 1000 / this.config.telemetry.streamRateHz;
    if (now - this.lastBroadcast >= streamPeriod) {
      this.lastBroadcast = now;
      for (const s of this.config.sensors) {
        const v = this.readings[s.id];
        if (Number.isFinite(v)) this.history.get(s.id)?.push(now, v);
      }
      this.emit('telemetry', this.snapshot());
    }
  }

  // ---------------------------------------------------------------- ARM ----

  setArmed(armed, source = 'operator') {
    armed = Boolean(armed);
    if (armed && this.abortState.active) {
      return { ok: false, error: 'Cannot ARM while the stand is in ABORT — clear the abort first' };
    }
    if (armed === this.armed) return { ok: true, armed };

    this.armed = armed;
    this.armedAt = Date.now();

    // Mirror ARM to hardware that keeps its own arm latch (the PANDA board),
    // so a disarmed stand cannot actuate even if a command somehow bypasses
    // the interlocks above. Never let a driver fault block the DISARM path.
    try {
      this.driver.setArmed?.(armed);
    } catch (err) {
      this.log('error', `Driver failed to ${armed ? 'arm' : 'disarm'}: ${err.message}`, 'driver');
      if (armed) {
        this.armed = false;
        return { ok: false, error: `Hardware arm failed: ${err.message}` };
      }
    }

    if (armed) {
      this.log('arm', '*** STAND ARMED *** — actuators are live', source);
    } else {
      this.log('arm', 'STAND DISARMED', source);
      // Disarming drops closed-loop control; it does not move valves by itself.
      this.bangbang.setAll({ enabled: false }, 'disarm');
    }
    this.emit('telemetry', this.snapshot());
    return { ok: true, armed: this.armed };
  }

  // -------------------------------------------------------------- VALVES ----

  /** Command one valve. Returns {ok, error}. Enforces all interlocks. */
  commandValve(id, state, opts = {}) {
    const valve = this.configStore.valve(id);
    if (!valve) return { ok: false, error: `Unknown valve "${id}"` };
    if (state !== 'open' && state !== 'closed') return { ok: false, error: 'state must be "open" or "closed"' };

    const source = opts.source || 'operator';
    const safeDirection = state === valve.safeState;

    // A valve the PANDA's own regulator is driving has exactly one controller,
    // and it is not this one. Sending `S<ch>` at it here would put a second
    // command source on the same solenoid with no arbitration between them —
    // the failure mode HANDOVER_COMMS.md §5.7 documents in the previous ground
    // station, where a browser loop and the firmware fought over a press
    // valve while reading two different transducers.
    //
    // `internal` paths (safeAll, abort states, startup) are exempt: they are
    // driving everything to a known state, and a board-owned valve reasserting
    // itself afterwards is visible in the heartbeat.
    if (!opts.internal) {
      const owner = this.bangbang.ownedValves().get(id);
      if (owner) {
        return {
          ok: false,
          error: `${valve.name} is driven by the board's bang-bang loop (${owner.name || owner.id}) — ` +
                 `disable that controller before commanding this valve by hand`,
        };
      }
    }

    if (!safeDirection) {
      // Steps *of the abort sequence itself* may drive valves away from their
      // safe state (a purge, say). An operator command that merely arrives
      // while that sequence runs must still be blocked, so the bypass is
      // scoped to commands issued by the sequencer, not to the time window.
      const abortSeqId = this.config.safety.abortSequenceId;
      const fromAbortSequence = opts.fromSequence && this.sequencer.active?.cfg.id === abortSeqId;
      if (this.abortState.active && !opts.fromAbort && !fromAbortSequence) {
        return { ok: false, error: 'Stand is in ABORT — clear the abort to command this valve' };
      }
      if (this.config.safety.requireArmToActuate && valve.requiresArm && !this.armed) {
        return { ok: false, error: `${valve.name} requires the stand to be ARMED` };
      }
    }

    const previous = this.valveStates[id];
    try {
      this.driver.setValve(valve, state);
    } catch (err) {
      // `quiet` callers (safeAll) aggregate failures into a single line.
      if (!opts.quiet) {
        this.log('error', `Driver failed to command ${id}: ${err.message}`, source);
      }
      return { ok: false, error: `Driver error: ${err.message}` };
    }

    this.valveStates[id] = state;
    this.valveMeta[id] = { at: Date.now(), source };

    if (previous !== state && !opts.internal) {
      this.log('command', `${valve.id} (${valve.name}) -> ${state.toUpperCase()}`, source);
    } else if (previous !== state && opts.internal) {
      this.log('control', `${valve.id} -> ${state.toUpperCase()}`, source);
    }

    // Momentary actuators (igniters, pyro) auto-revert.
    const existing = this.momentaryTimers.get(id);
    if (existing) { clearTimeout(existing); this.momentaryTimers.delete(id); }
    if (valve.momentary && state === 'open') {
      const t = setTimeout(() => {
        this.momentaryTimers.delete(id);
        this.commandValve(id, valve.safeState, { source: 'momentary-timeout' });
      }, valve.momentaryMs);
      t.unref?.();
      this.momentaryTimers.set(id, t);
    }

    this.emit('valve-change', id, state);
    return { ok: true, state };
  }

  toggleValve(id, opts = {}) {
    const current = this.valveStates[id];
    if (current === undefined) return { ok: false, error: `Unknown valve "${id}"` };
    return this.commandValve(id, current === 'open' ? 'closed' : 'open', opts);
  }

  safeAll(source = 'operator') {
    // A driver fault here fails identically for every valve, so collapse the
    // repeats into one line: thirteen copies of the same error buries the
    // rest of the startup log without adding information.
    const failures = [];
    for (const v of this.config.valves) {
      const res = this.commandValve(v.id, v.safeState, {
        source, internal: true, fromAbort: true, quiet: true,
      });
      if (!res.ok) failures.push(`${v.id}: ${res.error}`);
    }
    this.driver.safeAll?.();

    if (failures.length) {
      const distinct = [...new Set(failures.map((f) => f.split(': ').slice(1).join(': ')))];
      this.log('error',
        `SAFE STATE incomplete — ${failures.length}/${this.config.valves.length} actuators failed (${distinct.join('; ')})`,
        source);
    } else {
      this.log('command', 'ALL ACTUATORS -> SAFE STATE', source);
    }
  }

  applyAbortStates(source = 'abort') {
    for (const v of this.config.valves) {
      this.commandValve(v.id, v.abortState, { source, internal: true, fromAbort: true });
    }
  }

  // ---------------------------------------------------------------- TARE ----

  /**
   * Zero sensors against their current reading, or clear an existing zero.
   *
   *   { sensors: ['PT1','PT4'] }   zero these
   *   { kind: 'pressure' }         zero every tareable sensor of that kind
   *   { ..., clear: true }         restore them to their raw calibration
   *
   * WHY THE INTERLOCKS BELOW
   *   A tare changes what every subsequent reading MEANS. Zeroing a tank
   *   transducer that is sitting at 450 psi tells the stand it is at ambient
   *   — and anything acting on that number will then try to make it 450 psi
   *   again, on top of the pressure already there. So a tare is refused while
   *   a sequence is running, and refused for any sensor an ENABLED bang-bang
   *   controller is steering on.
   *
   *   ARM alone is not a reason to refuse. Finding a drifted zero after arming
   *   is exactly when an operator needs this, and with no controller enabled
   *   and no sequence running, a tare moves a number on a screen and in the
   *   CSV, not a valve.
   */
  tare(spec = {}, source = 'operator') {
    const tareable = this.driver.tareStatus?.() || {};
    const clear = Boolean(spec.clear);

    let ids;
    if (Array.isArray(spec.sensors) && spec.sensors.length) {
      ids = spec.sensors;
    } else if (spec.kind) {
      ids = this.config.sensors.filter((s) => s.kind === spec.kind && s.id in tareable).map((s) => s.id);
      if (!ids.length) return { ok: false, error: `No tareable ${spec.kind} sensors` };
    } else {
      return { ok: false, error: 'Specify sensors[] or kind to tare' };
    }

    const unknown = ids.filter((id) => !this.configStore.sensor(id));
    if (unknown.length) return { ok: false, error: `Unknown sensor(s): ${unknown.join(', ')}` };

    if (this.sequencer.running) {
      return { ok: false, error: 'Cannot tare while a sequence is running' };
    }
    const steered = ids.filter((id) => this.config.bangbang.some(
      (c) => c.sensor === id && this.bangbang.isLive(c.id)
    ));
    if (steered.length) {
      return {
        ok: false,
        error: `${steered.join(', ')} is under active bang-bang control — disable the controller before taring it`,
      };
    }

    const res = this.driver.tareSensors?.(ids, { clear })
      ?? { ok: false, error: `The ${this.driver.status.name} driver cannot tare sensors` };
    if (!res.ok) return res;

    if (res.unsupported?.length) {
      this.log('warn', `TARE: no hardware zero for ${res.unsupported.join(', ')}`, source);
    }
    if (res.tared?.length) {
      // Loud on purpose. Every reading and every CSV row after this line means
      // something different from the ones before it, and a trace read back
      // months later has to show where that happened.
      this.log('command',
        `*** ${clear ? 'TARE CLEARED' : 'TARE'} *** ${res.tared.length} channel(s): ${res.tared.join(', ')}`,
        source);
    } else if (!res.unsupported?.length) {
      return { ok: false, error: 'Nothing was tared' };
    }

    this.emit('telemetry', this.snapshot());
    return { ok: true, tared: res.tared || [], unsupported: res.unsupported || [] };
  }

  // --------------------------------------------------------------- ABORT ----

  abort(reason = 'Operator abort') {
    if (this.abortState.active) return { ok: true, alreadyAborted: true };

    this.abortState = { active: true, reason, at: Date.now() };
    this.log('abort', `*** ABORT *** ${reason}`, 'system');

    this.bangbang.setAll({ enabled: false }, 'abort');
    if (this.sequencer.running) this.sequencer.stop('abort', 'abort');

    const abortSeqId = this.config.safety.abortSequenceId;
    const abortSeq = abortSeqId && this.configStore.sequence(abortSeqId);
    if (abortSeq) {
      const res = this.sequencer.start(abortSeqId, 'abort');
      if (!res.ok) {
        this.log('error', `Abort sequence failed to start (${res.error}) — applying abort states directly`, 'abort');
        this.applyAbortStates();
      }
    } else {
      this.applyAbortStates();
    }

    this.emit('telemetry', this.snapshot());
    return { ok: true };
  }

  clearAbort(source = 'operator') {
    if (!this.abortState.active) return { ok: false, error: 'No active abort' };
    this.abortState = { active: false, reason: null, at: 0 };
    this.armed = false;
    this.log('arm', 'Abort cleared — stand is DISARMED', source);
    this.emit('telemetry', this.snapshot());
    return { ok: true };
  }

  // --------------------------------------------------------------- EVENTS ----

  log(level, message, source = 'system') {
    const entry = { seq: ++this.eventSeq, t: Date.now(), level, message, source };
    this.events.push(entry);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.recorder.noteEvent(`[${level}] ${message}`);
    this.emit('event', entry);
    const stamp = new Date(entry.t).toISOString().slice(11, 23);
    console.log(`${stamp} [${level.padEnd(8)}] ${message}${source ? `  (${source})` : ''}`);
    return entry;
  }

  // ------------------------------------------------------------ SNAPSHOT ----

  snapshot() {
    // A `tare` field means the hardware can zero this channel; its value is
    // how much is currently being subtracted. The UI needs both — a tared
    // channel reading 0 psi looks exactly like an untared one until you say
    // so, and offering a Tare button on a sensor no device can zero would be
    // a button that does nothing.
    const tares = this.driver.tareStatus?.() || {};

    const sensors = {};
    for (const s of this.config.sensors) {
      const v = this.readings[s.id];
      sensors[s.id] = {
        v: Number.isFinite(v) ? Number(v.toFixed(4)) : null,
        status: sensorStatus(s, v),
      };
      if (Number.isFinite(tares[s.id])) sensors[s.id].tare = Number(tares[s.id].toFixed(4));
    }

    // Current sense, where the hardware measures it: confirms a coil actually
    // drew current, which a commanded state alone cannot tell you.
    const dc = this.driver.dcStatus?.() || {};

    const valves = {};
    for (const v of this.config.valves) {
      valves[v.id] = { state: this.valveStates[v.id], at: this.valveMeta[v.id]?.at, source: this.valveMeta[v.id]?.source };
      if (dc[v.id]) valves[v.id].dc = dc[v.id];
    }

    return {
      t: Date.now(),
      armed: this.armed,
      armedAt: this.armedAt,
      abort: this.abortState,
      driver: driverStatus(this.driver),
      valves,
      sensors,
      controllers: this.bangbang.snapshot(),
      sequence: this.sequencer.snapshot(),
      recording: this.recorder.snapshot(),
      eventSeq: this.eventSeq,
      configVersion: this.config.meta.configVersion,
    };
  }

  historySnapshot() {
    const out = {};
    for (const [id, ring] of this.history) out[id] = ring.toArrays();
    return out;
  }

  async shutdown() {
    clearInterval(this.timer);
    for (const t of this.momentaryTimers.values()) clearTimeout(t);
    if (this.recorder.active) this.recorder.stop('server shutdown', 'system');
    this.safeAll('shutdown');
    await this.driver.close?.();
  }
}

/**
 * Driver status with a `devices` list the UI can always rely on.
 *
 * Composite drivers report one entry per box (nidaq, panda); everything else
 * is a single device. Normalizing here means the header renders link
 * indicators the same way whether the stand is running on real hardware or on
 * the simulator, instead of branching on driver name.
 */
function driverStatus(driver) {
  const status = driver.status;
  if (Array.isArray(status.devices)) return status;
  return {
    ...status,
    devices: [{
      key: status.name,
      name: status.name,
      connected: Boolean(status.connected),
      required: true,
      failed: false,
      lastRxAt: status.lastRxAt ?? 0,
      detail: status.detail,
    }],
  };
}

/** 'ok' | 'warn' | 'danger' | 'stale' */
function sensorStatus(sensor, value) {
  if (!Number.isFinite(value)) return 'stale';
  if (sensor.dangerHigh != null && value >= sensor.dangerHigh) return 'danger';
  if (sensor.dangerLow != null && value <= sensor.dangerLow) return 'danger';
  if (sensor.warnHigh != null && value >= sensor.warnHigh) return 'warn';
  if (sensor.warnLow != null && value <= sensor.warnLow) return 'warn';
  return 'ok';
}

class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
    this.count = 0;
    this.head = 0;
  }
  push(t, v) {
    this.times[this.head] = t;
    this.values[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  toArrays() {
    const t = new Array(this.count);
    const v = new Array(this.count);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      t[i] = this.times[idx];
      v[i] = Number(this.values[idx].toFixed(4));
    }
    return { t, v };
  }
}
