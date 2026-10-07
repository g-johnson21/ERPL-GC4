/* gox-purge.js — Draco's GOX purge controller window, opened with G.
 *
 * In the seconds before a hot fire, GOX collects at the LOX main valve and
 * the Dragon TC (TC3) reads it warm. The controller holds PB6 on a band:
 * open when Dragon warms to the open temperature, closed when it cools back
 * to the close temperature, never open longer than the max open time, and
 * after every close held shut for at least the dwell time.
 *
 * The loop runs on the SERVER (server/gox-purge.js), not here: it keeps
 * running if this page reloads, every station sees one state, and the
 * hot-fire interlock — starting any autosequence turns it off and closes PB6
 * before the first step — lives in the sequencer where no page can miss it.
 * This window only sets the band, turns the loop on and off, and shows it.
 *
 * The window is per station, except that every station shows it while the
 * loop is ON: a valve cycling on its own should never be a surprise.
 */
import { bus } from './bus.js';
import { el, clear, fmtValue, toast, shiftGate } from './util.js';

const OPEN_KEY = 'gc4-gox-purge-open';
const POS_KEY = 'gc4-gox-purge-pos';
const DEFAULTS = { openAt: -260, closeAt: -280, maxOpenMs: 3000, dwellMs: 2000 };

let win = null;
let ticker = null;
let busy = false;
let wantOpen = loadOpen();

const gp = () => bus.state?.goxPurge;
const available = () => Boolean(gp()?.available);

export function mountGoxPurge() {
  if (bus.spectator) return;
  win = el('div.press-win.gox-win#gox-win', { hidden: true, role: 'dialog', 'aria-label': 'GOX Purge Controller' });
  document.body.append(win);
  placeWindow();
  render();
  // Rebuilt only when what is drawn changes shape — settings or on/off —
  // so a box being typed in is not wiped by the next telemetry frame.
  let shape = null;
  bus.on('state', () => {
    const g = gp();
    const next = JSON.stringify([g?.enabled, g?.settings, wantOpen]);
    if (next !== shape) { shape = next; render(); }
  });
}

// ------------------------------------------------------------- the dialog --

/** Set the band and max open time. Does not turn the controller on. */
export function openGoxPurgeDialog() {
  if (bus.spectator || document.querySelector('.modal-backdrop')) return;
  if (!available()) {
    toast('The GOX purge controller is for Draco — this stand has no PB6 (SV-GOX-PURGE) and Dragon TC (TC3)', 'warn', 5000);
    return;
  }
  const s = gp().settings || DEFAULTS;
  const maxLimitS = (gp().limits?.maxOpenMs ?? 60000) / 1000;
  const num = (value, label) => el('input.mono', { type: 'number', step: 'any', value: String(value), 'aria-label': label, style: { width: '110px' } });
  const openAt = num(s.openAt, 'Open PB6 at or above, °F');
  const closeAt = num(s.closeAt, 'Close PB6 at or below, °F');
  const maxOpen = num(s.maxOpenMs / 1000, 'Max PB6 open time, seconds');
  const dwellLimitS = (gp().limits?.dwellMs ?? 60000) / 1000;
  const dwell = num((s.dwellMs ?? DEFAULTS.dwellMs) / 1000, 'Dwell, minimum PB6 closed time between openings, seconds');

  const done = () => { backdrop.remove(); document.removeEventListener('keydown', onKey, true); };
  const submit = async () => {
    const body = {
      openAt: Number(openAt.value), closeAt: Number(closeAt.value),
      maxOpenMs: Math.round(Number(maxOpen.value) * 1000), dwellMs: Math.round(Number(dwell.value) * 1000),
    };
    if (!(body.openAt > body.closeAt)) { toast('The open temperature must be above the close temperature', 'error'); openAt.focus(); return; }
    if (!(body.maxOpenMs > 0) || body.maxOpenMs > maxLimitS * 1000) {
      toast(`Max open time must be between 0 and ${maxLimitS} s`, 'error'); maxOpen.focus(); return;
    }
    if (!(body.dwellMs >= 0) || body.dwellMs > dwellLimitS * 1000) {
      toast(`Dwell time must be between 0 and ${dwellLimitS} s`, 'error'); dwell.focus(); return;
    }
    const res = await bus.post('/api/gox-purge', body);
    if (!res.ok) return;
    wantOpen = true; saveOpen();
    render();
    done();
  };
  const onKey = (e) => {
    // Captured and stopped: Escape is ABORT everywhere else.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
  };

  const backdrop = el('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) done(); } },
    el('div.modal.press-modal', {},
      el('h2', { text: 'GOX Purge Controller' }),
      el('p', { text: 'Holds PB6 on the Dragon temperature to bleed GOX from the LOX line before a hot fire. '
        + 'Starting any autosequence turns it off and closes PB6 first.' }),
      el('div.press-field-pair', {},
        el('div.press-field', {}, el('label.field', { text: 'Open PB6 at or above (°F)' }), openAt),
        el('div.press-field', {}, el('label.field', { text: 'Close PB6 at or below (°F)' }), closeAt)),
      el('div.press-field-pair', {},
        el('div.press-field', {}, el('label.field', { text: `Max PB6 open time (s, up to ${maxLimitS})` }), maxOpen),
        el('div.press-field', {}, el('label.field', { text: `Dwell time (s, up to ${dwellLimitS})` }), dwell)),
      el('div.timer-hint.gox-hint', {
        text: 'Max open time closes PB6 and the controller stays on. After every close, PB6 stays closed '
          + 'for at least the dwell time before it may open again.',
      }),
      el('div.modal-actions', {},
        el('button.btn.ghost', { text: 'Cancel', onclick: done }),
        el('button.btn.accent', { text: 'Confirm', onclick: submit }))));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  openAt.focus();
  openAt.select();
}

// ------------------------------------------------------------ the window --

function render() {
  if (!win) return;
  const g = gp();
  const show = available() && Boolean(g.settings) && (wantOpen || g.enabled);
  win.hidden = !show;
  clear(win);
  if (!show) { stopTicker(); return; }
  const s = g.settings;

  const box = (label, key, value, unit, onchange) =>
    el('label.press-box', { dataset: { box: key } },
      el('span.press-box-label', { text: label }),
      el('span.press-box-input', {},
        el('input.mono', { type: 'number', step: 'any', value: String(value), onchange }),
        el('span.press-unit', { text: unit })),
      el('span.press-box-sub'));
  const retune = (patch) => async (e) => {
    const res = await bus.post('/api/gox-purge', { ...gp().settings, ...patch(Number(e.target.value)) });
    if (!res.ok) render();   // put the box back to what the server holds
  };

  win.append(
    el('div.press-grip', { title: 'Drag to move · G to reconfigure', onpointerdown: startDrag },
      el('span.press-title', { text: 'GOX PURGE' }),
      el('span.gox-chip'),
      el('span.press-grip-fill'),
      el('button.timer-icon-btn', { text: '⚙', title: 'Reconfigure (G)', 'aria-label': 'Reconfigure', onclick: openGoxPurgeDialog }),
      el('button.timer-icon-btn', { text: '✕', title: 'Close the window', 'aria-label': 'Close', onclick: closeWindow })),
    el('div.press-body', {},
      el('div.press-reading', {},
        el('span.press-reading-label', { text: 'DRAGON', title: `${g.sensor} — the TC the loop runs on` }),
        el('span.press-reading-value'),
        el('span.press-unit', { text: '°F' })),
      el('div.gox-band', {}, el('div.gox-band-zone'), el('div.gox-band-mark')),
      el('div.gox-valve'),
      el('div.press-boxes', {},
        box('Open PB6 at or above', 'open', s.openAt, '°F', retune((v) => ({ openAt: v }))),
        box('Close PB6 at or below', 'close', s.closeAt, '°F', retune((v) => ({ closeAt: v }))),
        box('Max Open Time', 'max', s.maxOpenMs / 1000, 's', retune((v) => ({ maxOpenMs: Math.round(v * 1000) }))),
        box('Dwell Time', 'dwell', s.dwellMs / 1000, 's', retune((v) => ({ dwellMs: Math.round(v * 1000) })))),
      el('div.press-status'),
      el('div.press-actions', {},
        el('button.btn.gox-toggle', { onclick: toggle }))));

  tick();
  startTicker();
}

function tick() {
  if (!win || win.hidden) return;
  const g = gp();
  if (!g?.settings) return;
  const s = g.settings;
  const sensor = bus.sensor(g.sensor);
  const d = sensor?.decimals ?? 1;
  const t = bus.reading(g.sensor);
  const pb6Open = bus.valveState(g.valve) === 'open';
  const q = (sel) => win.querySelector(sel);

  const chip = q('.gox-chip');
  chip.textContent = g.enabled ? 'ON' : 'OFF';
  chip.dataset.on = String(g.enabled);
  win.dataset.on = String(g.enabled);

  q('.press-reading-value').textContent = fmtValue(t, d);

  // Where Dragon sits against the band: a strip from 20 °F under the close
  // temperature to 20 °F over the open one, with the deadband shaded.
  const lo = s.closeAt - 20, hi = s.openAt + 20;
  const pct = (v) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
  const zone = q('.gox-band-zone');
  zone.style.left = pct(s.closeAt);
  zone.style.width = `calc(${pct(s.openAt)} - ${pct(s.closeAt)})`;
  const mark = q('.gox-band-mark');
  mark.hidden = !Number.isFinite(t);
  if (Number.isFinite(t)) {
    mark.style.left = pct(t);
    mark.dataset.side = t >= s.openAt ? 'open' : t <= s.closeAt ? 'close' : 'band';
  }

  const openFor = pb6Open && g.openedAt ? bus.sinceServer(g.openedAt) : null;
  // Dwell left, counted on the server's clock from the loop's last close.
  const sinceClose = g.enabled && !pb6Open && g.closedAt ? bus.sinceServer(g.closedAt) : null;
  const dwellLeft = sinceClose !== null ? Math.max(0, s.dwellMs - sinceClose) : 0;
  const valve = q('.gox-valve');
  valve.textContent = pb6Open
    ? `PB6 OPEN${openFor !== null ? `  ${(openFor / 1000).toFixed(1)} / ${(s.maxOpenMs / 1000).toFixed(1)} s` : ''}`
    : dwellLeft > 0 ? `PB6 CLOSED · dwell ${(dwellLeft / 1000).toFixed(1)} s` : 'PB6 CLOSED';
  valve.dataset.state = pb6Open ? 'open' : 'closed';
  q('[data-box="max"] .press-box-sub').textContent = openFor !== null ? `${((s.maxOpenMs - openFor) / 1000).toFixed(1)} s left` : '';
  q('[data-box="dwell"] .press-box-sub').textContent = dwellLeft > 0 ? `${(dwellLeft / 1000).toFixed(1)} s left` : '';

  // Why it cannot be turned on, in the order an operator should fix it.
  const block = g.enabled ? null
    : bus.state?.abort?.active ? 'Stand is in ABORT'
    : !bus.state?.armed ? 'Requires ARM'
    : bus.state?.sequence?.running ? 'An autosequence is running'
    : !Number.isFinite(t) ? 'Dragon TC has no reading'
    : null;

  const status = q('.press-status');
  if (g.enabled) {
    status.textContent = pb6Open
      ? `Purging — closes at ${s.closeAt} °F or ${(s.maxOpenMs / 1000).toFixed(1)} s`
      : dwellLeft > 0
        ? `Dwelling — PB6 may reopen in ${(dwellLeft / 1000).toFixed(1)} s`
        : `Holding — opens at ${s.openAt} °F`;
    status.dataset.kind = pb6Open ? 'active' : dwellLeft > 0 ? 'wait' : 'ready';
  } else if (g.lastOff) {
    status.textContent = `Off — ${g.lastOff.reason}${block ? ` · ${block}` : ''}`;
    status.dataset.kind = 'blocked';
  } else {
    status.textContent = block || 'Off — SHIFT+click Turn On to start';
    status.dataset.kind = block ? 'blocked' : 'wait';
  }

  const btn = q('.gox-toggle');
  btn.textContent = g.enabled ? 'Turn Off' : 'Turn On';
  btn.disabled = busy || (!g.enabled && Boolean(block));
  btn.classList.toggle('danger', g.enabled);
  btn.classList.toggle('accent', !g.enabled && !btn.disabled);
  btn.title = g.enabled ? 'Turn the controller off and close PB6' : 'Start holding PB6 on the Dragon band (SHIFT+click)';
}

async function toggle(e) {
  if (busy) return;
  const g = gp();
  // Turning on puts a valve under automatic control, so it takes SHIFT like
  // enabling a bang-bang loop. Turning off never does.
  if (!g.enabled && !shiftGate(e, 'turn on the GOX purge controller')) return;
  busy = true; tick();
  try {
    await bus.post('/api/gox-purge', g.enabled ? { enable: false } : { enable: true });
  } finally { busy = false; tick(); }
}

function closeWindow() {
  if (gp()?.enabled) {
    toast('The GOX purge controller is ON — turn it off before closing its window', 'warn');
    return;
  }
  wantOpen = false; saveOpen();
  render();
}

function startTicker() { ticker ??= setInterval(tick, 100); }
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

// ------------------------------------------------------------ placement --

function placeWindow() {
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { /* ignore */ }
  applyPos(pos || { x: Math.max(16, window.innerWidth - 340), y: 140 });
  window.addEventListener('resize', () => applyPos(currentPos()));
}

function currentPos() {
  return { x: parseFloat(win.style.left) || 16, y: parseFloat(win.style.top) || 140 };
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

function loadOpen() {
  try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}

function saveOpen() {
  try { localStorage.setItem(OPEN_KEY, wantOpen ? '1' : '0'); } catch { /* ignore */ }
}
