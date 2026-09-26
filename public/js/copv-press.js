/* copv-press.js — the COPV Press Tool, opened with C.
 *
 * Walks an operator up a list of target pressures on the GN2 bus, one
 * actuation of GROUND GN2 PRESS per click of Proceed. It is deliberately not
 * a controller: nothing here opens a valve on its own, and nothing here closes
 * one either. Proceed asks the server for ONE step, and the server closes the
 * valve when the monitored PT reaches the target or the max actuation time runs out
 * (see server/press-step.js) — so a station that freezes mid-step cannot leave
 * the valve open.
 *
 * What this module owns is the plan: the targets, the wait between steps,
 * the max time, and which step is next. That is per station, kept in
 * localStorage like the timers, so moving between pages does not lose it.
 *
 * The plan moves on when the bus is at or above the step's target: at once
 * if the step closed on target, or later if a step that closed short (max
 * time, a hand close) settles over it as the line pack bleeds in. Until then
 * the next Proceed goes for the same target again. The ‹ › carets beside the
 * step counter move the plan by hand.
 *
 * The PT the steps close on is GN2 BUS PT unless the setup picks another.
 * It is sent with every step, so the server closes on the same PT this
 * window is showing.
 *
 * Proceed has two kinds of block. HARD ones — ARM, ABORT, no PT reading, the
 * valve already open — the server refuses whatever this page does. SOFT ones
 * — the wait, the bus already over target, GN2 VENT open — are this tool's
 * advice, and holding SHIFT overrides them.
 */
import { bus } from './bus.js';
import { el, clear, fmtValue, toast, shiftGate } from './util.js';

const STORE_KEY = 'gc4-copv-press';
const POS_KEY = 'gc4-copv-press-pos';
const MAX_STEPS = 20;
const MAX_ACTUATION_S = 120;   // server/press-step.js MAX_ACTUATION_MS
/** How long the bus must hold at or over target before the plan moves on. */
const SETTLE_MS = 500;

let plan = load();   // { targets: [psi], waitS, maxS, sensor, next, open, pending, seen, attempted }
let win = null;
let ticker = null;
let busy = false;
let shiftHeld = false;
let aboveSince = null;   // when the bus rose over an attempted target

export function mountCopvPress() {
  if (bus.spectator) return;
  win = el('div.press-win#press-win', { hidden: true, role: 'dialog', 'aria-label': 'COPV Press Tool' });
  document.body.append(win);
  placeWindow();
  render();
  bus.on('state', onState);

  // The SHIFT override is shown before it is used: the Proceed button
  // changes while the key is down, not only when it is clicked.
  const setShift = (on) => { if (shiftHeld !== on) { shiftHeld = on; tick(); } };
  document.addEventListener('keydown', (e) => { if (e.key === 'Shift') setShift(true); });
  document.addEventListener('keyup', (e) => { if (e.key === 'Shift') setShift(false); });
  window.addEventListener('blur', () => setShift(false));
}

const DEFAULT_PT = 'GN2-BUS-PT';

/** The PT this plan closes on. */
function ptId() { return plan?.sensor || bus.state?.pressStep?.sensor || DEFAULT_PT; }
function ptTag(s) { return s?.pid?.tag?.replace(/\n/g, ' ') || s?.id || '—'; }

/**
 * PTs a step can close on: DAQ pressure channels only. The boards' own
 * transducers reach the server on the bang-bang heartbeat, not the tick the
 * step is closed on, so the server does not accept them.
 */
function pressureSensors() {
  return bus.sensorGroups()
    .map((g) => ({ label: g.label, sensors: g.sensors.filter((s) => !s.board && (s.kind ?? 'pressure') === 'pressure') }))
    .filter((g) => g.sensors.length);
}

// ------------------------------------------------------------- the dialog --

/** Open the setup dialog, prefilled from the current plan. */
export function openCopvPressDialog() {
  if (bus.spectator || document.querySelector('.modal-backdrop')) return;
  const ps = bus.state?.pressStep;
  const groups = pressureSensors();
  if (!bus.valve(ps?.valve || 'GND-GN2-PRESS') || !groups.length) {
    toast('This stand has no GROUND GN2 PRESS valve or no pressure transducers — the COPV Press Tool needs both', 'warn', 5000);
    return;
  }

  const prev = plan?.targets?.length ? plan : null;
  const count = el('input.mono', {
    type: 'number', min: 1, max: MAX_STEPS, step: 1, value: String(prev?.targets.length ?? 3),
    'aria-label': 'Number of press steps', style: { width: '80px' },
  });
  const current = bus.sensor(prev?.sensor) ? prev.sensor : bus.sensor(DEFAULT_PT) ? DEFAULT_PT : groups[0].sensors[0].id;
  const pt = el('select', { 'aria-label': 'PT to monitor', style: { width: '100%' } },
    groups.map((g) => el('optgroup', { label: g.label },
      g.sensors.map((s) => el('option', {
        value: s.id, text: `${ptTag(s)} — ${s.name}${s.id === DEFAULT_PT ? ' (default)' : ''}`,
        selected: s.id === current,
      })))));
  const rows = el('div.press-targets');
  const wait = el('input.mono', {
    type: 'number', min: 0, step: 'any', value: String(prev?.waitS ?? 30),
    'aria-label': 'Wait between steps, seconds', style: { width: '96px' },
  });
  const max = el('input.mono', {
    type: 'number', min: 0.1, max: MAX_ACTUATION_S, step: 'any', value: String(prev?.maxS ?? 5),
    'aria-label': 'Max valve open time per step, seconds', style: { width: '96px' },
  });

  // Rebuilt on every count change, keeping whatever was already typed.
  const buildRows = () => {
    const typed = [...rows.querySelectorAll('input')].map((i) => i.value);
    const n = Math.max(1, Math.min(MAX_STEPS, Math.round(Number(count.value)) || 1));
    clear(rows);
    for (let i = 0; i < n; i++) {
      rows.append(el('label.press-target-row', {},
        el('span', { text: `Step ${i + 1}` }),
        el('input.mono', {
          type: 'number', min: 0, step: 'any',
          value: typed[i] ?? (prev?.targets[i] != null ? String(prev.targets[i]) : ''),
          'aria-label': `Step ${i + 1} target pressure, psi`,
        }),
        el('span.press-unit', { text: 'psi' })));
    }
  };
  count.addEventListener('input', buildRows);
  buildRows();

  const done = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
  const submit = () => {
    const targets = [...rows.querySelectorAll('input')].map((i) => Number(i.value));
    const bad = targets.findIndex((t, i) => !(t > 0) || (i > 0 && t <= targets[i - 1]));
    if (bad >= 0) {
      toast(`Step ${bad + 1}: targets must be positive and each higher than the one before`, 'error');
      rows.querySelectorAll('input')[bad].focus();
      return;
    }
    const waitS = Number(wait.value);
    if (!(waitS >= 0)) { toast('Enter the wait between steps in seconds', 'error'); wait.focus(); return; }
    const maxS = Number(max.value);
    if (!(maxS > 0) || maxS > MAX_ACTUATION_S) {
      toast(`Max valve open time must be between 0 and ${MAX_ACTUATION_S} s`, 'error'); max.focus(); return;
    }
    plan = {
      targets, waitS, maxS, sensor: pt.value, next: 0, open: true, pending: null, attempted: null,
      seen: bus.state?.pressStep?.last?.startedAt ?? null,
    };
    save();
    render();
    done();
  };
  const onKey = (e) => {
    // Captured and stopped: Escape is ABORT everywhere else.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); e.stopPropagation(); submit(); }
  };

  const backdrop = el('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) done(); } },
    el('div.modal.press-modal', {},
      el('h2', { text: 'COPV Press Tool' }),
      el('p', { text: 'Each Proceed opens GROUND GN2 PRESS once. The stand closes it when the monitored PT reaches the step target or the max open time runs out.' }),
      el('div.press-field', {}, el('label.field', { text: 'PT to monitor' }), pt),
      el('div.press-field', {}, el('label.field', { text: 'Number of press steps' }), count),
      el('div.press-field', {}, el('label.field', { text: 'Target pressure at each step' }), rows),
      el('div.press-field-pair', {},
        el('div.press-field', {}, el('label.field', { text: 'Wait between steps (s)' }), wait),
        el('div.press-field', {}, el('label.field', { text: 'Max valve open time (s)' }), max)),
      el('div.modal-actions', {},
        el('button.btn.ghost', { text: 'Cancel', onclick: done }),
        el('button.btn.accent', { text: 'Confirm', onclick: submit })
      )
    )
  );
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  rows.querySelector('input')?.focus();
}

// ------------------------------------------------------------ the window --

function render() {
  if (!win) return;
  const show = Boolean(plan?.open && plan.targets?.length);
  win.hidden = !show;
  clear(win);
  if (!show) { stopTicker(); return; }

  const numberBox = (label, key, value, unit, onchange) =>
    el('label.press-box', { dataset: { box: key } },
      el('span.press-box-label', { text: label }),
      el('span.press-box-input', {},
        el('input.mono', { type: 'number', min: 0, step: 'any', value: String(value), onchange }),
        el('span.press-unit', { text: unit })),
      el('span.press-box-sub'));

  win.append(
    el('div.press-grip', { title: 'Drag to move · C to reconfigure', onpointerdown: startDrag },
      el('span.press-title', { text: 'COPV PRESS' }),
      el('button.press-caret', { text: '‹', title: 'Previous step', 'aria-label': 'Previous step', onclick: () => moveStep(-1) }),
      el('span.press-step-count'),
      el('button.press-caret', { text: '›', title: 'Next step', 'aria-label': 'Next step', onclick: () => moveStep(1) }),
      el('span.press-grip-fill'),
      el('button.timer-icon-btn', { text: '⚙', title: 'Reconfigure (C)', 'aria-label': 'Reconfigure', onclick: openCopvPressDialog }),
      el('button.timer-icon-btn', { text: '✕', title: 'Close the tool', 'aria-label': 'Close', onclick: closeWindow })),
    el('div.press-body', {},
      el('div.press-reading', {},
        el('span.press-reading-label', { text: ptTag(bus.sensor(ptId())), title: `${ptId()} — the PT steps close on` }),
        el('span.press-reading-value'),
        el('span.press-unit', { text: 'psi' })),
      el('div.press-delta'),
      el('div.press-boxes', {},
        numberBox('Next Target Pressure', 'target', plan.targets[Math.min(plan.next, plan.targets.length - 1)], 'psi', (e) => {
          const v = Number(e.target.value);
          const i = Math.min(plan.next, plan.targets.length - 1);
          if (v > 0) { plan.targets[i] = v; save(); } else e.target.value = plan.targets[i];
        }),
        numberBox('Wait Time', 'wait', plan.waitS, 's', (e) => {
          const v = Number(e.target.value);
          if (v >= 0) { plan.waitS = v; save(); } else e.target.value = plan.waitS;
        }),
        numberBox('Max Actuation Time', 'max', plan.maxS, 's', (e) => {
          const v = Number(e.target.value);
          if (v > 0 && v <= MAX_ACTUATION_S) { plan.maxS = v; save(); }
          else { toast(`Max actuation time must be between 0 and ${MAX_ACTUATION_S} s`, 'error'); e.target.value = plan.maxS; }
        })),
      el('div.press-status'),
      el('div.press-actions', {},
        el('button.btn.press-proceed', { text: 'Proceed', onclick: proceed }),
        el('button.btn.danger.press-vent', { text: 'Vent', onclick: vent }))));

  tick();
  startTicker();
}

/**
 * Where the tool stands right now, and what Proceed would run into.
 *
 * `hard` is a block the server enforces whatever this page does. `soft`
 * lists the tool's own advice, which SHIFT overrides; `overTarget` is the one
 * of those the server also has to be told about (see press-step.js `force`).
 */
function assess() {
  const ps = bus.state?.pressStep;
  const sensor = bus.sensor(ptId());
  const p = bus.reading(sensor?.id);
  const active = ps?.active || null;
  const last = ps?.last || null;
  const done = plan.next >= plan.targets.length;
  const target = done ? null : plan.targets[plan.next];

  // Wait is measured from when the last step ENDED, on the server's clock, so
  // it counts the same on every station and across a page reload.
  const sinceEnd = last ? bus.sinceServer(last.endedAt) : null;
  const waitLeft = !active && sinceEnd !== null ? Math.max(0, plan.waitS * 1000 - sinceEnd) : 0;
  const ventOpen = bus.valveState(ps?.vent || 'GN2-VENT') === 'open';
  const overTarget = !done && Number.isFinite(p) && p >= target;

  const hard =
    active ? null
      : done ? 'All steps complete — ‹ to go back, ⚙ to set up another run'
      : !ps ? 'Server does not support press steps'
      : bus.state?.abort?.active ? 'Stand is in ABORT'
      : !bus.state?.armed ? 'Requires ARM'
      : bus.valveState(ps.valve || 'GND-GN2-PRESS') === 'open' ? 'GROUND GN2 PRESS is already open'
      : !sensor ? `${ptId()} is not on this stand — ⚙ to pick another PT`
      : !Number.isFinite(p) ? `${ptTag(sensor)} has no reading`
      : null;
  const soft = active || hard ? [] : [
    overTarget ? 'bus already at or above target' : null,
    ventOpen ? 'GN2 VENT is open' : null,
    waitLeft > 0 ? `waiting ${(waitLeft / 1000).toFixed(1)} s` : null,
  ].filter(Boolean);

  return { sensor, d: sensor?.decimals ?? 0, p, active, last, done, target, waitLeft, ventOpen, overTarget, hard, soft };
}

/** Everything that changes with time or telemetry, without rebuilding inputs. */
function tick() {
  if (!win || win.hidden) return;
  if (settleAdvance()) return;   // re-rendered, which ticks again
  const a = assess();
  const { p, d, active, last, done, waitLeft } = a;
  const q = (sel) => win.querySelector(sel);

  q('.press-step-count').textContent = done
    ? `DONE · ${plan.targets.length}/${plan.targets.length}`
    : `STEP ${plan.next + 1}/${plan.targets.length}`;
  const [prevBtn, nextBtn] = win.querySelectorAll('.press-caret');
  prevBtn.disabled = Boolean(active) || plan.next <= 0;
  nextBtn.disabled = Boolean(active) || plan.next >= plan.targets.length - 1;
  q('.press-reading-value').textContent = fmtValue(p, d);

  // The change the last actuation made: from the bus pressure when it opened
  // to now, so the settle after the close is part of the number. Live while a
  // step is in progress.
  const step = active || last;
  const from = step && (step.sensor ?? DEFAULT_PT) === a.sensor?.id ? step.startP : null;
  const deltaNode = q('.press-delta');
  if (from === null || !Number.isFinite(p)) {
    deltaNode.textContent = 'Δ last step  ––';
    deltaNode.dataset.dir = 'flat';
  } else {
    const delta = p - from;
    const r = Number(delta.toFixed(d));
    deltaNode.textContent = `Δ ${active ? 'this' : 'last'} step  ${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(d)} psi`
      + `   (${fmtValue(from, d)} → ${fmtValue(p, d)})`;
    deltaNode.dataset.dir = r > 0 ? 'up' : r < 0 ? 'down' : 'flat';
  }

  const targetBox = q('[data-box="target"]');
  const targetInput = targetBox.querySelector('input');
  targetInput.disabled = done || Boolean(active);
  if (document.activeElement !== targetInput && !done) {
    targetInput.value = String(plan.targets[plan.next]);
  }
  targetBox.querySelector('.press-box-sub').textContent = done ? 'all steps complete'
    : Number.isFinite(p) ? `${fmtValue(Math.max(0, plan.targets[plan.next] - p), d)} psi to go` : '';

  q('[data-box="wait"] .press-box-sub').textContent = waitLeft > 0 ? `${(waitLeft / 1000).toFixed(1)} s left` : '';
  q('[data-box="max"] .press-box-sub').textContent = active
    ? `open ${(bus.sinceServer(active.startedAt) / 1000).toFixed(1)} s`
    : last ? `last ${(last.durationMs / 1000).toFixed(1)} s` : '';
  q('[data-box="max"] input').disabled = Boolean(active);

  const override = !a.hard && a.soft.length > 0 && shiftHeld;
  const status = q('.press-status');
  if (active) {
    status.textContent = active.forced
      ? `PRESSING (override) — closes at ${(active.maxMs / 1000).toFixed(1)} s`
      : `PRESSING → ${fmtValue(active.target, d)} psi`;
    status.dataset.kind = 'active';
  } else if (a.hard) {
    status.textContent = a.hard;
    status.dataset.kind = 'blocked';
  } else if (a.soft.length) {
    const what = a.soft.join(' · ');
    status.textContent = override
      ? `SHIFT override: ${what}${a.overTarget ? ' — step runs the full max time' : ''}`
      : `${what[0].toUpperCase()}${what.slice(1)} — hold SHIFT to override`;
    status.dataset.kind = override ? 'override' : a.soft.length === 1 && waitLeft > 0 ? 'wait' : 'blocked';
  } else {
    status.textContent = last ? `Ready · last step: ${lastSummary(last, d)}` : 'Ready';
    status.dataset.kind = 'ready';
  }

  const proceedBtn = q('.press-proceed');
  proceedBtn.disabled = busy || Boolean(active) || Boolean(a.hard) || (a.soft.length > 0 && !shiftHeld);
  proceedBtn.textContent = active ? 'Pressing…' : override ? 'Proceed (override)' : 'Proceed';
  proceedBtn.classList.toggle('accent', !proceedBtn.disabled && !override);
  proceedBtn.classList.toggle('override', !proceedBtn.disabled && override);

  const ventBtn = q('.press-vent');
  ventBtn.disabled = busy;
  ventBtn.textContent = a.ventOpen ? 'Seal Vent' : 'Vent';
  ventBtn.classList.toggle('danger', !a.ventOpen);
  ventBtn.title = a.ventOpen
    ? 'Close GN2 VENT, the vehicle bus vent (SHIFT+click)'
    : 'Open GN2 VENT, the vehicle bus vent — ends any step in progress first';
}

function lastSummary(last, d) {
  const why = { 'target reached': 'target reached', 'max actuation time': 'max time' }[last.reason] || last.reason;
  return `${why} in ${(last.durationMs / 1000).toFixed(1)} s at ${fmtValue(last.endP, d)} psi`;
}

/**
 * Move the plan on once the bus has settled at or over a target this station
 * has already pressed toward. Held for SETTLE_MS, so one noisy sample across
 * the line does not count. True when it advanced.
 */
function settleAdvance() {
  const ps = bus.state?.pressStep;
  const p = bus.reading(ptId());
  const eligible = !ps?.active && !plan.pending && plan.attempted === plan.next
    && plan.next < plan.targets.length && Number.isFinite(p) && p >= plan.targets[plan.next];
  if (!eligible) { aboveSince = null; return false; }
  aboveSince ??= Date.now();
  if (Date.now() - aboveSince < SETTLE_MS) return false;
  aboveSince = null;
  advance(`bus settled at ${fmtValue(p, 0)} psi`);
  return true;
}

function advance(why) {
  const reached = plan.targets[plan.next];
  plan.next++;
  plan.attempted = null;
  save();
  toast(plan.next >= plan.targets.length
    ? `COPV press: all steps complete (${why})`
    : `Step reached ${reached} psi (${why}) — next target ${plan.targets[plan.next]} psi`, 'info', 4000);
  render();
}

/** The ‹ › carets. Kept inside the plan; DONE is reached only by pressing. */
function moveStep(by) {
  if (bus.state?.pressStep?.active) return;
  const next = Math.max(0, Math.min(plan.targets.length - 1, plan.next + by));
  if (next === plan.next) return;
  plan.next = next;
  plan.attempted = null;
  save();
  render();
}

// --------------------------------------------------------------- actions --

async function proceed(e) {
  if (busy) return;
  const a = assess();
  if (a.active || a.hard) return;
  if (a.soft.length && !e.shiftKey) { toast(`Hold SHIFT to override: ${a.soft.join(', ')}`, 'warn'); return; }
  if (!shiftGate(e, `open GROUND GN2 PRESS toward ${a.target} psi`)) return;
  busy = true; tick();
  // Marked before the request, not after: a short step can end and reach
  // this page over the stream before the POST itself has answered. Any step
  // that STARTED after this click is ours — the server runs one at a time.
  plan.pending = { since: bus.serverNow() - 1000, startedAt: null };
  save();
  try {
    const res = await bus.post('/api/press-step', {
      target: a.target, maxMs: Math.round(plan.maxS * 1000), force: a.overTarget, sensor: a.sensor.id,
    });
    if (!res.ok) plan.pending = null;
    else if (plan.pending) plan.pending.startedAt = res.state?.pressStep?.active?.startedAt ?? null;
    save();
  } finally { busy = false; tick(); }
}

async function vent(e) {
  if (busy) return;
  const ps = bus.state?.pressStep;
  const ventId = ps?.vent || 'GN2-VENT';
  const open = bus.valveState(ventId) === 'open';
  // Sealing is away from the vent's safe state, so it takes SHIFT like any
  // other valve. Venting never does.
  if (open && !shiftGate(e, 'seal GN2 VENT')) return;
  busy = true; tick();
  try {
    if (!open && ps?.active) await bus.post('/api/press-step', { stop: true, reason: 'vent' });
    await bus.commandValve(ventId, open ? 'closed' : 'open');
  } finally { busy = false; tick(); }
}

/**
 * When THIS station's step comes back: on target, move on now; short of it,
 * mark the target attempted, so a settle over it moves the plan on later.
 */
function onState() {
  if (!plan) return;
  const last = bus.state?.pressStep?.last;
  if (!last || last.startedAt === plan.seen) return;
  plan.seen = last.startedAt;
  const mine = plan.pending && (plan.pending.startedAt != null
    ? plan.pending.startedAt === last.startedAt
    : last.startedAt >= plan.pending.since);
  if (mine) {
    plan.pending = null;
    if (plan.next < plan.targets.length && plan.targets[plan.next] === last.target) {
      plan.attempted = plan.next;
      if (last.reason === 'target reached') { advance('target reached'); return; }
      toast(`Press step ended short of ${last.target} psi (${last.reason}) — `
        + 'moves on if the bus settles over it, or Proceed repeats this step', 'warn', 5000);
    }
  }
  save();
  render();
}

function closeWindow() {
  if (bus.state?.pressStep?.active) {
    toast('A press step is in progress — wait for it to end, or Vent', 'warn');
    return;
  }
  plan.open = false;
  save();
  render();
}

function startTicker() { ticker ??= setInterval(tick, 100); }
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

// ------------------------------------------------------------ placement --

function placeWindow() {
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { /* ignore */ }
  applyPos(pos || { x: Math.max(16, window.innerWidth - 340), y: 96 });
  window.addEventListener('resize', () => applyPos(currentPos()));
}

function currentPos() {
  return { x: parseFloat(win.style.left) || 16, y: parseFloat(win.style.top) || 96 };
}

function applyPos({ x, y }) {
  const maxX = Math.max(0, window.innerWidth - 120);
  const maxY = Math.max(0, window.innerHeight - 60);
  win.style.left = `${Math.min(maxX, Math.max(0, x))}px`;
  win.style.top = `${Math.min(maxY, Math.max(40, y))}px`;
}

function startDrag(e) {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault();
  const grip = e.currentTarget;
  const from = { px: e.clientX, py: e.clientY, ...currentPos() };
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => applyPos({ x: from.x + ev.clientX - from.px, y: from.y + ev.clientY - from.py });
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    try { localStorage.setItem(POS_KEY, JSON.stringify(currentPos())); } catch { /* ignore */ }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}

// ----------------------------------------------------------------- store --

function load() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return p && Array.isArray(p.targets) ? p : null;
  } catch { return null; }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(plan)); } catch { /* ignore */ }
}

// Other tabs on this station share the plan.
window.addEventListener('storage', (e) => {
  if (e.key !== STORE_KEY) return;
  plan = load();
  render();
});
