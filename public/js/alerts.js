/* alerts.js — PT and valve alerts along the bottom of the control screens.
 *
 * Two kinds of alert share one tray:
 *
 *   PT       a pressure sensor outside its own thresholds, the same fields that
 *            already colour its tile and card: warnLow/warnHigh raise a MINOR
 *            alert (yellow), dangerLow/dangerHigh a MAJOR one (flashing red).
 *            The boards' own transducers are watched too.
 *
 *   VALVE    a custom rule in `alerts.valves`: "raise a MAJOR alert when
 *            LOX-VENT has been OPEN for more than 120 s". A rule may watch a
 *            valve open, closed, or under bang-bang. Several rules on the same
 *            valve and state (a minor at 60 s, a major at 300 s) are one alert
 *            that escalates, not two rows.
 *
 * Both are edited on the Config page's Alerts tab and applied live, without
 * reloading this screen.
 *
 * What the tray is NOT is an interlock. Nothing here moves a valve or trips an
 * abort — the stand's trips live on the server (abortAbove, sequence abort
 * conditions). This is the thing that makes sure a human has noticed.
 *
 * MUTE is stand-wide and lives on the server, so muting from the P&ID still
 * holds after switching to the Control Grid, and on every other station. A
 * muted tray collapses to one line that still counts what is active: muting
 * silences the alarm, it does not blind the operator. Each alert can also be
 * dismissed on its own; a dismissed alert comes back if it escalates.
 */
import { bus } from './bus.js';
import { el, clear, fmtValue, fmtElapsed } from './util.js';

/**
 * How long a channel has to read in bounds before its alert is dropped. A PT
 * sitting on a threshold jitters across it several times a second, and a tray
 * that blinks rows in and out at that rate is unreadable exactly when it
 * matters. Valve alerts clear at once: a valve does not jitter.
 */
const CLEAR_HOLD_MS = 1500;

/** Rows shown before the rest are summarised as "+N more". */
const MAX_ROWS = 5;

const RANK = { minor: 1, major: 2 };

/** What a valve rule's `state` means, as a row prints it. */
export const VALVE_ALERT_STATES = { open: 'OPEN', closed: 'CLOSED', bb: 'BANG-BANG' };

/**
 * key -> { key, kind, level, since, okSince, dismissed, ... }
 *   PT:    key `pt:<sensor id>`, plus { sensor, bound, stale }
 *   valve: key `valve:<valve id>:<state>`, plus { valve, state, rule, heldMs }
 */
const active = new Map();
let tray = null;

export function mountAlerts(content) {
  tray = el('div.alert-tray#alert-tray', { role: 'alert', 'aria-live': 'assertive', hidden: true });
  document.body.append(tray);

  // Centred over the page's own content, not the window, so the tray never
  // lands on the control sidebar.
  const place = () => {
    const r = content.getBoundingClientRect();
    tray.style.left = `${r.left + r.width / 2}px`;
    tray.style.maxWidth = `${Math.max(280, r.width - 32)}px`;
  };
  new ResizeObserver(place).observe(content);
  window.addEventListener('resize', place);
  place();

  bus.on('state', evaluate);
  // Durations keep counting between frames, and after they stop arriving —
  // and a valve rule has to come due on time even if no frame lands on it.
  setInterval(evaluate, 500);
  armAudio();
  evaluate();
}

// ------------------------------------------------------------- evaluation --

/** Every transducer an alert can be raised on: PTs with at least one bound. */
function watched() {
  const hasBound = (s) => [s.warnLow, s.warnHigh, s.dangerLow, s.dangerHigh].some((v) => Number.isFinite(v));
  return [
    ...bus.config.sensors.filter((s) => s.kind === 'pressure'),
    ...bus.boardSensors().filter((s) => (s.kind ?? 'pressure') === 'pressure'),
  ].filter(hasBound);
}

function evaluate() {
  if (!bus.state || !tray) return;
  if (bus.config.alerts?.enabled === false) {
    active.clear();
    render();
    return;
  }

  const now = Date.now();
  const seen = new Set();
  evaluateSensors(now, seen);
  evaluateValves(now, seen);

  // A sensor whose bounds were removed, a rule that was deleted, or anything
  // that left the config, takes its alert with it.
  for (const key of active.keys()) if (!seen.has(key)) active.delete(key);

  // Honoured only while this page is just loaded; after that a new alert is
  // a new alert.
  if (carried.size && now - loadedAt > CARRY_MAX_AGE_MS) carried.clear();
  persist(now);
  render();
}

/** Raise, escalate or refresh an alert. `since` defaults to now. */
function raise(key, level, fields, since) {
  const a = active.get(key);
  if (!a) {
    // Carried over from the page this station was on a moment ago, so
    // switching from the Grid to the P&ID does not restart "for 3m 10s" or
    // bring back what the operator already dismissed.
    const prior = carried.get(key);
    active.set(key, {
      key, level, okSince: null, ...fields,
      since: since ?? prior?.since ?? Date.now(),
      dismissed: prior && RANK[prior.dismissed] >= RANK[level] ? prior.dismissed : null,
    });
    return;
  }
  Object.assign(a, fields);
  a.okSince = null;
  if (level !== a.level) {
    a.level = level;
    // Escalation brings a dismissed alert back; easing off does not.
    if (a.dismissed && RANK[level] > RANK[a.dismissed]) a.dismissed = null;
  }
}

function evaluateSensors(now, seen) {
  for (const sensor of watched()) {
    const key = `pt:${sensor.id}`;
    seen.add(key);
    const status = bus.sensorStatus(sensor.id);
    const level = status === 'danger' ? 'major' : status === 'warn' ? 'minor' : null;
    const a = active.get(key);

    if (level) {
      raise(key, level, { kind: 'pt', sensor, bound: crossed(sensor, bus.reading(sensor.id)), stale: false });
    } else if (a) {
      // A stale channel is not back in bounds — it is not saying anything.
      // The link alert under the header covers that; the row stays as it was.
      if (status === 'stale') { a.stale = true; continue; }
      a.stale = false;
      a.okSince ??= now;
      if (now - a.okSince >= CLEAR_HOLD_MS) active.delete(key);
    }
  }
}

/**
 * The valve rules. Each (valve, state) pair is one alert: of the rules on it
 * whose time is up, the most severe wins.
 *
 * "How long" is measured on the server's clock from when the valve entered
 * the state (`at`, or `bbSince` for bang-bang), so a rule comes due at the
 * same moment on every station, and an alert raised before a page load
 * resumes with the right age after it.
 */
function evaluateValves(now, seen) {
  const groups = new Map();
  for (const rule of bus.config.alerts?.valves || []) {
    if (rule?.enabled === false || !bus.valve(rule.valve) || !VALVE_ALERT_STATES[rule.state]) continue;
    const key = `valve:${rule.valve}:${rule.state}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }

  for (const [key, rules] of groups) {
    seen.add(key);
    const { valve: valveId, state } = rules[0];
    const held = heldFor(valveId, state);
    const limit = (r) => Math.max(0, Number(r.afterSeconds) || 0) * 1000;

    const due = held === null ? [] : rules.filter((r) => held >= limit(r));
    if (!due.length) { active.delete(key); continue; }

    const rank = (r) => RANK[r.level] || RANK.minor;
    const rule = due.reduce((best, r) => (rank(r) > rank(best)
      || (rank(r) === rank(best) && limit(r) > limit(best)) ? r : best));
    // Aged from the moment the FIRST rule on this pair came due, not from
    // this frame, so the row reads right after a reload.
    const firstDue = Math.min(...due.map(limit));
    // The winning rule's message, or — if it has none — the latest one that
    // does, so escalating to a bare major rule does not drop the instruction
    // the minor one carried.
    const message = rule.message
      || [...due].sort((a, b) => limit(b) - limit(a)).find((r) => r.message)?.message
      || '';
    raise(key, RANK[rule.level] ? rule.level : 'minor',
      { kind: 'valve', valve: bus.valve(valveId), state, rule, message, heldMs: held },
      now - (held - firstDue));
  }
}

/** How long a valve has been in `state`, in ms, or null if it is not in it. */
function heldFor(valveId, state) {
  const v = bus.state?.valves?.[valveId];
  if (!v) return null;
  const owned = Boolean(bus.valveOwner(valveId));
  if (state === 'bb') return owned ? bus.sinceServer(v.bbSince) : null;
  // A valve under bang-bang is in neither position as far as GC knows.
  if (owned || v.state !== state) return null;
  return bus.sinceServer(v.at);
}

// --------------------------------------------------- across page loads --

/**
 * Every page here is its own load, so the tray's memory would otherwise end
 * at each navigation. Kept in sessionStorage: this tab, this session, and
 * only honoured if written in the last few seconds — an alert remembered from
 * an hour ago is not the alert that is active now.
 */
const CARRY_KEY = 'gc4-alerts';
const CARRY_MAX_AGE_MS = 5000;
const loadedAt = Date.now();
const carried = (() => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CARRY_KEY) || 'null');
    if (!saved || Date.now() - saved.at > CARRY_MAX_AGE_MS) return new Map();
    return new Map(Object.entries(saved.alerts || {}));
  } catch { return new Map(); }
})();

let persistedAt = 0;
function persist(now) {
  if (now - persistedAt < 500) return;
  persistedAt = now;
  const alerts = {};
  for (const [key, a] of active) alerts[key] = { since: a.since, dismissed: a.dismissed };
  try { sessionStorage.setItem(CARRY_KEY, JSON.stringify({ at: now, alerts })); } catch { /* ignore */ }
}

/** Which bound is crossed, for the row: { dir: 'HIGH'|'LOW', limit }. */
function crossed(s, v) {
  if (!Number.isFinite(v)) return null;
  if (Number.isFinite(s.dangerHigh) && v >= s.dangerHigh) return { dir: 'HIGH', limit: s.dangerHigh };
  if (Number.isFinite(s.dangerLow) && v <= s.dangerLow) return { dir: 'LOW', limit: s.dangerLow };
  if (Number.isFinite(s.warnHigh) && v >= s.warnHigh) return { dir: 'HIGH', limit: s.warnHigh };
  if (Number.isFinite(s.warnLow) && v <= s.warnLow) return { dir: 'LOW', limit: s.warnLow };
  return null;
}

// ---------------------------------------------------------------- render --

function render() {
  if (!tray) return;
  const muted = Boolean(bus.state?.alerts?.muted);
  const all = [...active.values()].sort((a, b) => RANK[b.level] - RANK[a.level] || a.since - b.since);
  const shown = all.filter((a) => !a.dismissed || RANK[a.level] > RANK[a.dismissed]);
  const majors = all.filter((a) => a.level === 'major').length;

  const mode = !all.length ? 'none' : muted ? 'muted' : shown.length ? 'open' : 'dismissed';
  tray.hidden = mode === 'none';
  tray.dataset.mode = mode;
  tray.dataset.level = majors ? 'major' : 'minor';
  alarm(mode === 'open' && shown.some((a) => a.level === 'major'));
  if (mode === 'none') { tray.dataset.sig = ''; return; }

  // Rebuilt only when the SET of rows changes, so a flashing row is not
  // restarted on every telemetry frame; the text inside is updated in place.
  const rows = mode === 'open' ? shown.slice(0, MAX_ROWS) : [];
  const sig = `${mode}|${muted}|${rows.map((a) => `${a.key}:${a.level}`).join(',')}|${all.length}`;
  if (tray.dataset.sig !== sig) {
    tray.dataset.sig = sig;
    clear(tray);
    tray.append(head(mode, all, shown, majors));
    for (const a of rows) tray.append(row(a));
    const more = mode === 'open' ? shown.length - rows.length : 0;
    if (more > 0) tray.append(el('div.alert-more', { text: `+${more} more active` }));
  }

  updateHead(mode, all, shown, majors);
  for (const a of rows) updateRow(a);
}

function head(mode, all, shown, majors) {
  const canMute = !bus.spectator;
  const muted = mode === 'muted';
  return el('div.alert-head', {},
    el('span.alert-count#alert-count'),
    el('span.alert-spacer'),
    // Dismissed-but-active alerts get a way back without waiting for them to
    // escalate.
    mode === 'dismissed' || (mode === 'open' && shown.length < all.length)
      ? el('button.alert-btn', {
          text: 'SHOW ALL',
          title: 'Show the alerts you dismissed',
          onclick: () => { for (const a of active.values()) a.dismissed = null; render(); },
        })
      : null,
    canMute
      ? el('button.alert-btn.mute', {
          text: muted ? 'UNMUTE' : 'MUTE ALL',
          title: muted
            ? 'Bring the alert tray and its tone back, on every station'
            : 'Silence the alert tray and its tone on every station until unmuted.\n'
              + 'Active alerts are still counted on this line.',
          onclick: () => bus.setAlertsMuted(!muted),
        })
      : null
  );
}

function updateHead(mode, all, shown, majors) {
  const count = tray.querySelector('#alert-count');
  if (!count) return;
  const minors = all.length - majors;
  const parts = [];
  if (majors) parts.push(`${majors} MAJOR`);
  if (minors) parts.push(`${minors} MINOR`);
  const summary = parts.join(' · ');
  // Named for what is in it, so a glance says whether it is pressure or a
  // valve left somewhere too long.
  const kinds = new Set(all.map((a) => a.kind));
  const what = kinds.size > 1 ? 'ALERTS' : kinds.has('valve') ? 'VALVE ALERT' : 'PT OUT OF BOUNDS';
  count.textContent = mode === 'muted'
    ? `ALERTS MUTED — ${summary} active`
    : mode === 'dismissed'
      ? `${summary} active — dismissed`
      : `${what} — ${summary}`;
}

function row(a) {
  const tag = a.kind === 'valve'
    ? (a.valve.pid?.tag || a.valve.id).replace(/\n/g, ' ')
    : a.sensor.pid?.tag?.replace(/\n/g, ' ') || a.sensor.id;
  const id = a.kind === 'valve' ? a.valve.id : a.sensor.id;
  return el(`div.alert-row.${a.level}.${a.kind}`, { dataset: { key: a.key } },
    el('span.alert-sev', { text: a.level === 'major' ? 'MAJOR' : 'MINOR' }),
    el('span.alert-tag', { text: tag, title: id }),
    el('span.alert-name'),
    el('span.alert-val'),
    el('span.alert-bound'),
    el('span.alert-age'),
    el('button.alert-x', {
      text: '✕',
      title: 'Dismiss this alert on this station. It comes back if it gets worse.',
      'aria-label': `Dismiss ${id} alert`,
      onclick: () => { a.dismissed = a.level; render(); },
    })
  );
}

function updateRow(a) {
  const node = tray.querySelector(`.alert-row[data-key="${CSS.escape(a.key)}"]`);
  if (!node) return;
  const set = (sel, text) => {
    const n = node.querySelector(sel);
    if (n.textContent !== text) n.textContent = text;
  };

  if (a.kind === 'valve') {
    // "LOX Vent — vent before loading" · "OPEN 2m 10s" · "limit 2m 00s"
    set('.alert-name', a.message ? `${a.valve.name} — ${a.message}` : a.valve.name);
    set('.alert-val', `${VALVE_ALERT_STATES[a.state]} ${fmtElapsed(a.heldMs)}`);
    set('.alert-bound', `limit ${fmtElapsed((Number(a.rule.afterSeconds) || 0) * 1000)}`);
    set('.alert-age', `for ${fmtElapsed(Date.now() - a.since)}`);
    node.dataset.stale = 'false';
    return;
  }

  const s = a.sensor;
  node.dataset.stale = String(Boolean(a.stale));
  set('.alert-name', s.name || '');
  set('.alert-val', `${fmtValue(bus.reading(s.id), s.decimals ?? 1)} ${s.units || ''}`);
  set('.alert-bound', a.okSince
    ? 'back in bounds'
    : a.bound ? `${a.bound.dir} ${a.bound.dir === 'HIGH' ? '≥' : '≤'} ${a.bound.limit}` : '');
  set('.alert-age', `for ${fmtElapsed(Date.now() - a.since)}`);
}

// ----------------------------------------------------------------- sound --

/**
 * A two-tone chirp every 1.2 s while an un-muted MAJOR alert is showing.
 *
 * Browsers will not start audio before the page has been interacted with, so
 * the context is created on the first click or key. An operator station has
 * had one long before anything goes out of bounds; a station nobody has
 * touched stays silent, which is the browser's rule rather than ours.
 */
let audio = null;
let alarmTimer = null;

function armAudio() {
  const start = () => {
    if (audio) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
  };
  window.addEventListener('pointerdown', start, { once: true, capture: true });
  window.addEventListener('keydown', start, { once: true, capture: true });
}

function alarm(on) {
  const wanted = on && !bus.spectator && bus.config.alerts?.sound !== false;
  if (wanted && !alarmTimer) {
    chirp();
    alarmTimer = setInterval(chirp, 1200);
  } else if (!wanted && alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
}

function chirp() {
  if (!audio) return;
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  const t0 = audio.currentTime;
  for (const [i, f] of [[0, 880], [1, 660]]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = f;
    const at = t0 + i * 0.16;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.08, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.15);
  }
}
