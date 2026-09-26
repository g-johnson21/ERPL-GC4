/* page-pid.js — live P&ID: schematic actuation + instrumentation in one view.
 *
 * The whole drawing is generated from config.pid — components, pipe routing,
 * fluid colours — plus the `pid` block on each valve and sensor. Move a symbol
 * by editing coordinates in stand.json; nothing here needs to change.
 */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { fitSidebar } from './sidebar-fit.js';
import { $, el, icon, fmtValue, fmtRate, fmtCurrent, coilState, shiftGate, toast } from './util.js';
import {
  svgEl, svgText, renderComponent, renderValve, renderInstrument, renderPipe, renderJunction,
  tileTraceBox, lineWidth, symbolDefs,
} from './pid-symbols.js';
import { WINDOWS, windowChips, tracePath, drawTrace, statusColor, cssVar, windowed } from './spark.js';
import { attachValveTip } from './valve-tip.js';

const content = await bootPage('pid');
fitSidebar();
const P = bus.config.pid;

// ------------------------------------------------------------------ shell --

// NO PAGE HEADING HERE, deliberately.
//
// It read "P&ID / LOX / Ethanol Bi-Propellant Test Stand" and cost about 38px
// that the stage's `calc(100vh - header - padding)` never accounted for, so
// the page scrolled by exactly the height of the heading and the bottom of the
// drawing sat under the fold. On a page whose whole point is one glance at the
// whole stand, that is the worst 38px on the screen.
//
// Nothing is lost with it gone: the drawing carries its own title block --
// the stand name and the fluid summary, in the corner where a drawing puts
// them -- and the page is already named in the nav and the browser tab.
const stage = el('div.pid-stage#pid-stage');
content.append(stage);

// The schematic is fitted to the stage's width, so the page gives up its
// horizontal padding and lets the stage run to the window edge -- see
// `.pid-page` in pid.css.
content.classList.add('pid-page');

const svg = svgEl('svg', {
  id: 'pid-svg',
  width: '100%',
  height: '100%',
  viewBox: `0 0 ${P.width} ${P.height}`,
  // Top-left anchored, so the schematic stays against the window edge, away
  // from the sidebar, and the default view below zooms out from that corner.
  preserveAspectRatio: 'xMinYMin meet',
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
  })(),
  symbolDefs()
));

const world = svgEl('g', { id: 'pid-world' });
svg.append(world);

// Regions (the vehicle outline, the hashed GSE boxes) sit under everything,
// so a pipe running into a box is never painted over by it.
const layerRegions = svgEl('g', { id: 'layer-regions' });
const layerPipes = svgEl('g', { id: 'layer-pipes' });
const layerFlow = svgEl('g', { id: 'layer-flow' });
const layerJunctions = svgEl('g', { id: 'layer-junctions' });
const layerComponents = svgEl('g', { id: 'layer-components' });
const layerValves = svgEl('g', { id: 'layer-valves' });
const layerInstruments = svgEl('g', { id: 'layer-instruments' });
world.append(layerRegions, layerPipes, layerFlow, layerJunctions, layerComponents, layerValves, layerInstruments);

// ------------------------------------------------------------------ build --

for (const pipe of P.pipes) {
  const { base, flow } = renderPipe(pipe, P.fluids);
  layerPipes.append(base);
  layerFlow.append(flow);
}

// Kept so a tee can light up with the lines that meet at it.
const junctions = detectJunctions(P.pipes).map(([key, j]) => {
  const node = renderJunction(j.x, j.y, j.color);
  layerJunctions.append(node);
  return { key, node, pipes: j.pipes };
});

for (const comp of P.components) {
  (comp.type === 'region' ? layerRegions : layerComponents).append(renderComponent(comp));
}

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
  // The hover card replaces the symbol's static <title>: it counts how long
  // the valve has been in its position, live, where a <title> is frozen.
  node.querySelector(':scope > title')?.remove();
  attachValveTip(node, valve);
  if (bus.spectator) {
    node.removeAttribute('tabindex');
    node.setAttribute('role', 'img');
  } else {
    node.addEventListener('click', (e) => onValveActivate(valve, e));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onValveActivate(valve, e); }
    });
  }
  layerValves.append(node);
}

for (const sensor of bus.config.sensors) {
  const node = renderInstrument(sensor, bus.sensorGroup(sensor.id));
  if (!node) continue;
  node.addEventListener('pointerenter', () => openHoverCard(sensor));
  node.addEventListener('pointerleave', () => closeHoverCard(sensor));
  layerInstruments.append(node);
}

// The toolbar is built at the bottom of this module, after the pan/zoom state
// it closes over has been initialized.

// ------------------------------------------------------------ interaction --

/** Commands fire immediately, and away from safe needs SHIFT — see page-grid.js. */
function onValveActivate(valve, event) {
  if (bus.spectator) return;
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

/**
 * The default view: the drawing's CONTENTS -- not its padded canvas --
 * zoomed to 110%, from the top-left corner.
 *
 * 110% is a ceiling, not a demand. When the stage cannot show every symbol,
 * tile and label at that zoom (a narrow stage beside the sidebar, where the
 * drawing is already as wide as the stage), the view settles at the largest
 * zoom that still does. Cropping the fuel-side bottles or the pneumatics
 * off the right edge to hit a round number would be the drawing lying about
 * what is on the stand.
 */
const DEFAULT_ZOOM = 1.1;
const FIT_MARGIN = 6;           // drawing units kept clear round the contents
let viewTouched = false;        // set once the operator pans or zooms
let contentBox = null;

function measureContent() {
  // The plume is drawn below the nozzle but is invisible at rest; it must
  // not count as content, or the fit leaves room for an exhaust that is not
  // there.
  const plumes = [...world.querySelectorAll('.sym-plume')];
  for (const p of plumes) p.style.display = 'none';
  const b = world.getBBox();
  for (const p of plumes) p.style.display = '';
  return { x: b.x - FIT_MARGIN, y: b.y - FIT_MARGIN, w: b.width + 2 * FIT_MARGIN, h: b.height + 2 * FIT_MARGIN };
}

function fitView() {
  const ctm = svg.getScreenCTM();
  // The drawing's own area: the stage less the toolbar strip above it.
  const r = svg.getBoundingClientRect();
  if (!ctm || !r.width || !r.height) return;
  contentBox ??= measureContent();
  const s = ctm.a;              // screen pixels per drawing unit at 100%
  const fit = Math.min(r.width / (contentBox.w * s), r.height / (contentBox.h * s));
  view.k = Math.min(DEFAULT_ZOOM, fit);
  view.x = -view.k * contentBox.x;
  view.y = -view.k * contentBox.y;
  applyView();
}

// Follow the window until the operator takes the view over themselves.
new ResizeObserver(() => { if (!viewTouched) fitView(); }).observe(stage);

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
  viewTouched = true;
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
  if (e.target.closest('.pid-valve, .pid-toolbar, .pid-legend, .sim-manual, .sim-reg, .pid-popover')) return;
  if (viewLocked || e.button !== 0) return;
  dragging = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  viewTouched = true;
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
  viewTouched = false;
  fitView();
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
    btn.innerHTML = icon(locked ? 'lock' : 'unlock', 14);
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
  if (e.key.toLowerCase() === 'k' && !e.ctrlKey && !e.metaKey) toggleLegend();
});

function buildToolbar() {
  const tare = levelTareChips();
  stage.append(el('div.pid-toolbar', {},
    // The trend window for every value tile on the drawing and the hover card.
    el('span.pid-tb-label', { text: 'TREND' }),
    windowChips(el, trendSeconds, (s) => {
      trendSeconds = s;
      try { localStorage.setItem('gc4-pid-window', String(s)); } catch { /* ignore */ }
      lastTraceAt = 0;
      updateTraces();
    }, 'Trend window for the value tiles'),
    el('span.pid-tb-sep'),
    el('button.icon-btn.pid-zoom-ctl', { title: 'Zoom out (−)', text: '−', onclick: () => zoomByButton(1 / 1.2) }),
    el('div.pid-zoom-level#zoom-level', { text: '100%' }),
    el('button.icon-btn.pid-zoom-ctl', { title: 'Zoom in (+)', text: '+', onclick: () => zoomByButton(1.2) }),
    el('button.icon-btn.pid-zoom-ctl', { title: 'Reset view (0)', html: icon('refresh', 14), onclick: resetView }),
    el('button.icon-btn#pid-lock', { onclick: () => setLocked(!viewLocked) }),
    tare.length ? el('span.pid-tb-sep') : null,
    ...tare,
    el('span.pid-tb-sep'),
    el('button.pid-key-btn#pid-key-btn', {
      title: 'Show the key: line colours and valve states (K)',
      'aria-expanded': 'false',
      text: 'KEY',
      onclick: () => toggleLegend(),
    }),
    el('span.pid-tb-sep'),
    // Data freshness: when the reading on screen was taken. A frozen drawing
    // and a quiet stand look identical; this is what tells them apart.
    el('span.pid-stamp', { title: 'Time of the snapshot on screen' },
      el('span.pid-stamp-dot#pid-stamp-dot'),
      el('span.pid-stamp-t#pid-stamp-t', { text: '--:--:--.-' })
    )
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
  if (bus.spectator) return [];
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

/**
 * The key: what each line colour carries, then what a live line and an open
 * valve look like. A line drawn grey is not a different fluid -- it is the
 * same line at rest -- and the key says so, or the first operator to see a
 * dim LOX run will ask where the LOX went.
 *
 * It opens from the toolbar rather than living on the canvas. Pinned to a
 * corner it either covered part of the drawing or forced the drawing to give
 * up a strip of the screen to make room for it -- and the key is read once,
 * the drawing all day.
 */
function buildLegend() {
  stage.append(el('div.pid-legend', { hidden: true },
    el('div.lg-row', {},
      Object.entries(P.fluids).map(([key, f]) =>
        el('span.lg', {}, el('i', { style: { background: f.color } }), f.label || key)
      )
    ),
    el('div.lg-row.lg-states', {},
      el('span.lg', {}, el('i.lg-idle'), 'at rest'),
      el('span.lg', {}, el('i.lg-live'), 'pressurized / flowing'),
      el('span.lg', {}, el('b.lg-chip.open', { text: 'OPEN' }), el('b.lg-chip', { text: 'CLOSED' }))
    )
  ));
}

function toggleLegend(open) {
  const legend = $('.pid-legend');
  if (!legend) return;
  const show = open ?? legend.hidden;
  legend.hidden = !show;
  const btn = $('#pid-key-btn');
  btn?.classList.toggle('active', show);
  btn?.setAttribute('aria-expanded', String(show));
}

function updateStamp() {
  const t = bus.state?.t;
  const node = $('#pid-stamp-t');
  if (!node || !t) return;
  const d = new Date(t);
  const pad = (n, k = 2) => String(n).padStart(k, '0');
  node.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
  const age = Date.now() - t;
  $('#pid-stamp-dot').dataset.state = age < 1500 ? 'live' : age < 5000 ? 'late' : 'stale';
}

// --------------------------------------------------------- value tile trends --

let trendSeconds = (() => {
  let v = 30;
  try { v = Number(localStorage.getItem('gc4-pid-window')) || 30; } catch { /* ignore */ }
  return WINDOWS.some((w) => w.s === v) ? v : 30;
})();

/**
 * Redraw the hairline trace in each value tile. Throttled to ~6 Hz: a trace
 * eight pixels tall does not visibly change between frames at the stream
 * rate, and twenty of them rebuilt at 50 Hz is work for nothing.
 */
let lastTraceAt = 0;
function updateTraces() {
  const now = Date.now();
  if (now - lastTraceAt < 160) return;
  lastTraceAt = now;
  for (const sensor of bus.config.sensors) {
    if (!sensor.pid) continue;
    const path = document.getElementById(`pis-${sensor.id}`);
    if (!path) continue;
    const b = tileTraceBox(sensor);
    path.setAttribute('d', tracePath(bus.history.get(sensor.id), trendSeconds, b.w, b.h, b.x, b.y, now));
  }
}

// ---------------------------------------------------------------- hover card --

/**
 * Hovering a value tile opens a card beside it with the channel's full name,
 * a readable trend over the same window as the tiles, and its extremes. The
 * tile answers "what is it"; the card answers "what has it been doing" without
 * leaving the drawing for the Data page.
 */
let hover = null;   // { sensor, node }

function openHoverCard(sensor) {
  if (dragging) return;
  closeHoverCard();
  const group = bus.sensorGroup(sensor.id);
  const node = el('div.pid-hovercard', { style: { '--group-color': group?.color || '#64748b' } },
    el('div.phc-head', {},
      el('span.phc-eyebrow', {}, el('span.group-swatch'), group?.label || 'Sensor'),
      el('span.phc-ch', { text: `ch ${sensor.channel}` })
    ),
    el('div.phc-name', {}, el('span.phc-tag', { text: sensor.id }), sensor.name),
    el('div.phc-value', {},
      el('span#phc-v', { text: '––––' }),
      el('span.phc-unit', { text: sensor.units }),
      el('span.phc-rate#phc-rate', { text: '' })
    ),
    el('canvas.phc-trace#phc-trace'),
    el('div.phc-foot', {},
      el('span', {}, el('i', { text: 'MIN ' }), el('span#phc-min', { text: '––' })),
      el('span', {}, el('i', { text: 'MAX ' }), el('span#phc-max', { text: '––' })),
      el('span.phc-win#phc-win', { text: '' })
    )
  );
  stage.append(node);
  hover = { sensor, node };
  placeHoverCard();
  updateHoverCard();
}

function closeHoverCard(sensor) {
  if (!hover || (sensor && hover.sensor !== sensor)) return;
  hover.node.remove();
  hover = null;
}

/** Beside the tile, on whichever side has room, clamped inside the stage. */
function placeHoverCard() {
  const tile = document.getElementById(`pi-${hover.sensor.id}`)?.querySelector('.pid-tile');
  if (!tile) return;
  const s = stage.getBoundingClientRect();
  const t = tile.getBoundingClientRect();
  const cw = hover.node.offsetWidth, ch = hover.node.offsetHeight;
  let x = t.right - s.left + 10;
  if (x + cw > s.width - 8) x = t.left - s.left - cw - 10;
  let y = t.top - s.top + t.height / 2 - ch / 2;
  y = Math.max(8, Math.min(s.height - ch - 8, y));
  hover.node.style.left = `${Math.max(8, x)}px`;
  hover.node.style.top = `${y}px`;
}

function updateHoverCard() {
  if (!hover) return;
  const { sensor, node } = hover;
  const status = bus.sensorStatus(sensor.id);
  node.dataset.status = status;
  $('#phc-v').textContent = fmtValue(bus.reading(sensor.id), sensor.decimals);
  const rate = fmtRate(bus.rate(sensor.id, 3), sensor);
  const r = $('#phc-rate');
  r.textContent = rate.text;
  r.dataset.dir = rate.dir;

  const series = bus.history.get(sensor.id);
  const win = windowed(series, trendSeconds, 1);
  $('#phc-min').textContent = win ? fmtValue(win.lo, sensor.decimals) : '––';
  $('#phc-max').textContent = win ? fmtValue(win.hi, sensor.decimals) : '––';
  $('#phc-win').textContent = WINDOWS.find((w) => w.s === trendSeconds)?.label ?? '';

  drawTrace($('#phc-trace'), series, trendSeconds, {
    color: statusColor(status),
    fill: status === 'danger' || status === 'warn',
    grid: cssVar('--border', '#232326'),
    axis: cssVar('--text-faint', '#6b6b70'),
  });
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

// Declared ahead of the first update(): that call runs the simulator hook,
// which reads this flag before the block that defines the hook is reached.
let simWired = false;

buildToolbar();
buildLegend();

bus.on('state', update);
update();
fitView();

// ------------------------------------------------------- simulator controls --
//
// Hand valves and regulators have no channel on the stand; a person turns
// them. The simulator exposes them, and while it is the driver the P&ID lets
// the operator work them from the drawing -- so a fill, a drain or a purge
// bus vent can be rehearsed the way the real one happens, at the valve.
// Wired once, on the first snapshot that carries a `sim` block, and never on
// hardware, where that block is absent.

function wireSimControls() {
  const sim = bus.sim;
  if (!sim || simWired) return;
  simWired = true;
  if (!bus.spectator) stage.classList.add('sim-live');

  for (const [id, hand] of Object.entries(sim.manual || {})) {
    const node = componentNode(id);
    if (!node || bus.spectator) continue;
    node.classList.add('sim-manual');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    node.append(svgEl('title', {}, document.createTextNode(
      `${id} — ${hand.name}\nSimulator: click to open or close this hand valve`)));
    const act = () => bus.simToggleValve(id);
    node.addEventListener('click', act);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); }
    });
  }

  for (const [id, reg] of Object.entries(sim.regulators || {})) {
    const node = componentNode(id);
    if (!node) continue;
    // Set pressures remain visible on the read-only drawing.
    const comp = P.components.find((c) => c.id === id);
    // Under the symbol's own label: inside a single bottle, beside a
    // compressor (whose label is on its right), below everything else.
    const side = comp?.labelSide === 'left' ? -1 : 1;
    const at = comp?.type === 'compressor'
      ? { x: side * ((comp.w ?? 84) / 2 + 8), y: 16, anchor: side < 0 ? 'end' : 'start' }
      : { x: 0, y: comp?.type === 'bottle' ? 18 : 36, anchor: 'middle' };
    node.append(svgText('', { id: `simreg-${id}`, x: at.x, y: at.y, class: 'pid-sublabel sim-set', 'text-anchor': at.anchor }));
    if (bus.spectator) continue;
    node.classList.add('sim-reg');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    node.append(svgEl('title', {}, document.createTextNode(
      `${id} — ${reg.name}\nSimulator: click to set the pressure`)));
    const act = (e) => openRegulatorPopover(id, e);
    node.addEventListener('click', act);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e); }
    });
  }

  // Say so on the legend, where a first-time operator looks for what the
  // colours mean and will look for what the clickable grey symbols mean.
  // Said in the key, and flagged in the toolbar where it is always visible:
  // the key is closed most of the time, and this is the one thing a
  // first-time operator needs to be told about the grey symbols.
  if (!bus.spectator) {
    const note = 'SIM: hand valves and regulators are live — click them';
    $('.pid-legend')?.append(el('span.lg.sim-note', {}, el('i.sim-dot'), note));
    $('.pid-stamp')?.before(el('span.pid-sim-chip', { title: note, text: 'SIM' }), el('span.pid-tb-sep'));
  }
}

function componentNode(id) {
  return layerComponents.querySelector(`[data-comp-id="${CSS.escape(id)}"]`);
}

/** Paint hand-valve positions and regulator set pressures from the snapshot. */
function updateSimControls() {
  const sim = bus.sim;
  if (!sim) return;
  wireSimControls();
  for (const [id, hand] of Object.entries(sim.manual || {})) {
    const node = componentNode(id);
    if (node) node.dataset.state = hand.state;
  }
  for (const [id, reg] of Object.entries(sim.regulators || {})) {
    const text = document.getElementById(`simreg-${id}`);
    if (text) text.textContent = `${reg.psi} psi`;
  }
}

/**
 * A small popover for a regulator's set pressure, placed by the symbol. A
 * number field rather than a prompt(): the range and step come from the
 * simulator, and Escape has to keep meaning "leave it alone".
 */
function openRegulatorPopover(id, event) {
  closePopover();
  const reg = bus.sim?.regulators?.[id];
  if (!reg) return;

  const input = el('input', {
    type: 'number', min: reg.min, max: reg.max, step: reg.step ?? 1, value: reg.psi,
    'aria-label': `${reg.name} set pressure, psi`,
  });
  const submit = async () => {
    const psi = Number(input.value);
    if (!Number.isFinite(psi)) return;
    const res = await bus.simSetRegulator(id, psi);
    if (res.ok) closePopover();
  };
  const pop = el('div.pid-popover', {},
    el('div.pid-popover-title', { text: `${id} · ${reg.name}` }),
    el('div.pid-popover-row', {},
      input,
      el('span.pid-popover-units', { text: `psi  (${reg.min}–${reg.max})` })
    ),
    el('div.pid-popover-actions', {},
      el('button.btn.small', { text: 'Cancel', onclick: closePopover }),
      el('button.btn.small.primary', { text: 'Set', onclick: submit })
    )
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); }
  });
  // Keep a click inside the popover from reaching the stage's pan handler.
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());

  const r = stage.getBoundingClientRect();
  const x = (event?.clientX ?? r.left + r.width / 2) - r.left;
  const y = (event?.clientY ?? r.top + r.height / 2) - r.top;
  pop.style.left = `${Math.min(x + 12, r.width - 240)}px`;
  pop.style.top = `${Math.min(y + 12, r.height - 120)}px`;
  stage.append(pop);
  input.focus();
  input.select();
}

function closePopover() {
  $('.pid-popover')?.remove();
}

document.addEventListener('pointerdown', (e) => {
  if (!(e.target instanceof Element)) return;
  if (e.target.closest('.pid-popover, .sim-reg')) return;
  closePopover();
});

function update() {
  if (!bus.state) return;

  // --- pipes: animate flow when every `flowWhen` valve is open AND at least
  // one `flowAny` valve is. The second list exists for a line fed from two
  // places -- an injector leg that carries propellant through the run valve
  // or purge gas through the purge valve -- where "all open" is never true
  // and would leave the line dead through both. ---
  //
  // A line is drawn BOLD when it is pressurized. Where the section has a
  // transducer (`pressureSensor`) that is the reading against
  // `pid.pressurizedPsi`; where it has none, flow through its valves stands
  // in, so a purge branch bolds while its solenoid is open. Flow dashes
  // animate only for the valve case: a pressurized tank leg is not moving.
  const boldPipes = new Set();
  for (const pipe of P.pipes) {
    const isOpen = (id) => bus.valveState(id) === 'open';
    const all = pipe.flowWhen || [];
    const any = pipe.flowAny || [];
    const flowing = (all.length > 0 || any.length > 0)
      && all.every(isOpen)
      && (any.length === 0 || any.some(isOpen));
    const pressurized = isPressurized(pipe);
    const bold = flowing || pressurized;
    if (bold) boldPipes.add(pipe.id);

    const base = document.getElementById(`pipe-${pipe.id}`);
    const flow = document.getElementById(`flow-${pipe.id}`);
    if (base) {
      base.dataset.flowing = String(flowing);
      base.dataset.pressurized = String(pressurized);
      // Width lives in an inline style (it comes from the fluid), so the
      // bold weight is set the same way rather than fought from CSS.
      base.style.strokeWidth = `${pipeWidth(pipe) + (bold ? 0.75 : 0)}px`;
    }
    if (flow) flow.setAttribute('opacity', flowing ? '0.75' : '0');
  }
  for (const j of junctions) {
    j.node.dataset.on = String([...j.pipes].some((id) => boldPipes.has(id)));
  }

  // --- valves ---
  for (const valve of bus.config.valves) {
    const node = document.getElementById(`pv-${valve.id}`);
    if (!node) continue;
    const state = bus.valveState(valve.id);
    node.dataset.state = state;
    // Under a live bang-bang loop: drawn yellow, labelled BB, and no claim
    // about open or closed — the board is pulsing it and GC is not told each
    // edge. See bangbang.js trackOwnership().
    const owner = bus.valveOwner(valve.id);
    node.dataset.bb = String(Boolean(owner));

    const label = document.getElementById(`pvs-${valve.id}`);
    if (label) label.textContent = owner ? 'BB' : state === 'open' ? valve.openLabel : valve.closedLabel;

    const next = state === 'open' ? 'closed' : 'open';
    const gate = bus.spectator ? { ok: false } : bus.canCommand(valve.id, next);
    node.dataset.locked = String(!bus.spectator && !gate.ok);
    // Lights up while SHIFT is held — the same guard the Control Grid uses.
    node.dataset.needsShift = String(gate.ok && next !== valve.safeState);

    node.setAttribute('aria-label', `${valve.name || valve.id}: ${owner ? 'bang-bang' : state}`);
    updateCoil(valve, state, owner);
  }

  updateInstruments();
  updateTraces();
  updateHoverCard();
  updateStamp();
  updateLevelTareChips();
  updateSimControls();
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
function updateCoil(valve, state, owner = null) {
  const dot = document.getElementById(`pvc-${valve.id}`);
  if (!dot) return;

  const dc = bus.state.valves?.[valve.id]?.dc;

  // A pulsing coil disagrees with the last commanded state half the time by
  // design, so under bang-bang the dot shows the measured current and never
  // claims a fault.
  if (owner) {
    const known = dc && typeof dc.energized === 'boolean';
    dot.dataset.coil = known ? (dc.energized ? 'on' : 'off') : 'unknown';
    dot.firstChild.textContent = known
      ? `${dc.id}: coil ${dc.energized ? 'ENERGIZED' : 'de-energized'} · ${fmtCurrent(dc.amps)}\npulsed by ${owner.name}`
      : '';
    return;
  }
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

    // The free surface rides on top of the liquid. Hidden when the tank is
    // empty or brim full, where an ellipse would be drawn on a head.
    const surface = document.getElementById(`surface-${comp.id}`);
    if (surface) {
      const visible = fillH > 2 && fillH < h - 2;
      surface.setAttribute('display', visible ? 'inline' : 'none');
      if (visible) surface.setAttribute('cy', String(h / 2 - fillH));
    }
  }

  // --- engine plume ---
  for (const comp of P.components) {
    if (comp.type !== 'engine') continue;
    const plume = document.getElementById(`plume-${comp.id}`);
    if (!plume) continue;
    const sensorId = comp.plumeSensor;
    const value = sensorId ? bus.reading(sensorId) : null;
    const threshold = comp.plumeThreshold ?? 50;
    // Full plume at `plumeMax`, not at the transducer's range: a 1500 psi
    // channel on a 300 psi engine would never show more than a flicker.
    const max = comp.plumeMax ?? bus.sensor(sensorId)?.max ?? 500;
    const intensity = Number.isFinite(value) && value > threshold
      ? Math.min(1, (value - threshold) / (max - threshold))
      : 0;
    plume.setAttribute('opacity', String(intensity));
    // The chamber's warm core lights with the plume and is gone at rest: a
    // glowing engine that is not firing is a false reading, not decoration.
    document.getElementById(`hot-${comp.id}`)?.setAttribute('opacity', String(intensity));
  }
}

// ------------------------------------------------------------------ utils --

function pipeWidth(pipe) {
  return lineWidth(P.fluids?.[pipe.fluid]);
}


/**
 * Whether a line's section reads pressurized on its own transducer.
 *
 * A stale channel says nothing, so it bolds nothing: a line lit from a
 * reading nobody is receiving would be the drawing inventing a state. The
 * threshold is `pressurizedAbove` on the pipe, else `pid.pressurizedPsi`,
 * else 50 psi -- comfortably above transducer offset and below anything
 * the stand calls pressure.
 */
function isPressurized(pipe) {
  if (!pipe.pressureSensor) return false;
  if (bus.sensorStatus(pipe.pressureSensor) === 'stale') return false;
  const v = bus.reading(pipe.pressureSensor);
  if (!Number.isFinite(v)) return false;
  const configured = Number(pipe.pressurizedAbove ?? P.pressurizedPsi);
  return v >= (Number.isFinite(configured) ? configured : 50);
}

/**
 * A coordinate where three or more line ends meet is a tee — mark it with a
 * dot. A vertex in the middle of a polyline counts as two ends, since the
 * line runs through it. Two pipes meeting end to end are one line drawn in
 * two pieces (split at a valve so each side can carry its own pressure
 * section) and get no dot: a dot there would read as a branch that is not
 * on the stand.
 */
function detectJunctions(pipes) {
  const seen = new Map();
  for (const pipe of pipes) {
    const fluid = bus.config.pid.fluids[pipe.fluid];
    pipe.points.forEach(([x, y], i) => {
      const key = `${x},${y}`;
      if (!seen.has(key)) seen.set(key, { x, y, color: fluid?.color || '#888', ends: 0, pipes: new Set() });
      const entry = seen.get(key);
      entry.pipes.add(pipe.id);
      entry.ends += (i === 0 || i === pipe.points.length - 1) ? 1 : 2;
    });
  }
  return [...seen.entries()].filter(([, j]) => j.pipes.size > 1 && j.ends >= 3);
}
