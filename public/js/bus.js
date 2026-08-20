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

  valveState(id) { return this.state?.valves?.[id]?.state ?? 'closed'; }
  reading(id) { return this.state?.sensors?.[id]?.v ?? null; }
  sensorStatus(id) { return this.state?.sensors?.[id]?.status ?? 'stale'; }

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
