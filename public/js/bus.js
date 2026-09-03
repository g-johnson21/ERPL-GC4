/* bus.js — the single client-side connection to the stand.
 *
 * Owns: config, live state, rolling sensor history, event log, SSE link.
 * Every page imports this one module; nothing else talks to the network.
 *
 * The server is always the authority. This module never predicts state — it
 * only renders what the server last reported, so a rejected command can never
 * leave the UI showing a valve position that isn't real.
 */
import { toast } from './util.js';

class Bus {
  constructor() {
    this.config = null;
    this.state = null;
    this.history = new Map();   // sensorId -> { t: [], v: [] }
    this.events = [];
    this.connected = false;
    this.listeners = new Map();
    this.historyLimit = 2000;
  }

  // ----------------------------------------------------------- lifecycle --

  async init() {
    this.config = await fetch('/api/config').then((r) => r.json());

    const limitSeconds = Math.max(this.config.ui.sparklineSeconds || 60, 120);
    this.historyLimit = Math.ceil(limitSeconds * (this.config.telemetry.streamRateHz || 20));

    try {
      const hist = await fetch('/api/history').then((r) => r.json());
      for (const [id, series] of Object.entries(hist)) {
        this.history.set(id, { t: series.t, v: series.v });
      }
    } catch { /* history is a nicety, not a requirement */ }

    try {
      this.events = await fetch('/api/events').then((r) => r.json());
    } catch { this.events = []; }

    this.state = await fetch('/api/state').then((r) => r.json());
    // That fetch returning is proof the server is reachable, so start
    // connected rather than waiting for the EventSource to open. Otherwise
    // every page load flashes LINK LOST beside the hardware link indicators
    // for a frame or two, which is exactly how an operator learns to ignore a
    // red chip that means something.
    this.connected = true;
    this.applyAccent();
    this.connect();
    this.emit('config', this.config);
    this.emit('state', this.state);
    this.emit('events', this.events);
    return this;
  }

  applyAccent() {
    const accent = this.config?.ui?.accent;
    if (accent) {
      document.documentElement.style.setProperty('--accent', accent);
      document.documentElement.style.setProperty('--accent-ink', contrastInk(accent));
    }
  }

  connect() {
    if (this.source) this.source.close();
    const source = new EventSource('/api/stream');
    this.source = source;

    source.addEventListener('open', () => {
      if (!this.connected) {
        this.connected = true;
        this.emit('connection', true);
      }
    });

    source.addEventListener('state', (e) => {
      if (!this.connected) { this.connected = true; this.emit('connection', true); }
      const snap = JSON.parse(e.data);
      this.state = snap;
      this.pushHistory(snap);
      this.emit('state', snap);
    });

    source.addEventListener('log', (e) => {
      const entry = JSON.parse(e.data);
      this.events.push(entry);
      if (this.events.length > 600) this.events.splice(0, this.events.length - 600);
      this.emit('log', entry);
    });

    source.addEventListener('config', async () => {
      this.config = await fetch('/api/config').then((r) => r.json());
      this.applyAccent();
      this.emit('config', this.config);
      // A full reload is the honest way to pick up new valves, sensors or a
      // redrawn P&ID: every page builds its DOM from config exactly once.
      //
      // Not while the stand is armed, though. The server only accepts
      // autosequence edits in that state, so nothing structural can have
      // changed, and the listeners above have already taken the new sequence
      // list. Reloading a control screen during a live test would be all cost
      // and no benefit.
      if (this.state?.armed) {
        toast('Autosequences updated', 'info', 2500);
        return;
      }
      toast('Configuration reloaded — reloading page', 'info', 2000);
      setTimeout(() => location.reload(), 1200);
    });

    source.addEventListener('error', () => {
      // EventSource retries on its own; just reflect the outage in the UI.
      if (this.connected) {
        this.connected = false;
        this.emit('connection', false);
      }
    });
  }

  pushHistory(snap) {
    for (const [id, reading] of Object.entries(snap.sensors || {})) {
      if (reading.v === null) continue;
      let series = this.history.get(id);
      if (!series) { series = { t: [], v: [] }; this.history.set(id, series); }
      series.t.push(snap.t);
      series.v.push(reading.v);
      if (series.t.length > this.historyLimit) {
        const drop = series.t.length - this.historyLimit;
        series.t.splice(0, drop);
        series.v.splice(0, drop);
      }
    }
  }

  // -------------------------------------------------------------- events --

  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name)?.delete(fn);
  }

  emit(name, payload) {
    for (const fn of this.listeners.get(name) || []) {
      try { fn(payload); } catch (err) { console.error(`[bus] listener for "${name}" failed:`, err); }
    }
  }

  // ------------------------------------------------------------ commands --

  async post(path, body = {}) {
    let json;
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      json = await res.json();
    } catch (err) {
      toast(`Command failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
    // The server returns a fresh snapshot with every command, so the UI
    // reflects the true post-command state without waiting for a frame.
    if (json.state) { this.state = json.state; this.emit('state', json.state); }
    if (!json.ok && json.error) toast(json.error, 'error', 6000);
    return json;
  }

  setArmed(armed) { return this.post('/api/arm', { armed }); }
  abort(reason) { return this.post('/api/abort', { reason }); }
  clearAbort() { return this.post('/api/abort/clear'); }
  commandValve(id, state) { return this.post('/api/valve', { id, state }); }
  toggleValve(id) { return this.post('/api/valve', { id, toggle: true }); }
  safeAll() { return this.post('/api/safe-all'); }
  /** Zero sensors against their current reading; `clear` restores them. */
  tareSensors(sensors, { clear = false } = {}) { return this.post('/api/tare', { sensors, clear }); }
  tareKind(kind, { clear = false } = {}) { return this.post('/api/tare', { kind, clear }); }
  /** Zero the P&ID tank levels. Separate from sensor tares — see state.js. */
  tareTankLevels(tanks, { clear = false } = {}) {
    return this.post('/api/tank-level/tare', { tanks, clear });
  }
  /** psi currently subtracted from one tank's head, 0 when untared. */
  tankLevelTare(id) { return Number(this.state?.tankLevelTares?.[id]) || 0; }
  setController(id, patch) { return this.post('/api/controller', { id, ...patch }); }
  startSequence(id) { return this.post('/api/sequence/start', { id }); }
  stopSequence() { return this.post('/api/sequence/stop'); }
  startRecording(name) { return this.post('/api/record/start', { name }); }
  stopRecording() { return this.post('/api/record/stop'); }
  listRecordings() { return fetch('/api/record/list').then((r) => r.json()); }

  // ------------------------------------------------------------- lookups --

  valve(id) { return this.config.valves.find((v) => v.id === id); }
  sensor(id) { return this.config.sensors.find((s) => s.id === id); }
  controller(id) { return this.config.bangbang.find((c) => c.id === id); }
  group(id) { return this.config.valveGroups.find((g) => g.id === id); }

  /**
   * Sensor groups in display order, each with its members.
   *
   * A group a sensor names but the config never defined is synthesized rather
   * than dropped — the same forgiveness the Control Grid gives valve groups.
   * Since `group` defaults to `kind`, a config that predates sensorGroups
   * still comes back grouped by type.
   */
  sensorGroups() {
    const defined = this.config.sensorGroups || [];
    const groups = defined.map((g) => ({ ...g, sensors: [] }));
    const byId = new Map(groups.map((g) => [g.id, g]));

    for (const sensor of this.config.sensors) {
      let group = byId.get(sensor.group);
      if (!group) {
        group = { id: sensor.group, label: sensor.group || 'Other', color: '#64748b', sensors: [] };
        byId.set(group.id, group);
        groups.push(group);
      }
      group.sensors.push(sensor);
    }
    return groups.filter((g) => g.sensors.length);
  }

  /** The group one sensor belongs to, colour included. */
  sensorGroup(id) {
    const sensor = this.sensor(id);
    if (!sensor) return null;
    return (this.config.sensorGroups || []).find((g) => g.id === sensor.group)
      || { id: sensor.group, label: sensor.group || 'Other', color: '#64748b' };
  }

  /**
   * Rate of change in units per second, or null when there is not enough
   * history to say.
   *
   * A least-squares slope over the window rather than (last − first) / dt: a
   * two-point difference on a noisy transducer is mostly noise, and on a PT
   * with a 10 000 psi span the noise is tens of psi. The fit uses every sample
   * in the window, so it reports the trend instead of the last two jitters.
   */
  rate(id, seconds = 3) {
    const series = this.history.get(id);
    if (!series || series.t.length < 4) return null;

    const cutoff = Date.now() - seconds * 1000;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = series.t.length - 1; i >= 0; i--) {
      const t = series.t[i];
      if (t < cutoff) break;
      // Seconds relative to the window start: small numbers keep the sums
      // well conditioned, which epoch milliseconds squared would not.
      const x = (t - cutoff) / 1000;
      const y = series.v[i];
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    if (n < 4) return null;

    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return null;   // every sample at one instant
    return (n * sxy - sx * sy) / denom;
  }

  valveState(id) { return this.state?.valves?.[id]?.state ?? 'closed'; }
  reading(id) { return this.state?.sensors?.[id]?.v ?? null; }
  sensorStatus(id) { return this.state?.sensors?.[id]?.status ?? 'stale'; }

  /**
   * Current tare offset, or null when no device can zero this sensor.
   *
   * The distinction matters: null means "no Tare button belongs here", 0
   * means "tareable, currently untared".
   */
  tare(id) {
    const t = this.state?.sensors?.[id]?.tare;
    return Number.isFinite(t) ? t : null;
  }
  canTare(id) { return this.tare(id) !== null; }

  /** Is this valve currently commandable? Mirrors the server's interlocks. */
  canCommand(valveId, toState) {
    const valve = this.valve(valveId);
    if (!valve || !this.state) return { ok: false, reason: 'No state' };
    if (toState === valve.safeState) return { ok: true };
    if (this.state.abort.active) return { ok: false, reason: 'Stand is in ABORT' };
    if (this.config.safety.requireArmToActuate && valve.requiresArm && !this.state.armed) {
      return { ok: false, reason: 'Requires ARM' };
    }
    return { ok: true };
  }
}

function contrastInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Perceived luminance — dark ink on light accents, white on dark ones.
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#10151c' : '#ffffff';
}

export const bus = new Bus();
