/* timers.js — operator stopwatches and countdowns, opened with T.
 *
 * A timer is a name, a clock, and optionally one PT to watch. The PT is what
 * makes it a leak check: the card records the pressure when the clock starts
 * and shows how far it has moved since, and at what average rate — which is
 * the number a leak check is actually read for, and the one that is tedious to
 * work out from a sparkline and a wristwatch.
 *
 * Timers belong to THIS station. They are kept in localStorage against the
 * wall clock, so moving between the Control Grid, the P&ID and the Data page
 * (each a fresh page load) does not reset one, but nothing here is sent to the
 * server, recorded in the CSV, or seen by another operator. They command
 * nothing.
 */
import { bus } from './bus.js';
import { el, clear, icon, fmtValue, fmtStopwatch, confirmAction, toast } from './util.js';

const STORE_KEY = 'gc4-timers';
const DOCK_KEY = 'gc4-timer-dock-pos';

let timers = load();
let dock = null;
let ticker = null;

export function mountTimers() {
  dock = el('div.timer-dock#timer-dock', { hidden: true });
  document.body.append(dock);
  placeDock();
  render();
  bus.on('state', captureStartValues);
}

// ------------------------------------------------------------- the dialog --

/** Open the "new timer" dialog. Safe to call while one is already open. */
export function openTimerDialog() {
  if (document.querySelector('.modal-backdrop')) return;

  let mode = 'up';
  const name = el('input', {
    type: 'text', value: '', placeholder: `Timer ${timers.length + 1}`,
    style: { width: '100%' }, 'aria-label': 'Timer name',
  });
  const duration = el('input.mono', {
    type: 'text', value: '5:00', placeholder: 'm:ss', 'aria-label': 'Countdown length, minutes:seconds',
    style: { width: '96px' },
  });
  const durationRow = el('div.timer-field.hidden', {},
    el('label.field', { text: 'Count down from (m:ss)' }), duration);

  const seg = el('div.seg.timer-mode');
  for (const [value, label] of [['up', 'STOPWATCH'], ['down', 'COUNTDOWN']]) {
    seg.append(el('button', {
      type: 'button', text: label, class: value === mode ? 'active' : '',
      onclick: (e) => {
        mode = value;
        for (const b of seg.children) b.classList.toggle('active', b === e.currentTarget);
        durationRow.classList.toggle('hidden', mode !== 'down');
      },
    }));
  }

  const pt = el('select', { 'aria-label': 'PT to monitor', style: { width: '100%' } },
    el('option', { value: '', text: 'None' }));
  for (const group of bus.sensorGroups()) {
    const pts = group.sensors.filter((s) => (s.kind ?? 'pressure') === 'pressure');
    if (!pts.length) continue;
    pt.append(el('optgroup', { label: group.label },
      pts.map((s) => el('option', { value: s.id, text: `${s.pid?.tag?.replace(/\n/g, ' ') || s.id} — ${s.name}` }))));
  }
  // A leak check is named after what it is checking, unless the operator has
  // already typed a name of their own.
  pt.addEventListener('change', () => {
    const s = sensorFor(pt.value);
    name.placeholder = s ? `Leak check — ${s.pid?.tag?.replace(/\n/g, ' ') || s.id}` : `Timer ${timers.length + 1}`;
  });

  const done = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
  const submit = () => {
    let durationMs = null;
    if (mode === 'down') {
      durationMs = parseDuration(duration.value);
      if (!durationMs) { toast('Enter the countdown as m:ss, e.g. 5:00', 'error'); duration.focus(); return; }
    }
    start({ name: name.value.trim() || name.placeholder, mode, durationMs, sensor: pt.value || null });
    done();
  };
  const onKey = (e) => {
    // Captured and stopped, like every dialog here: Escape is ABORT
    // everywhere else, and closing a timer dialog must not trip the stand.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); e.stopPropagation(); submit(); }
  };

  const backdrop = el('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) done(); } },
    el('div.modal.timer-modal', {},
      el('h2', { text: 'New timer' }),
      el('div.timer-field', {}, el('label.field', { text: 'Name' }), name),
      el('div.timer-field', {}, el('label.field', { text: 'Type' }), seg),
      durationRow,
      el('div.timer-field', {},
        el('label.field', { text: 'Monitor a PT (leak check) — optional' }), pt,
        el('div.timer-hint', {
          text: 'Records the pressure when the timer starts and shows the change and average rate since.',
        })),
      el('div.modal-actions', {},
        el('button.btn.ghost', { text: 'Cancel', onclick: done }),
        el('button.btn.accent', { text: 'Start', onclick: submit })
      )
    )
  );
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  name.focus();
}

/** "5:00" / "90" / "1:30:00" -> ms, or null. */
function parseDuration(text) {
  const parts = String(text).trim().split(':').map((p) => p.trim());
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const secs = parts.map(Number).reduce((acc, n) => acc * 60 + n, 0);
  return secs > 0 ? Math.round(secs * 1000) : null;
}

// ------------------------------------------------------------ the timers --

function start({ name, mode, durationMs, sensor }) {
  const now = Date.now();
  timers.push({
    id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name, mode, durationMs, sensor,
    startedAt: now, accMs: 0, running: true,
    startValue: sensor ? finite(bus.reading(sensor)) : null,
    endValue: null,
    expired: false,
  });
  save();
  render();
}

function elapsed(t, now = Date.now()) {
  return t.accMs + (t.running ? now - t.startedAt : 0);
}

function pause(t) {
  if (!t.running) return;
  t.accMs = elapsed(t);
  t.running = false;
  // Frozen with the clock, so a paused leak check keeps the number it was
  // paused on rather than drifting with the live reading.
  if (t.sensor) t.endValue = finite(bus.reading(t.sensor));
  save(); render();
}

function resume(t) {
  if (t.running) return;
  t.startedAt = Date.now();
  t.running = true;
  t.endValue = null;
  save(); render();
}

function reset(t) {
  t.accMs = 0;
  t.startedAt = Date.now();
  t.expired = false;
  t.endValue = null;
  if (t.sensor) t.startValue = finite(bus.reading(t.sensor));
  save(); render();
}

async function remove(t) {
  // A leak check twenty minutes in is not something to lose to a stray click.
  if (elapsed(t) > 30000) {
    const ok = await confirmAction({
      title: `Remove "${t.name}"?`,
      message: `It has been running ${fmtStopwatch(elapsed(t))}. This cannot be undone.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
  }
  timers = timers.filter((x) => x !== t);
  save(); render();
}

/** A PT with no reading when its timer started takes the first one it gets. */
function captureStartValues() {
  let changed = false;
  for (const t of timers) {
    if (t.sensor && t.startValue === null) {
      const v = finite(bus.reading(t.sensor));
      if (v !== null) { t.startValue = v; changed = true; }
    }
  }
  if (changed) save();
}

// ---------------------------------------------------------------- render --

function render() {
  if (!dock) return;
  dock.hidden = timers.length === 0;
  clear(dock);
  if (!timers.length) { stopTicker(); return; }

  dock.append(el('div.timer-dock-grip', {
    title: 'Drag to move · T for a new timer',
    onpointerdown: startDrag,
  }, el('span', { text: 'TIMERS' }),
  el('button.timer-icon-btn', { html: icon('plus', 12), title: 'New timer (T)', 'aria-label': 'New timer', onclick: openTimerDialog })));

  for (const t of timers) dock.append(card(t));
  tick();
  startTicker();
}

function card(t) {
  const s = t.sensor ? sensorFor(t.sensor) : null;
  return el('div.timer-card', { dataset: { timerId: t.id } },
    el('div.tc-head', {},
      el('span.tc-name', { text: t.name, title: t.name }),
      el('span.tc-mode', { text: t.mode === 'down' ? `↓ ${fmtStopwatch(t.durationMs).replace(/\.\d$/, '')}` : '↑' }),
      el('button.timer-icon-btn', {
        html: icon(t.running ? 'pause' : 'play', 11),
        title: t.running ? 'Pause' : 'Resume',
        'aria-label': t.running ? 'Pause' : 'Resume',
        onclick: () => (t.running ? pause(t) : resume(t)),
      }),
      el('button.timer-icon-btn', {
        html: icon('refresh', 11),
        title: t.sensor ? 'Restart — also re-records the starting pressure' : 'Restart',
        'aria-label': 'Restart', onclick: () => reset(t),
      }),
      el('button.timer-icon-btn', { text: '✕', title: 'Remove', 'aria-label': 'Remove', onclick: () => remove(t) })
    ),
    el('div.tc-face'),
    s ? el('div.tc-pt', {},
      el('div.tc-pt-line', {},
        el('span.tc-pt-tag', { text: s.pid?.tag?.replace(/\n/g, ' ') || s.id, title: `${s.id} — ${s.name}` }),
        el('span.tc-pt-vals')),
      el('div.tc-pt-delta')
    ) : null
  );
}

function tick() {
  const now = Date.now();
  for (const t of timers) {
    const node = dock.querySelector(`.timer-card[data-timer-id="${t.id}"]`);
    if (!node) continue;
    const ms = elapsed(t, now);

    let face;
    if (t.mode === 'down') {
      const left = t.durationMs - ms;
      if (left <= 0 && !t.expired) {
        t.expired = true;
        save();
        toast(`⏱ ${t.name} — time`, 'warn', 8000);
      }
      face = left > 0 ? fmtStopwatch(left) : `+${fmtStopwatch(-left)}`;
    } else {
      face = fmtStopwatch(ms);
    }
    node.querySelector('.tc-face').textContent = face;
    node.dataset.state = t.expired ? 'expired' : t.running ? 'running' : 'paused';

    if (t.sensor) updatePt(node, t, ms);
  }
}

function updatePt(node, t, ms) {
  const s = sensorFor(t.sensor);
  if (!s) return;
  const units = s.units || '';
  const d = s.decimals ?? 1;
  const nowV = t.running ? finite(bus.reading(t.sensor)) : t.endValue;
  const start = t.startValue;
  node.querySelector('.tc-pt-vals').textContent =
    `${fmtValue(start, d)} → ${fmtValue(nowV, d)} ${units}`;

  const deltaNode = node.querySelector('.tc-pt-delta');
  if (start === null || nowV === null) {
    deltaNode.textContent = 'waiting for a reading…';
    deltaNode.dataset.dir = 'flat';
    return;
  }
  const delta = nowV - start;
  const minutes = ms / 60000;
  // Signed on the ROUNDED value, so a change too small to print reads ±0.0
  // rather than −0.0.
  const signed = (x) => {
    const r = Number(x.toFixed(d));
    return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(d)}`;
  };
  // An average over less than a few seconds is transducer noise divided by a
  // small number; show it only once it can mean something.
  const rate = minutes > 5 / 60 ? delta / minutes : null;
  deltaNode.textContent = `Δ ${signed(delta)} ${units}`
    + (rate === null ? '' : `  ·  ${signed(rate)} ${units}/min avg`);
  const span = Math.abs((s.max ?? 1) - (s.min ?? 0)) || 1;
  deltaNode.dataset.dir = Math.abs(delta) < span * 0.001 ? 'flat' : delta < 0 ? 'down' : 'up';
}

function startTicker() { ticker ??= setInterval(tick, 100); }
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

// ------------------------------------------------------------- the dock --

/**
 * Where the dock sits. Movable, because on the P&ID any fixed corner is on
 * top of something; remembered per station.
 */
function placeDock() {
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(DOCK_KEY) || 'null'); } catch { /* ignore */ }
  applyDockPos(pos || { x: 16, y: 96 });
  window.addEventListener('resize', () => applyDockPos(currentPos()));
}

function currentPos() {
  return { x: parseFloat(dock.style.left) || 16, y: parseFloat(dock.style.top) || 96 };
}

function applyDockPos({ x, y }) {
  // Clamped so a dock left at the far edge of a big monitor is still
  // reachable on the laptop at the pad.
  const maxX = Math.max(0, window.innerWidth - 120);
  const maxY = Math.max(0, window.innerHeight - 60);
  dock.style.left = `${Math.min(maxX, Math.max(0, x))}px`;
  dock.style.top = `${Math.min(maxY, Math.max(40, y))}px`;
}

function startDrag(e) {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault();
  const grip = e.currentTarget;
  const from = { px: e.clientX, py: e.clientY, ...currentPos() };
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => applyDockPos({ x: from.x + ev.clientX - from.px, y: from.y + ev.clientY - from.py });
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    try { localStorage.setItem(DOCK_KEY, JSON.stringify(currentPos())); } catch { /* ignore */ }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}

// ----------------------------------------------------------------- utils --

function sensorFor(id) {
  if (!id) return null;
  return bus.sensor(id) || bus.boardSensor(id);
}

function finite(v) { return Number.isFinite(v) ? v : null; }

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((t) => t && t.id && Number.isFinite(t.startedAt)) : [];
  } catch { return []; }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(timers)); } catch { /* ignore */ }
}

// Other tabs on this station see the same list.
window.addEventListener('storage', (e) => {
  if (e.key !== STORE_KEY) return;
  timers = load();
  render();
});

