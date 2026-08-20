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
      this.log('error', `Driver failed to command ${id}: ${err.message}`, source);
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
    for (const v of this.config.valves) {
      this.commandValve(v.id, v.safeState, { source, internal: true, fromAbort: true });
    }
    this.driver.safeAll?.();
    this.log('command', 'ALL ACTUATORS -> SAFE STATE', source);
  }

  applyAbortStates(source = 'abort') {
    for (const v of this.config.valves) {
      this.commandValve(v.id, v.abortState, { source, internal: true, fromAbort: true });
    }
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
    const sensors = {};
    for (const s of this.config.sensors) {
      const v = this.readings[s.id];
      sensors[s.id] = {
        v: Number.isFinite(v) ? Number(v.toFixed(4)) : null,
        status: sensorStatus(s, v),
      };
    }

    const valves = {};
    for (const v of this.config.valves) {
      valves[v.id] = { state: this.valveStates[v.id], at: this.valveMeta[v.id]?.at, source: this.valveMeta[v.id]?.source };
    }

    return {
      t: Date.now(),
      armed: this.armed,
      armedAt: this.armedAt,
      abort: this.abortState,
      driver: this.driver.status,
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
