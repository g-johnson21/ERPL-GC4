/* page-pid.js — live P&ID: schematic actuation + instrumentation in one view.
 *
 * The whole drawing is generated from config.pid — components, pipe routing,
 * fluid colours — plus the `pid` block on each valve and sensor. Move a symbol
 * by editing coordinates in stand.json; nothing here needs to change.
 */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { $, el, icon, fmtValue, fmtCurrent, coilState, shiftGate, toast } from './util.js';
import { svgEl, renderComponent, renderValve, renderInstrument, renderPipe, renderJunction } from './pid-symbols.js';

const content = await bootPage('pid');
const P = bus.config.pid;

// ------------------------------------------------------------------ shell --

const stage = el('div.pid-stage#pid-stage');
content.append(
  el('div.page-head', {},
    el('h1', { text: 'P&ID' }),
    el('span.sub', { text: bus.config.meta.subtitle || bus.config.meta.standName })
  ),
  stage
);

const svg = svgEl('svg', {
  id: 'pid-svg',
  width: '100%',
  height: '100%',
  viewBox: `0 0 ${P.width} ${P.height}`,
  preserveAspectRatio: 'xMidYMid meet',
});
stage.append(svg);

// Fluid colours become CSS variables so tank fills can reference them.
for (const [key, f] of Object.entries(P.fluids)) {
  document.documentElement.style.setProperty(`--fluid-${key}`, f.color);
}

svg.append(svgEl('defs', {},
  (() => {
    const grad = svgEl('linearGradient', { id: 'plume-gradient', x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.append(
      svgEl('stop', { offset: '0%', 'stop-color': '#fff7ed', 'stop-opacity': '0.95' }),
      svgEl('stop', { offset: '35%', 'stop-color': '#fb923c', 'stop-opacity': '0.75' }),
      svgEl('stop', { offset: '100%', 'stop-color': '#ef4444', 'stop-opacity': '0' })
    );
    return grad;
  })()
));

const world = svgEl('g', { id: 'pid-world' });
svg.append(world);

const layerPipes = svgEl('g', { id: 'layer-pipes' });
const layerFlow = svgEl('g', { id: 'layer-flow' });
const layerJunctions = svgEl('g', { id: 'layer-junctions' });
const layerComponents = svgEl('g', { id: 'layer-components' });
const layerValves = svgEl('g', { id: 'layer-valves' });
const layerInstruments = svgEl('g', { id: 'layer-instruments' });
world.append(layerPipes, layerFlow, layerJunctions, layerComponents, layerValves, layerInstruments);

// ------------------------------------------------------------------ build --

for (const pipe of P.pipes) {
  const { base, flow } = renderPipe(pipe, P.fluids);
  layerPipes.append(base);
  layerFlow.append(flow);
}

for (const [key, junction] of detectJunctions(P.pipes)) {
  void key;
  layerJunctions.append(renderJunction(junction.x, junction.y, junction.color));
}

for (const comp of P.components) layerComponents.append(renderComponent(comp));

// Title-block logos follow the theme, so a black mark does not vanish on dark.
function syncLogos() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  for (const comp of P.components) {
    if (comp.type !== 'logo') continue;
    const img = document.getElementById(`logo-${comp.id}`);
    if (img) img.setAttribute('href', (dark && comp.srcDark) || comp.src);
  }
}
window.addEventListener('themechange', syncLogos);
syncLogos();

for (const valve of bus.config.valves) {
  if (!valve.pid) continue;
  const group = bus.group(valve.group);
  const node = renderValve(valve, group?.color || '#64748b');
  node.addEventListener('click', (e) => onValveActivate(valve, e));
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onValveActivate(valve, e); }
  });
  layerValves.append(node);
}

for (const sensor of bus.config.sensors) {
  const node = renderInstrument(sensor, bus.sensorGroup(sensor.id));
  if (node) layerInstruments.append(node);
}

// The toolbar is built at the bottom of this module, after the pan/zoom state
// it closes over has been initialized.

// ------------------------------------------------------------ interaction --

/** Commands fire immediately, and away from safe needs SHIFT — see page-grid.js. */
function onValveActivate(valve, event) {
  const current = bus.valveState(valve.id);
  const next = current === 'open' ? 'closed' : 'open';
  const gate = bus.canCommand(valve.id, next);
  if (!gate.ok) return;

  if (next !== valve.safeState && !shiftGate(event, `${next === 'open' ? 'open' : 'close'} ${valve.name}`)) return;

  bus.commandValve(valve.id, next);
}

// ----------------------------------------------------------- pan and zoom --

const view = { k: 1, x: 0, y: 0 };
let viewLocked = loadPref('gc4-pid-locked', false);

function applyView() {
  world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  const label = $('#zoom-level');
  if (label) label.textContent = `${Math.round(view.k * 100)}%`;
}

/**
 * Client pixel -> the SVG's own user units, via the live screen CTM.
 * Doing this by hand from getBoundingClientRect has to reproduce the
 * preserveAspectRatio letterboxing exactly; the CTM already knows it.
 */
function toUserSpace(clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
}

/** Zoom by `factor`, keeping the drawing point under (clientX, clientY) fixed. */
function zoomAt(clientX, clientY, factor) {
  if (viewLocked) return;
  const p = toUserSpace(clientX, clientY);
  const next = Math.min(6, Math.max(0.3, view.k * factor));
  view.x = p.x - ((p.x - view.x) * next) / view.k;
  view.y = p.y - ((p.y - view.y) * next) / view.k;
  view.k = next;
  applyView();
}

/** Centre of the visible stage, in client pixels — the anchor for button zoom. */
function stageCentre() {
  const r = stage.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function zoomByButton(factor) {
  const c = stageCentre();
  zoomAt(c.x, c.y, factor);
}

stage.addEventListener('wheel', (e) => {
  if (viewLocked) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

let dragging = null;
stage.addEventListener('pointerdown', (e) => {
  // Never start a pan from a control. Capturing the pointer here would
  // redirect the following pointerup, so the toolbar buttons would never
  // receive a click at all.
  if (e.target.closest('.pid-valve, .pid-toolbar, .pid-legend')) return;
  if (viewLocked || e.button !== 0) return;
  dragging = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  stage.classList.add('panning');
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  // Convert the drag delta into user units through the CTM scale.
  const ctm = svg.getScreenCTM();
  const perPixel = ctm ? 1 / ctm.a : 1;
  view.x = dragging.vx + (e.clientX - dragging.x) * perPixel;
  view.y = dragging.vy + (e.clientY - dragging.y) * perPixel;
  applyView();
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = null;
  stage.classList.remove('panning');
  if (e?.pointerId !== undefined && stage.hasPointerCapture?.(e.pointerId)) {
    stage.releasePointerCapture(e.pointerId);
  }
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

function resetView() {
  if (viewLocked) return;
  view.k = 1; view.x = 0; view.y = 0;
  applyView();
}

function setLocked(locked) {
  viewLocked = locked;
  savePref('gc4-pid-locked', locked);
  stage.dataset.locked = String(locked);
  const btn = $('#pid-lock');
  if (btn) {
    btn.classList.toggle('active', locked);
    btn.title = locked
      ? 'View locked — click to allow pan and zoom (L)'
      : 'Lock the view so it cannot be panned or zoomed by accident (L)';
    btn.setAttribute('aria-pressed', String(locked));
    btn.innerHTML = icon(locked ? 'lock' : 'unlock', 15);
  }
  for (const b of document.querySelectorAll('.pid-zoom-ctl')) b.disabled = locked;
  if (locked) endDrag();
}

document.addEventListener('keydown', (e) => {
  // `instanceof Element` because a key event can be targeted at the document
  // itself, which has no `matches` — and an exception thrown here takes the
  // rest of the view hotkeys down with it.
  if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;
  if (e.key === '0') resetView();
  if (e.key === '+' || e.key === '=') zoomByButton(1.2);
  if (e.key === '-') zoomByButton(1 / 1.2);
  if (e.key.toLowerCase() === 'l' && !e.ctrlKey && !e.metaKey) setLocked(!viewLocked);
});

function buildToolbar() {
  stage.append(el('div.pid-toolbar', {},
    el('button.icon-btn.pid-zoom-ctl', { title: 'Zoom out (−)', text: '−', onclick: () => zoomByButton(1 / 1.2) }),
    el('div.pid-zoom-level#zoom-level', { text: '100%' }),
    el('button.icon-btn.pid-zoom-ctl', { title: 'Zoom in (+)', text: '+', onclick: () => zoomByButton(1.2) }),
    el('button.icon-btn.pid-zoom-ctl', { title: 'Reset view (0)', html: icon('refresh', 15), onclick: resetView }),
    el('button.icon-btn#pid-lock', { onclick: () => setLocked(!viewLocked) }),
    ...levelTareChips()
  ));
  setLocked(viewLocked);
}

/**
 * Zero controls for the computed tank levels.
 *
 * Deliberately its own pair of chips rather than a row on the Data page's tare
 * table: this zeroes the DIFFERENCE between a tank's two transducers, not
 * either transducer, so it must not read as one more sensor tare. Nothing a
 * bang-bang loop regulates on moves.
 */
function levelTareChips() {
  if (!P.components.some((c) => c.type === 'tank' && c.level)) return [];
  return [
    el('button.tare-chip#pid-level-tare', {
      title: 'Zero the tank levels against their current pressures.\n'
        + 'Only the level readout moves — both PTs keep reporting what they do now.',
      text: 'TARE LEVELS',
      onclick: () => runLevelTare(false),
    }),
    el('button.tare-chip.clear.hidden#pid-level-untare', {
      title: 'Clear the tank level zero',
      text: 'CLR',
      onclick: () => runLevelTare(true),
    }),
  ];
}

async function runLevelTare(clear) {
  const res = await bus.tareTankLevels(undefined, { clear });
  if (!res.ok) return;
  toast(clear ? 'Tank level zero cleared' : `Tank levels zeroed — ${res.tared.join(', ')}`, 'ok');
}

/** Show the clear chip, and flag the tare chip, only while a zero is applied. */
function updateLevelTareChips() {
  const chip = $('#pid-level-tare');
  if (!chip) return;
  const tanks = P.components.filter((c) => c.type === 'tank' && c.level);
  const tared = tanks.filter((c) => bus.tankLevelTare(c.id) !== 0);
  chip.classList.toggle('on', tared.length > 0);
  $('#pid-level-untare')?.classList.toggle('hidden', tared.length === 0);
}

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

function buildLegend() {
  stage.append(el('div.pid-legend', {},
    Object.entries(P.fluids).map(([key, f]) =>
      el('span.lg', {}, el('i', { style: { background: f.color } }), f.label || key)
    )
  ));
}

// ------------------------------------------------------------ tank level --

/** Configured tank height in inches — the column a full tank stands in. */
function tankHeightIn() {
  const h = Number(bus.config.ui?.tankLevel?.heightIn);
  return Number.isFinite(h) && h > 0 ? h : 70;
}

/**
 * The pressure at a tank's ullage, in psi.
 *
 * `topSensor` is a DAQ channel; `topController` is the bang-bang board's OWN
 * transducer, reported over the heartbeat rather than sampled here. The board
 * pressure is only trusted while the heartbeat is fresh — a stale reading held
 * from before a fill would show a level that is pure fiction.
 */
function ullagePsi(level) {
  if (level.topSensor) return bus.reading(level.topSensor);
  if (!level.topController) return null;
  const board = bus.state?.controllers?.[level.topController]?.board;
  if (!board || board.stale) return null;
  return Number.isFinite(board.pressure) ? board.pressure : null;
}

/**
 * Liquid level in inches from the hydrostatic head between the tank bottom
 * and the ullage, or null when the tank is not set up for it, the feature is
 * switched off, or either pressure is missing.
 *
 *   dP[psi] = rho[lb/ft^3] * h[ft] / 144   ->   h[in] = 1728 * dP / rho
 *
 * The result is clamped to the tank: a small negative dP is transducer offset,
 * not a tank below empty, and either way a bar cannot be drawn outside its
 * vessel. Densities live in config because they are properties of the
 * propellant, and a cryogen's changes with how cold it actually is.
 */
function tankLevelInches(comp) {
  if (bus.config.ui?.tankLevel?.enabled === false) return null;
  const level = comp.level;
  if (!level) return null;

  const rho = Number(level.density);
  if (!Number.isFinite(rho) || rho <= 0) return null;

  const bottom = level.bottomSensor ? bus.reading(level.bottomSensor) : null;
  const top = ullagePsi(level);
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) return null;

  const tare = bus.tankLevelTare(comp.id);
  const inches = (1728 * (bottom - top - tare)) / rho;
  // Smooth first, clamp second. Clamping into the filter would let an empty
  // tank's noise pile up against the 0 rail and drift the average positive.
  return Math.max(0, Math.min(tankHeightIn(), smoothLevel(comp.id, inches, tare)));
}

/**
 * Heavy low-pass on the level, because the number behind it is a small
 * difference between two large pressures.
 *
 * A 70 in column of IPA is about 2 psi. Two 1500 psi transducers each carrying
 * a psi or so of noise therefore produce a level that swings tens of inches
 * frame to frame — unreadable, and worse, it looks like the tank is doing it.
 * The time constant is long on purpose: a fill takes tens of seconds, so
 * several seconds of lag costs nothing an operator was going to act on.
 *
 * Exponential with a dt-derived weight rather than a fixed one, so the lag
 * stays the configured number of SECONDS whatever rate the stream runs at.
 */
const levelFilter = new Map();   // tank id -> { v, t, tare }

function smoothingSeconds() {
  const s = Number(bus.config.ui?.tankLevel?.smoothingSeconds);
  return Number.isFinite(s) && s >= 0 ? s : 5;
}

function smoothLevel(id, raw, tare) {
  const now = bus.state?.t ?? Date.now();
  const tau = smoothingSeconds();
  const prev = levelFilter.get(id);

  // A tare is an instruction to call this level zero NOW. Gliding to the new
  // zero over the time constant would leave the operator watching the number
  // they just corrected creep down for the next several seconds.
  if (!prev || tau <= 0 || prev.tare !== tare) {
    levelFilter.set(id, { v: raw, t: now, tare });
    return raw;
  }

  const dt = Math.max(0, (now - prev.t) / 1000);
  const v = prev.v + (1 - Math.exp(-dt / tau)) * (raw - prev.v);
  levelFilter.set(id, { v, t: now, tare });
  return v;
}

// ----------------------------------------------------------------- update --

buildToolbar();
buildLegend();

bus.on('state', update);
update();
applyView();

function update() {
  if (!bus.state) return;

  // --- pipes: animate flow when every gating valve is open ---
  for (const pipe of P.pipes) {
    const flowing = (pipe.flowWhen || []).length > 0
      && pipe.flowWhen.every((id) => bus.valveState(id) === 'open');
    const base = document.getElementById(`pipe-${pipe.id}`);
    const flow = document.getElementById(`flow-${pipe.id}`);
    if (base) base.dataset.flowing = String(flowing);
    if (flow) flow.setAttribute('opacity', flowing ? '0.85' : '0');
  }

  // --- valves ---
  for (const valve of bus.config.valves) {
    const node = document.getElementById(`pv-${valve.id}`);
    if (!node) continue;
    const state = bus.valveState(valve.id);
    node.dataset.state = state;

    const label = document.getElementById(`pvs-${valve.id}`);
    if (label) label.textContent = state === 'open' ? valve.openLabel : valve.closedLabel;

    const next = state === 'open' ? 'closed' : 'open';
    const gate = bus.canCommand(valve.id, next);
    node.dataset.locked = String(!gate.ok);
    // Lights up while SHIFT is held — the same guard the Control Grid uses.
    node.dataset.needsShift = String(gate.ok && next !== valve.safeState);

    updateCoil(valve, state);
  }

  updateInstruments();
  updateLevelTareChips();
}

/**
 * Paint one valve's coil indicator from the current sense.
 *
 * The comparison is against COIL state, not flow state. A normally-open valve
 * is energized to CLOSE, so a NO vent sitting open should read de-energized
 * and one commanded shut should read energized. Comparing against flow state
 * instead would mark every normally-open valve on the stand as faulted,
 * permanently — the fastest way to teach an operator to ignore the indicator.
 *
 *   off      de-energized, as commanded
 *   on       energized, as commanded
 *   fault    the coil is not doing what it was told
 *   unknown  no current sense on this channel, so nothing is claimed
 */
function updateCoil(valve, state) {
  const dot = document.getElementById(`pvc-${valve.id}`);
  if (!dot) return;

  const dc = bus.state.valves?.[valve.id]?.dc;
  const coil = coilState(valve, state, dc);
  dot.dataset.coil = coil;

  if (coil === 'unknown') {
    // Hidden, not grey. Grey is a measurement meaning "de-energized"; a valve
    // nobody is measuring must not borrow that claim.
    dot.firstChild.textContent = '';
    return;
  }

  const shouldEnergize = valve.normallyOpen ? state === 'closed' : state === 'open';
  const agrees = coil !== 'fault';
  dot.firstChild.textContent =
    `${dc.id}: coil ${dc.energized ? 'ENERGIZED' : 'de-energized'} · ${fmtCurrent(dc.amps)}\n` +
    `commanded ${state.toUpperCase()}, expects ${shouldEnergize ? 'energized' : 'de-energized'}` +
    (agrees ? '' : '\n*** MISMATCH — the coil is not doing what it was told ***');
}

function updateInstruments() {
  // --- instruments ---
  for (const sensor of bus.config.sensors) {
    const node = document.getElementById(`pi-${sensor.id}`);
    if (!node) continue;
    node.dataset.status = bus.sensorStatus(sensor.id);
    const text = document.getElementById(`pir-${sensor.id}`);
    if (text) text.textContent = fmtValue(bus.reading(sensor.id), sensor.decimals);
  }

  // --- tank levels ---
  for (const comp of P.components) {
    if (comp.type !== 'tank') continue;
    const rect = document.getElementById(`level-${comp.id}`);
    const text = document.getElementById(`tanklevel-${comp.id}`);
    if (!rect) continue;
    const h = comp.h ?? 220;

    // Differential pressure wins when it is configured and enabled: it is a
    // direct measurement of the liquid column, where levelSensor is whatever
    // proxy the tank happened to have.
    const inches = tankLevelInches(comp);
    let frac;
    if (inches !== null) {
      frac = Math.max(0, Math.min(1, inches / tankHeightIn()));
      if (text) text.textContent = `${inches.toFixed(1)} in`;
    } else {
      if (text) text.textContent = '';
      if (!comp.levelSensor) continue;
      const value = bus.reading(comp.levelSensor) ?? 0;
      frac = Math.max(0, Math.min(1, value / (comp.levelMax || 100)));
    }

    const fillH = frac * h;
    rect.setAttribute('y', String(h / 2 - fillH));
    rect.setAttribute('height', String(fillH));
  }

  // --- engine plume ---
  for (const comp of P.components) {
    if (comp.type !== 'engine') continue;
    const plume = document.getElementById(`plume-${comp.id}`);
    if (!plume) continue;
    const sensorId = comp.plumeSensor;
    const value = sensorId ? bus.reading(sensorId) : null;
    const threshold = comp.plumeThreshold ?? 50;
    const max = bus.sensor(sensorId)?.max ?? 500;
    const intensity = Number.isFinite(value) && value > threshold
      ? Math.min(1, (value - threshold) / (max - threshold))
      : 0;
    plume.setAttribute('opacity', String(intensity));
  }
}

// ------------------------------------------------------------------ utils --

/** A coordinate touched by two or more pipes is a tee — mark it with a dot. */
function detectJunctions(pipes) {
  const seen = new Map();
  for (const pipe of pipes) {
    const fluid = bus.config.pid.fluids[pipe.fluid];
    for (const [x, y] of pipe.points) {
      const key = `${x},${y}`;
      if (!seen.has(key)) seen.set(key, { x, y, color: fluid?.color || '#888', count: 0, pipes: new Set() });
      const entry = seen.get(key);
      entry.pipes.add(pipe.id);
      entry.count++;
    }
  }
  return [...seen.entries()].filter(([, j]) => j.pipes.size > 1);
}
