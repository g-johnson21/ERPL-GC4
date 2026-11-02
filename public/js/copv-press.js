/* copv-press.js — the COPV Press Tool, opened with C.
 *
 * Walks an operator up a list of target pressures on the GN2 bus, one
 * setpoint step of the PANDA's GN2 bang-bang controller (board side G) per
 * click of Proceed. The board's loop does the pressing: it pulses the GN2
 * bang-bang solenoid on the ground supply against GN2 BUS PT, and once a
 * target is reached it HOLDS the bus there until the next Proceed raises the
 * setpoint, or Stop. Nothing here opens a valve on its own: Proceed asks the
 * server for ONE step (see server/press-step.js), which opens GROUND GN2
 * PRESS if needed, sets the setpoint and enables the controller, and ends the
 * step when the bus reaches the target or the step timeout runs out — so a
 * station that freezes mid-step leaves the board regulating to a setpoint an
 * operator chose, with a server-side timeout behind it.
 *
 * What this module owns is the plan: the targets, the wait between steps,
 * the timeout, and which step is next. That is per station, kept in
 * localStorage like the timers, so moving between pages does not lose it.
 *
 * The plan moves on when the bus is at or above the step's target: at once
 * if the step ended on target, or later if a step that ended short (timeout,
 * the controller dropped) settles over it. Until then the next Proceed goes
 * for the same target again. The ‹ › carets beside the step counter move the
 * plan by hand.
 *
 * Proceed has two kinds of block. HARD ones — ARM, ABORT, no controller, no
 * PT reading, GN2 VENT open, a board ABORT latch — the server or the board
 * refuses whatever this page does. SOFT ones — the wait, the bus already
 * over target — are this tool's advice, and holding SHIFT overrides them.
 *
 * Stop ends the run: the controller off and GROUND GN2 PRESS shut. Vent does
 * the same and then opens GN2 VENT; the board owns that vent while its loop
 * runs, so the server sends them in that order.
 */
import { bus } from './bus.js';
import { el, clear, fmtValue, toast, shiftGate } from './util.js';

const STORE_KEY = 'gc4-copv-press';
const POS_KEY = 'gc4-copv-press-pos';
const MAX_STEPS = 20;
const MAX_STEP_S = 600;   // server/press-step.js MAX_STEP_MS
const DEFAULT_TIMEOUT_S = 60;
/** How long the bus must hold at or over target before the plan moves on. */
const SETTLE_MS = 500;

let plan = load();   // { targets: [psi], waitS, timeoutS, next, open, pending, seen, attempted }
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

/** The press-step snapshot: which controller, PT and valves the tool drives. */
function ps() { return bus.state?.pressStep ?? null; }
/** The GN2 controller's config and live snapshot. */
function ctrlCfg() { const id = ps()?.controller; return id ? bus.controller(id) ?? null : null; }
function ctrl() { const id = ps()?.controller; return id ? bus.state?.controllers?.[id] ?? null : null; }
function ptId() { return ps()?.sensor ?? null; }
function ptTag(s) { return s?.pid?.tag?.replace(/\n/g, ' ') || s?.id || '—'; }
function valveName(id) { return bus.valve(id)?.name ?? id; }

// ------------------------------------------------------------- the dialog --

/** Open the setup dialog, prefilled from the current plan. */
export function openCopvPressDialog() {
  if (bus.spectator || document.querySelector('.modal-backdrop')) return;
  const snap = ps();
  if (!snap?.controller || !bus.sensor(snap.sensor)) {
    toast('This stand has no GN2 bang-bang controller (board side G) — the COPV Press Tool needs one', 'warn', 5000);
    return;
  }
  const c = ctrl();
  const limit = snap.setpointMax;

  const prev = plan?.targets?.length ? plan : null;
  const count = el('input.mono', {
    type: 'number', min: 1, max: MAX_STEPS, step: 1, value: String(prev?.targets.length ?? 3),
    'aria-label': 'Number of press steps', style: { width: '80px' },
  });
  const rows = el('div.press-targets');
  const wait = el('input.mono', {
    type: 'number', min: 0, step: 'any', value: String(prev?.waitS ?? 30),
    'aria-label': 'Wait between steps, seconds', style: { width: '96px' },
  });
  const timeout = el('input.mono', {
    type: 'number', min: 1, max: MAX_STEP_S, step: 'any', value: String(prev?.timeoutS ?? DEFAULT_TIMEOUT_S),
    'aria-label': 'Step timeout, seconds', style: { width: '96px' },
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
          type: 'number', min: 0, max: limit ?? undefined, step: 'any',
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
    const bad = targets.findIndex((t, i) => !(t > 0) || (i > 0 && t <= targets[i - 1]) || (limit != null && t > limit));
    if (bad >= 0) {
      toast(`Step ${bad + 1}: targets must be positive, each higher than the one before`
        + (limit != null ? `, and at most ${limit} psi` : ''), 'error');
      rows.querySelectorAll('input')[bad].focus();
      return;
    }
    const waitS = Number(wait.value);
    if (!(waitS >= 0)) { toast('Enter the wait between steps in seconds', 'error'); wait.focus(); return; }
    const timeoutS = Number(timeout.value);
    if (!(timeoutS > 0) || timeoutS > MAX_STEP_S) {
      toast(`Step timeout must be between 0 and ${MAX_STEP_S} s`, 'error'); timeout.focus(); return;
    }
    plan = {
      targets, waitS, timeoutS, next: 0, open: true, pending: null, attempted: null,
      seen: ps()?.last?.startedAt ?? null,
    };
    save();
    render();
    done();
  };
  const onKey = (e) => {
    // Captured and stopped: Escape is ABORT everywhere else.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
  };

  const sensor = bus.sensor(snap.sensor);
  const backdrop = el('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) done(); } },
    el('div.modal.press-modal', {},
      el('h2', { text: 'COPV Press Tool' }),
      el('p', {
        text: `Each Proceed steps the ${ctrlCfg()?.name ?? 'GN2 bang-bang'} controller's setpoint up to the next target `
          + `and runs it: the board pulses ${valveName(snap.valve)} against ${ptTag(sensor)} and holds the bus there `
          + `until the next step. ${valveName(snap.isolation)} is opened on the first step. `
          + (c ? `Band ±${c.deadband} psi, set on the bang-bang card.` : ''),
      }),
      el('div.press-field', {}, el('label.field', { text: 'Number of press steps' }), count),
      el('div.press-field', {}, el('label.field', { text: 'Target pressure at each step' }), rows),
      el('div.press-field-pair', {},
        el('div.press-field', {}, el('label.field', { text: 'Wait between steps (s)' }), wait),
        el('div.press-field', {}, el('label.field', { text: 'Step timeout (s)' }), timeout)),
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
        el('span.press-reading-label', { text: ptTag(bus.sensor(ptId())), title: `${ptId() ?? '—'} — the PT the GN2 loop regulates on` }),
        el('span.press-reading-value'),
        el('span.press-unit', { text: 'psi' })),
      el('div.press-delta'),
      el('div.press-boxes', {},
        numberBox('Next Target Pressure', 'target', plan.targets[Math.min(plan.next, plan.targets.length - 1)], 'psi', (e) => {
          const v = Number(e.target.value);
          const i = Math.min(plan.next, plan.targets.length - 1);
          const limit = ps()?.setpointMax;
          if (v > 0 && (limit == null || v <= limit)) { plan.targets[i] = v; save(); }
          else {
            if (limit != null && v > limit) toast(`Target is limited to ${limit} psi on this controller`, 'error');
            e.target.value = plan.targets[i];
          }
        }),
        numberBox('Wait Time', 'wait', plan.waitS, 's', (e) => {
          const v = Number(e.target.value);
          if (v >= 0) { plan.waitS = v; save(); } else e.target.value = plan.waitS;
        }),
        numberBox('Step Timeout', 'timeout', plan.timeoutS, 's', (e) => {
          const v = Number(e.target.value);
          if (v > 0 && v <= MAX_STEP_S) { plan.timeoutS = v; save(); }
          else { toast(`Step timeout must be between 0 and ${MAX_STEP_S} s`, 'error'); e.target.value = plan.timeoutS; }
        })),
      el('div.press-status'),
      el('div.press-actions', {},
        el('button.btn.press-proceed', { text: 'Proceed', onclick: proceed }),
        el('button.btn.press-stop', { text: 'Stop', onclick: stopRun }),
        el('button.btn.danger.press-vent', { text: 'Vent', onclick: vent }))));

  tick();
  startTicker();
}

/**
 * Where the tool stands right now, and what Proceed would run into.
 *
 * `hard` is a block the server or the board enforces whatever this page does.
 * `soft` lists the tool's own advice, which SHIFT overrides.
 */
function assess() {
  const snap = ps();
  const c = ctrl();
  const sensor = bus.sensor(ptId());
  const p = bus.reading(sensor?.id);
  const active = snap?.active || null;
  const last = snap?.last || null;
  const done = plan.next >= plan.targets.length;
  const target = done ? null : plan.targets[plan.next];
  // Holding: the controller is on with no step in progress — the board is
  // keeping the bus at the last target reached.
  const holding = !active && Boolean(c?.enabled);
  const starting = Boolean(c?.awaiting);

  // Wait is measured from when the last step ENDED, on the server's clock, so
  // it counts the same on every station and across a page reload.
  const sinceEnd = last ? bus.sinceServer(last.endedAt) : null;
  const waitLeft = !active && sinceEnd !== null ? Math.max(0, plan.waitS * 1000 - sinceEnd) : 0;
  const ventOpen = bus.valveState(snap?.vent || 'GN2-VENT') === 'open';
  const overTarget = !done && Number.isFinite(p) && p >= target;

  const hard =
    active ? null
      : done ? 'All steps complete — ‹ to go back, ⚙ to set up another run'
      : !snap ? 'Server does not support press steps'
      : !snap.controller || !c ? 'This stand has no GN2 bang-bang controller'
      : bus.state?.abort?.active ? 'Stand is in ABORT'
      : !bus.state?.armed ? 'Requires ARM'
      : c.board?.state === 'ABT' ? 'GN2 side is latched in ABORT on the board — disarm to clear it'
      : ventOpen ? `${valveName(snap.vent)} is open — Seal Vent first`
      : !sensor ? `${ptId()} is not on this stand`
      : !Number.isFinite(p) ? `${ptTag(sensor)} has no reading`
      : null;
  const soft = active || hard ? [] : [
    overTarget ? 'bus already at or above target' : null,
    waitLeft > 0 ? `waiting ${(waitLeft / 1000).toFixed(1)} s` : null,
  ].filter(Boolean);

  return { snap, c, sensor, d: sensor?.decimals ?? 0, p, active, last, done, target, holding, starting, waitLeft, ventOpen, overTarget, hard, soft };
}

/** Everything that changes with time or telemetry, without rebuilding inputs. */
function tick() {
  if (!win || win.hidden) return;
  if (settleAdvance()) return;   // re-rendered, which ticks again
  const a = assess();
  const { p, d, c, active, last, done, waitLeft, holding } = a;
  const q = (sel) => win.querySelector(sel);

  q('.press-step-count').textContent = done
    ? `DONE · ${plan.targets.length}/${plan.targets.length}`
    : `STEP ${plan.next + 1}/${plan.targets.length}`;
  const [prevBtn, nextBtn] = win.querySelectorAll('.press-caret');
  prevBtn.disabled = Boolean(active) || plan.next <= 0;
  nextBtn.disabled = Boolean(active) || plan.next >= plan.targets.length - 1;
  q('.press-reading-value').textContent = fmtValue(p, d);

  // The change the last step made: from the bus pressure when it started to
  // now, so the settle afterwards is part of the number. Live while a step
  // is in progress.
  const step = active || last;
  const from = step && step.sensor === a.sensor?.id ? step.startP : null;
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
  q('[data-box="timeout"] .press-box-sub').textContent = active
    ? `${Math.max(0, (active.timeoutMs - bus.sinceServer(active.startedAt)) / 1000).toFixed(0)} s left`
    : last ? `last ${(last.durationMs / 1000).toFixed(1)} s` : '';
  q('[data-box="timeout"] input').disabled = Boolean(active);

  const override = !a.hard && a.soft.length > 0 && shiftHeld;
  const band = c ? ` ±${c.deadband}` : '';
  const status = q('.press-status');
  if (active) {
    status.textContent = a.starting
      ? `STARTING GN2 LOOP → ${fmtValue(active.target, d)} psi (waiting for the board)`
      : `PRESSING → ${fmtValue(active.target, d)}${band} psi${c?.board?.press ? ' · valve open' : ''}`;
    status.dataset.kind = 'active';
  } else if (a.hard) {
    status.textContent = holding && done ? `HOLDING ${fmtValue(c.setpoint, d)}${band} psi — all steps complete` : a.hard;
    status.dataset.kind = holding && done ? 'holding' : 'blocked';
  } else if (a.soft.length) {
    const what = a.soft.join(' · ');
    const hold = holding ? `Holding ${fmtValue(c.setpoint, d)} psi · ` : '';
    status.textContent = override
      ? `SHIFT override: ${what}`
      : `${hold}${hold ? what : what[0].toUpperCase() + what.slice(1)} — hold SHIFT to override`;
    status.dataset.kind = override ? 'override' : a.soft.length === 1 && waitLeft > 0 ? 'wait' : 'blocked';
  } else if (holding) {
    status.textContent = `HOLDING ${fmtValue(c.setpoint, d)}${band} psi · Proceed for ${fmtValue(a.target, d)} psi`;
    status.dataset.kind = 'holding';
  } else {
    status.textContent = last ? `Ready · last step: ${lastSummary(last, d)}` : 'Ready';
    status.dataset.kind = 'ready';
  }

  const proceedBtn = q('.press-proceed');
  proceedBtn.disabled = busy || Boolean(active) || Boolean(a.hard) || (a.soft.length > 0 && !shiftHeld);
  proceedBtn.textContent = active ? 'Pressing…' : override ? 'Proceed (override)' : 'Proceed';
  proceedBtn.classList.toggle('accent', !proceedBtn.disabled && !override);
  proceedBtn.classList.toggle('override', !proceedBtn.disabled && override);

  const isoOpen = bus.valveState(a.snap?.isolation) === 'open';
  const stopBtn = q('.press-stop');
  stopBtn.disabled = busy || !(active || c?.enabled || isoOpen);
  stopBtn.title = `Turn the GN2 loop off and close ${valveName(a.snap?.isolation)}. The bus keeps what it has.`;

  const ventBtn = q('.press-vent');
  ventBtn.disabled = busy;
  ventBtn.textContent = a.ventOpen ? 'Seal Vent' : 'Vent';
  ventBtn.classList.toggle('danger', !a.ventOpen);
  ventBtn.title = a.ventOpen
    ? `Close ${valveName(a.snap?.vent)}, the vehicle bus vent (SHIFT+click)`
    : `Open ${valveName(a.snap?.vent)}, the vehicle bus vent — stops the GN2 loop first`;
}

function lastSummary(last, d) {
  const why = { 'target reached': 'target reached', 'step timeout': 'timed out' }[last.reason] || last.reason;
  return `${why} in ${(last.durationMs / 1000).toFixed(1)} s at ${fmtValue(last.endP, d)} psi`;
}

/**
 * Move the plan on once the bus has settled at or over a target this station
 * has already pressed toward. Held for SETTLE_MS, so one noisy sample across
 * the line does not count. True when it advanced.
 */
function settleAdvance() {
  const p = bus.reading(ptId());
  const eligible = !ps()?.active && !plan.pending && plan.attempted === plan.next
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
    ? `COPV press: all steps complete (${why}) — the GN2 loop is holding ${reached} psi until Stop`
    : `Step reached ${reached} psi (${why}) — holding; next target ${plan.targets[plan.next]} psi`, 'info', 4000);
  render();
}

/** The ‹ › carets. Kept inside the plan; DONE is reached only by pressing. */
function moveStep(by) {
  if (ps()?.active) return;
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
  if (!shiftGate(e, `press the GN2 bus to ${a.target} psi`)) return;
  busy = true; tick();
  // Marked before the request, not after: a short step can end and reach
  // this page over the stream before the POST itself has answered. Any step
  // that STARTED after this click is ours — the server runs one at a time.
  plan.pending = { since: bus.serverNow() - 1000, startedAt: null };
  save();
  try {
    const res = await bus.post('/api/press-step', { target: a.target, timeoutMs: Math.round(plan.timeoutS * 1000) });
    if (!res.ok) plan.pending = null;
    else if (plan.pending) plan.pending.startedAt = res.state?.pressStep?.active?.startedAt ?? null;
    save();
  } finally { busy = false; tick(); }
}

/** Stop is the safe direction, so it takes no SHIFT. */
async function stopRun() {
  if (busy) return;
  busy = true; tick();
  try { await bus.post('/api/press-step', { stop: true, reason: 'stopped by operator' }); }
  finally { busy = false; tick(); }
}

async function vent(e) {
  if (busy) return;
  const ventId = ps()?.vent || 'GN2-VENT';
  const open = bus.valveState(ventId) === 'open';
  // Sealing is away from the vent's safe state, so it takes SHIFT like any
  // other valve. Venting never does.
  if (open && !shiftGate(e, `seal ${valveName(ventId)}`)) return;
  busy = true; tick();
  try {
    if (open) await bus.commandValve(ventId, 'closed');
    else await bus.post('/api/press-step', { vent: true });
  } finally { busy = false; tick(); }
}

/**
 * When THIS station's step comes back: on target, move on now; short of it,
 * mark the target attempted, so a settle over it moves the plan on later.
 */
function onState() {
  if (!plan) return;
  const last = ps()?.last;
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
  if (ps()?.active) {
    toast('A press step is in progress — wait for it to end, Stop, or Vent', 'warn');
    return;
  }
  if (ctrl()?.enabled) toast('The GN2 loop is still holding the bus — C reopens the tool to Stop it', 'warn', 5000);
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
    if (!p || !Array.isArray(p.targets)) return null;
    // A plan saved by the valve-actuation version of this tool had a max
    // open time in place of the step timeout.
    p.timeoutS ??= DEFAULT_TIMEOUT_S;
    delete p.maxS;
    delete p.sensor;
    return p;
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
