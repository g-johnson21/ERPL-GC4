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

  /**
   * True when this page was served by the read-only spectator port.
   *
   * The server is what actually enforces it — the spectator listener has no
   * mutating routes to reach. This flag exists so the UI does not offer
   * controls whose only possible outcome is a rejection.
   */
  get spectator() { return this.config?.ui?.spectator === true; }

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

    source.addEventListener('config', async (e) => {
      // What moved, as the server computed it. An older server, or anything
      // that cannot say, is treated as structural: the safe answer to "can
      // this screen keep its DOM?" is no.
      let note = {};
      try { note = JSON.parse(e.data) || {}; } catch { /* treated as structural */ }
      const inPlace = note.inPlace === true;
      const changed = Array.isArray(note.changed) ? note.changed : [];

      this.config = await fetch('/api/config').then((r) => r.json());
      this.applyAccent();
      this.emit('config', this.config);

      // Autosequences alone are taken in place: the listeners above have
      // already rebuilt the sequence list, and reloading a control screen for
      // a retimed countdown would be all cost and no benefit.
      //
      // An empty `changed` is the same case and not the same message. The
      // Config page PUTs the whole document every time, so saving with nothing
      // edited is an ordinary thing to do, and answering it with "autosequences
      // updated" tells the operator something happened that did not.
      if (inPlace) {
        toast(changed.length ? 'Autosequences updated' : 'Configuration saved — no changes',
          'info', 2500);
        return;
      }

      // Anything else and this page is now lying. Every page builds its DOM
      // from config exactly once, so a changed valve list, calibration or P&ID
      // leaves buttons and readings on screen that no longer mean what they
      // say — and a button whose label has quietly stopped matching the valve
      // it commands is the worst thing this screen can show.
      //
      // So it reloads even while ARMED, which the stand used to make
      // impossible by refusing the save. The reload costs about a second of
      // visibility and nothing else: the server is the authority, valve states
      // live there and survive it. A stale screen costs whatever the operator
      // does next. Armed, it gets a louder warning and longer to land, so it
      // is not a surprise in the middle of a command.
      const armed = this.state?.armed;
      const what = changed.length ? ` — ${changed.join(', ')}` : '';
      if (armed) {
        toast(`CONFIG CHANGED WHILE ARMED${what} — reloading this screen`, 'warn', 6000);
      } else {
        toast(`Configuration reloaded${what} — reloading page`, 'info', 2000);
      }
      setTimeout(() => location.reload(), armed ? 3500 : 1200);
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
      this.pushSample(snap.t, id, reading.v);
    }
    // The boards' own transducers arrive on the heartbeat rather than in
    // `sensors`, but every screen draws them with the same sparkline, rate and
    // window min/max as a DAQ channel -- and all three read from here.
    for (const bs of this.boardSensors()) {
      this.pushSample(snap.t, bs.id, this.boardPressure(bs, snap));
    }
  }

  pushSample(t, id, value) {
    if (!Number.isFinite(value)) return;
    let series = this.history.get(id);
    if (!series) { series = { t: [], v: [] }; this.history.set(id, series); }
    series.t.push(t);
    series.v.push(value);
    if (series.t.length > this.historyLimit) {
      const drop = series.t.length - this.historyLimit;
      series.t.splice(0, drop);
      series.v.splice(0, drop);
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
    // A spectator page has no control that reaches this, so getting here means
    // something slipped through — a hotkey, a stale listener. Refuse locally
    // and say so plainly, rather than send a command the server will reject
    // anyway and leave the viewer wondering whether it took.
    if (this.spectator) {
      toast('Spectator view — this screen cannot command the stand', 'warn', 4000);
      return { ok: false, error: 'Spectator view is read-only' };
    }

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
  /**
   * Simulator-only controls: the hand valves and regulators a person at the
   * pad would turn. `sim` is null on hardware, and every screen that offers
   * these checks it first.
   */
  get sim() { return this.state?.sim ?? null; }
  simToggleValve(id) { return this.post('/api/sim/valve', { id, toggle: true }); }
  simSetValve(id, state) { return this.post('/api/sim/valve', { id, state }); }
  simSetRegulator(id, psi) { return this.post('/api/sim/regulator', { id, psi }); }
  startRecording(name) { return this.post('/api/record/start', { name }); }
  stopRecording() { return this.post('/api/record/stop'); }
  listRecordings() { return fetch('/api/record/list').then((r) => r.json()); }

  // ------------------------------------------------------------- lookups --

  valve(id) { return this.config.valves.find((v) => v.id === id); }
  sensor(id) { return this.config.sensors.find((s) => s.id === id); }
  controller(id) { return this.config.bangbang.find((c) => c.id === id); }
  group(id) { return this.config.valveGroups.find((g) => g.id === id); }

  // ------------------------------------------------- board transducers --

  /**
   * The bang-bang boards' own transducers, shaped like sensors.
   *
   * These are the PTs the regulator actually runs on, and until now they were
   * visible only on the bang-bang card — so the one number the loop acts on
   * was the one number missing from the screen that shows every instrument.
   *
   * They are NOT `config.sensors` and must never be added to it: there is no
   * DAQ channel behind them, they are absent from the recorded CSV, their zero
   * lives in the board's EEPROM, and the config editor round-trips
   * `config.sensors` back into stand.json. They are declared on the controller
   * that owns them (`bangbang[].boardSensor`) and assembled here.
   *
   * Rebuilt only when the config object itself changes — this is on the path
   * of every telemetry frame.
   */
  boardSensors() {
    if (this.boardSensorsFor !== this.config) {
      this.boardSensorsFor = this.config;
      this.boardSensorList = (this.config?.bangbang || [])
        .filter((c) => c.boardSensor?.id)
        .map((c) => ({ ...c.boardSensor, board: true, controller: c.id, side: c.side }));
      this.boardSensorById = new Map(this.boardSensorList.map((s) => [s.id, s]));
    }
    return this.boardSensorList;
  }

  /** One board transducer by tag, or null when the tag is a DAQ channel. */
  boardSensor(id) {
    this.boardSensors();
    return this.boardSensorById.get(id) || null;
  }

  /**
   * What a board says its transducer reads, or null.
   *
   * A stale heartbeat reads null rather than the last number seen. The board
   * keeps regulating when the link drops, so a held pressure is not a
   * measurement — it is where the tank was when we stopped being told. The
   * bang-bang card makes the same call for the same reason.
   */
  boardPressure(bs, snap = this.state) {
    const board = snap?.controllers?.[bs.controller]?.board;
    if (!board || board.stale || !Number.isFinite(board.pressure)) return null;
    return board.pressure;
  }

  /**
   * Sensor groups in display order, each with its members.
   *
   * A group a sensor names but the config never defined is synthesized rather
   * than dropped — the same forgiveness the Control Grid gives valve groups.
   * Since `group` defaults to `kind`, a config that predates sensorGroups
   * still comes back grouped by type.
   *
   * The boards' own transducers are folded in here rather than appended, so
   * every screen that groups sensors gets them in the right place without
   * knowing they are different.
   */
  sensorGroups() {
    const defined = this.config.sensorGroups || [];
    const groups = defined.map((g) => ({ ...g, sensors: [] }));
    const byId = new Map(groups.map((g) => [g.id, g]));

    const groupFor = (id) => {
      let group = byId.get(id);
      if (!group) {
        group = { id, label: id || 'Other', color: '#64748b', sensors: [] };
        byId.set(group.id, group);
        groups.push(group);
      }
      return group;
    };

    for (const sensor of this.config.sensors) groupFor(sensor.group).sensors.push(sensor);
    for (const bs of this.boardSensors()) {
      const members = groupFor(bs.group).sensors;
      members.splice(tagSlot(members, bs.id), 0, bs);
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

  reading(id) {
    const bs = this.boardSensor(id);
    return bs ? this.boardPressure(bs) : (this.state?.sensors?.[id]?.v ?? null);
  }

  /**
   * ok / warn / danger / stale.
   *
   * The server does this for every DAQ channel and ships the answer in the
   * snapshot. It does not do it for a board transducer — that pressure reaches
   * the snapshot inside `controllers`, not `sensors` — so the same thresholds
   * are applied here, against the same fields.
   */
  sensorStatus(id) {
    const bs = this.boardSensor(id);
    if (!bs) return this.state?.sensors?.[id]?.status ?? 'stale';

    const v = this.boardPressure(bs);
    if (!Number.isFinite(v)) return 'stale';
    if (bs.dangerHigh != null && v >= bs.dangerHigh) return 'danger';
    if (bs.dangerLow != null && v <= bs.dangerLow) return 'danger';
    if (bs.warnHigh != null && v >= bs.warnHigh) return 'warn';
    if (bs.warnLow != null && v <= bs.warnLow) return 'warn';
    return 'ok';
  }

  /**
   * Current tare offset, or null when no device can zero this sensor.
   *
   * The distinction matters: null means "no Tare button belongs here", 0
   * means "tareable, currently untared".
   */
  tare(id) {
    // A board transducer is zeroed from its bang-bang card, against the
    // board's own EEPROM, and only while that side is not regulating. Nothing
    // on the Data page may reach it, so it reports no offset and therefore
    // grows no Tare button.
    if (this.boardSensor(id)) return null;
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

/**
 * Where a tag belongs in a group that is ordered by plumbing, not by number.
 *
 * The LOX column runs PT1, PT2, PT4, PT21, PT22, PT5 — the order fluid reaches
 * them, which is what an operator reads down. Sorting the column numerically
 * to place one new tag would rewrite that. Instead the tag goes before the
 * first member of its own family that outranks it, so PT3 lands between PT2
 * and PT4 and nothing else moves. A tag that outranks everything, or that has
 * no numbered family in the column, goes last.
 */
function tagSlot(members, id) {
  const me = tagNumber(id);
  if (!me) return members.length;
  for (let i = 0; i < members.length; i++) {
    const other = tagNumber(members[i].id);
    if (other && other.prefix === me.prefix && other.n > me.n) return i;
  }
  return members.length;
}

function tagNumber(id) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(id || '');
  return m ? { prefix: m[1].toUpperCase(), n: Number(m[2]) } : null;
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
