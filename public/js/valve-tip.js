/* valve-tip.js — the hover card for a valve, on the Control Grid and the P&ID.
 *
 * Its headline is how long the valve has been in the position it was last
 * commanded to: "OPEN for 2m 14s". That is the question a native tooltip
 * cannot answer, because a native tooltip is frozen at the moment it opened —
 * this one keeps counting while the pointer rests on the valve.
 *
 * A valve a bang-bang loop owns has no single position to time: the board is
 * pulsing it and the ground station is not told each edge. The card says so,
 * and times how long the loop has had it instead.
 *
 * Ages are measured on the SERVER's clock (see bus.sinceServer), so a station
 * whose own clock is off does not misreport them.
 */
import { bus } from './bus.js';
import { el, clear, fmtElapsed, fmtClock } from './util.js';

let tip = null;
let current = null;   // { node, valve, detail }
let timer = null;

/**
 * Show the card while the pointer is over `node`.
 * `detail(valve)` may return extra lines — a lock reason, a SHIFT hint.
 */
export function attachValveTip(node, valve, { detail } = {}) {
  node.addEventListener('pointerenter', () => show(node, valve, detail));
  node.addEventListener('pointerleave', () => { if (current?.node === node) hide(); });
  // A click can change the state; redraw at once rather than on the next tick.
  node.addEventListener('click', () => { if (current?.node === node) setTimeout(update, 60); });
}

function show(node, valve, detail) {
  tip ??= document.body.appendChild(el('div.valve-tip', { role: 'tooltip' }));
  current = { node, valve, detail };
  tip.hidden = false;
  update();
  clearInterval(timer);
  timer = setInterval(update, 250);
}

function hide() {
  current = null;
  clearInterval(timer);
  timer = null;
  if (tip) tip.hidden = true;
}

function update() {
  if (!current || !tip) return;
  // The node can be rebuilt out from under the card (a config reload).
  if (!current.node.isConnected) { hide(); return; }
  const { valve, detail } = current;
  const v = bus.state?.valves?.[valve.id] || {};
  const owner = bus.valveOwner(valve.id);
  const tag = (valve.pid?.tag || valve.id).replace(/\n/g, ' ');

  clear(tip);
  tip.dataset.state = owner ? 'bb' : (v.state || 'closed');
  tip.append(el('div.vt-name', {},
    el('span.vt-tag', { text: tag }),
    el('span', { text: tag === valve.id ? valve.name : `${valve.id} — ${valve.name}` })));

  if (owner) {
    const age = bus.sinceServer(v.bbSince);
    tip.append(
      el('div.vt-head', {},
        el('b', { text: 'BANG-BANG' }),
        el('span', { text: age === null ? ' — starting' : ` for ${fmtElapsed(age)}` })),
      el('div.vt-sub', {
        text: `Pulsed by the board (${owner.name}). Its position is not reported edge by edge, `
          + 'so none is shown. Disable the controller to command it by hand.',
      })
    );
  } else {
    const age = bus.sinceServer(v.at);
    const label = v.state === 'open' ? 'OPEN' : 'CLOSED';
    const shown = v.state === 'open' ? valve.openLabel : valve.closedLabel;
    tip.append(
      el('div.vt-head', {},
        el('b', { text: shown && shown.toUpperCase() !== label ? `${label} (${shown})` : label }),
        el('span', { text: age === null ? '' : ` for ${fmtElapsed(age)}` })),
      el('div.vt-sub', { text: provenance(v) })
    );
  }

  for (const line of detail?.(valve) || []) {
    if (line) tip.append(el('div.vt-detail', { text: line }));
  }
  place();
}

/** "commanded by operator at 14:02:11", in words an operator uses. */
function provenance(v) {
  if (!Number.isFinite(v.at)) return '';
  const when = fmtClock(v.at);
  const src = v.source || '';
  if (src === 'init') return `in this position since the server started (${when})`;
  if (src === 'board-release') return `closed by the board when bang-bang let go, at ${when}`;
  if (src === 'momentary-timeout') return `returned by its momentary timer at ${when}`;
  if (src === 'abort') return `driven here by ABORT at ${when}`;
  return `commanded by ${src || 'operator'} at ${when}`;
}

/** Beside the valve, flipped to whichever side has room. */
function place() {
  const r = current.node.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = r.right + 10;
  if (x + w > window.innerWidth - 8) x = r.left - w - 10;
  let y = r.top + r.height / 2 - h / 2;
  y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${y}px`;
}
