/* data-layout.js — the Data page's arrangement, as plain data.
 *
 * The page is a row of LANES (columns of the screen, each with a width), and
 * each lane holds a stack of PANELS. A panel is a titled box of channels, and
 * every channel in it is drawn at one of three sizes:
 *
 *   large    a tall card with a big reading — the handful being watched
 *   card     the standard card: reading, rate, min/max, trend
 *   compact  one telemetry-style line: name, tag, small trend, reading
 *
 * The default arrangement is the old one exactly: one lane per sensor group,
 * one panel per lane, every channel a card. Everything else is the operator's.
 *
 * ONE RULE IS NOT THE OPERATOR'S: every channel is on the page. A channel can
 * be moved, shrunk to a line, or shown twice (a copy in a Watch panel), but
 * never removed — `reconcile` puts anything unplaced back in its group's own
 * panel. This page's promise is that it shows the whole system, and a layout
 * saved last month must not be able to hide a transducer added this morning.
 *
 * No DOM here: page-data.js renders it, data-layout.test.js checks it.
 */

export const SIZES = ['large', 'card', 'compact'];
export const MAX_COLS = 3;
/** Lane widths are shares of the screen (CSS fr), any value in this range,
 *  so a border dragged to exactly where it looks right stays there. */
export const MIN_WIDTH = 0.1;
export const MAX_WIDTH = 10;
export const LAYOUT_VERSION = 1;

/** Pixel budget of each size, for sizing a panel against its lane. */
export const SIZE_PX = {
  large: { min: 116, max: 340, grow: 1.7 },
  card: { min: 84, max: 176, grow: 1 },
  compact: { min: 28, max: 28, grow: 0 },
};
export const ITEM_GAP = 6;

/** In a lane set to fill, a compact line stretches too, at this share of a card. */
export const FILL_COMPACT_GROW = 0.35;

const homeId = (groupId) => `g:${groupId}`;
export const isHome = (panelId) => panelId.startsWith('g:');

/** The arrangement this page had before it was customizable. */
export function defaultLayout(groups) {
  const panels = {};
  const lanes = [];
  for (const g of groups) {
    const id = homeId(g.id);
    panels[id] = { id, group: g.id, title: null, size: 'card', cols: 1, items: g.sensors.map((s) => ({ id: s.id })) };
    lanes.push({ w: 1, panels: [id] });
  }
  return { v: LAYOUT_VERSION, lanes, panels };
}

/**
 * Make a saved layout fit the stand as it is now.
 *
 * Saved layouts outlive config edits, so this is where a renamed channel, a
 * deleted group or a new transducer gets dealt with: unknown channels drop
 * out, a new group gets a lane of its own, and every channel not placed
 * anywhere goes back to its group's panel. Never throws — a layout too broken
 * to read is replaced by the default.
 */
export function reconcile(saved, groups) {
  if (!saved || typeof saved !== 'object' || saved.v !== LAYOUT_VERSION
      || !Array.isArray(saved.lanes) || !saved.panels || typeof saved.panels !== 'object') {
    return defaultLayout(groups);
  }
  const groupOf = new Map();
  for (const g of groups) for (const s of g.sensors) groupOf.set(s.id, g.id);
  const groupIds = new Set(groups.map((g) => g.id));

  const panels = {};
  const lanes = [];
  const seenPanel = new Set();
  for (const lane of saved.lanes) {
    if (!lane || !Array.isArray(lane.panels)) continue;
    const ids = [];
    for (const pid of lane.panels) {
      const p = saved.panels[pid];
      if (typeof pid !== 'string' || !p || seenPanel.has(pid)) continue;
      // A group's own panel goes with the group.
      if (isHome(pid) && !groupIds.has(pid.slice(2))) continue;
      seenPanel.add(pid);
      const seen = new Set();
      const items = [];
      for (const it of Array.isArray(p.items) ? p.items : []) {
        const id = typeof it === 'string' ? it : it?.id;
        if (!groupOf.has(id) || seen.has(id)) continue;
        seen.add(id);
        items.push(SIZES.includes(it?.size) ? { id, size: it.size } : { id });
      }
      panels[pid] = {
        id: pid,
        group: isHome(pid) ? pid.slice(2) : null,
        title: typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 40) : null,
        size: SIZES.includes(p.size) ? p.size : 'card',
        cols: clampInt(p.cols, 1, MAX_COLS, 1),
        items,
      };
      ids.push(pid);
    }
    if (ids.length) lanes.push({ w: clampWidth(lane.w), ...(lane.fill === true && { fill: true }), panels: ids });
  }

  // A group with no panel (new since the save) gets a lane of its own, where
  // the default layout would have put it.
  for (const g of groups) {
    const id = homeId(g.id);
    if (panels[id]) continue;
    panels[id] = { id, group: g.id, title: null, size: 'card', cols: 1, items: [] };
    lanes.push({ w: 1, panels: [id] });
  }

  // Every channel somewhere. Unplaced ones go to their group's panel, in
  // config order relative to what is already there.
  const placed = new Set();
  for (const p of Object.values(panels)) for (const it of p.items) placed.add(it.id);
  for (const g of groups) {
    const home = panels[homeId(g.id)];
    for (const s of g.sensors) {
      if (placed.has(s.id)) continue;
      const order = g.sensors.map((x) => x.id);
      const at = home.items.findIndex((it) => order.indexOf(it.id) > order.indexOf(s.id));
      home.items.splice(at < 0 ? home.items.length : at, 0, { id: s.id });
      placed.add(s.id);
    }
  }
  return { v: LAYOUT_VERSION, lanes, panels };
}

// ------------------------------------------------------------- operations --
//
// Each takes a layout and returns a new one, reconciled, so a caller can
// never end up holding an arrangement that breaks the every-channel rule.

const clone = (layout) => JSON.parse(JSON.stringify(layout));

function locatePanel(layout, panelId) {
  for (let l = 0; l < layout.lanes.length; l++) {
    const i = layout.lanes[l].panels.indexOf(panelId);
    if (i >= 0) return { lane: l, index: i };
  }
  return null;
}

/** How many panels a channel appears in. */
export function placements(layout, sensorId) {
  let n = 0;
  for (const p of Object.values(layout.panels)) if (p.items.some((it) => it.id === sensorId)) n++;
  return n;
}

/** The size a channel is drawn at in a panel. */
export const itemSize = (panel, item) => item.size || panel.size;

/**
 * Move (or, with `copy`, duplicate) a channel to `toPanel` before the item at
 * `beforeId` (null for the end). A channel already in the target panel is
 * moved within it rather than added twice; its own size override goes with it.
 */
export function moveItem(layout, groups, { sensorId, fromPanel, toPanel, beforeId = null, copy = false }) {
  const next = clone(layout);
  const src = next.panels[fromPanel];
  const dst = next.panels[toPanel];
  if (!dst) return layout;
  const srcIdx = src ? src.items.findIndex((it) => it.id === sensorId) : -1;
  const moved = srcIdx >= 0 ? { ...src.items[srcIdx] } : { id: sensorId };
  if (src && srcIdx >= 0 && (!copy || src === dst)) src.items.splice(srcIdx, 1);
  // Copying into a panel that already has it is a move within that panel.
  const existing = dst.items.findIndex((it) => it.id === sensorId);
  if (existing >= 0) dst.items.splice(existing, 1);
  // A copy keeps the size it had where it came from only when that was an
  // override; otherwise it takes the new panel's size, which is the point of
  // copying into a Watch panel of large cards.
  if (copy && src !== dst) delete moved.size;
  if (!copy && src && src !== dst && moved.size === dst.size) delete moved.size;
  const at = beforeId == null ? -1 : dst.items.findIndex((it) => it.id === beforeId);
  dst.items.splice(at < 0 ? dst.items.length : at, 0, moved);
  return reconcile(next, groups);
}

/** Take a channel out of one panel. Its last placement cannot go (see reconcile). */
export function removeItem(layout, groups, panelId, sensorId) {
  if (placements(layout, sensorId) < 2) return layout;
  const next = clone(layout);
  const p = next.panels[panelId];
  if (p) p.items = p.items.filter((it) => it.id !== sensorId);
  return reconcile(next, groups);
}

/** One channel's size; the panel's own size clears the override. */
export function setItemSize(layout, groups, panelId, sensorId, size) {
  const next = clone(layout);
  const p = next.panels[panelId];
  const it = p?.items.find((x) => x.id === sensorId);
  if (!it || !SIZES.includes(size)) return layout;
  if (size === p.size) delete it.size; else it.size = size;
  return reconcile(next, groups);
}

/** Every channel in a panel to one size. Clears the per-channel overrides. */
export function setPanelSize(layout, groups, panelId, size) {
  const next = clone(layout);
  const p = next.panels[panelId];
  if (!p || !SIZES.includes(size)) return layout;
  p.size = size;
  for (const it of p.items) delete it.size;
  return reconcile(next, groups);
}

export function setPanelCols(layout, groups, panelId, cols) {
  const next = clone(layout);
  if (!next.panels[panelId]) return layout;
  next.panels[panelId].cols = clampInt(cols, 1, MAX_COLS, 1);
  return reconcile(next, groups);
}

export function renamePanel(layout, groups, panelId, title) {
  const next = clone(layout);
  if (!next.panels[panelId]) return layout;
  next.panels[panelId].title = String(title || '').trim().slice(0, 40) || null;
  return reconcile(next, groups);
}

/** Lane width, in shares of the screen (MIN_WIDTH..MAX_WIDTH). */
export function setLaneWidth(layout, groups, laneIndex, w) {
  const next = clone(layout);
  if (!next.lanes[laneIndex]) return layout;
  next.lanes[laneIndex].w = clampWidth(w);
  return reconcile(next, groups);
}

/** Every lane's width at once — a border drag moves two, Even resets all. */
export function setLaneWidths(layout, groups, widths) {
  const next = clone(layout);
  next.lanes.forEach((lane, i) => { if (widths[i] != null) lane.w = clampWidth(widths[i]); });
  return reconcile(next, groups);
}

/**
 * A lane set to fill stretches what it holds to its full height: no ceiling
 * on card height, and compact lines grow with the cards instead of staying
 * one line tall. Off, a lane of three cards is three cards and spare space.
 */
export function setLaneFill(layout, groups, laneIndex, fill) {
  const next = clone(layout);
  const lane = next.lanes[laneIndex];
  if (!lane) return layout;
  if (fill) lane.fill = true; else delete lane.fill;
  return reconcile(next, groups);
}

/**
 * Widths for the two lanes either side of a border dragged `dx` pixels.
 * Their combined share is kept, so no other lane moves; neither goes below
 * `minPx`. `pxLeft`/`pxRight` are the two lanes' current rendered widths.
 */
export function resizePair(wLeft, wRight, pxLeft, pxRight, dx, minPx = 120) {
  const totalPx = pxLeft + pxRight;
  const totalW = wLeft + wRight;
  if (!(totalPx > 0)) return [wLeft, wRight];
  const lo = Math.min(minPx, totalPx / 2);
  const left = Math.max(lo, Math.min(totalPx - lo, pxLeft + dx));
  const l = round2((totalW * left) / totalPx);
  return [l, round2(totalW - l)];
}

/**
 * Move a panel to lane `toLane`, before the panel `beforeId` (null: bottom).
 * `toLane` equal to the lane count, or `newLaneAt` set, puts it in a new lane
 * of its own at that position. A lane left empty disappears.
 */
export function movePanel(layout, groups, { panelId, toLane, beforeId = null, newLaneAt = null }) {
  const next = clone(layout);
  const from = locatePanel(next, panelId);
  if (!from) return layout;
  const fromLane = next.lanes[from.lane];
  fromLane.panels.splice(from.index, 1);
  if (newLaneAt != null) {
    next.lanes.splice(Math.max(0, Math.min(newLaneAt, next.lanes.length)), 0, { w: 1, panels: [panelId] });
  } else {
    const lane = next.lanes[toLane];
    if (!lane) return layout;
    const at = beforeId == null ? -1 : lane.panels.indexOf(beforeId);
    lane.panels.splice(at < 0 ? lane.panels.length : at, 0, panelId);
  }
  next.lanes = next.lanes.filter((l) => l.panels.length);
  return reconcile(next, groups);
}

/**
 * A new, empty panel of your own. With `laneIndex` it goes at the bottom of
 * that lane; without, in a new lane on the left — where a Watch panel, the
 * thing this is mostly for, belongs.
 */
export function addPanel(layout, groups, { title = 'Watch', size = 'large', laneIndex = null } = {}) {
  const next = clone(layout);
  let n = 1;
  while (next.panels[`p:${n}`]) n++;
  const id = `p:${n}`;
  next.panels[id] = { id, group: null, title, size: SIZES.includes(size) ? size : 'card', cols: 1, items: [] };
  if (laneIndex != null && next.lanes[laneIndex]) next.lanes[laneIndex].panels.push(id);
  else next.lanes.unshift({ w: 1, panels: [id] });
  return { layout: reconcile(next, groups), id };
}

/**
 * Delete a panel of your own. Its channels are not lost: any that appear
 * nowhere else go back to their group's panel. A group's own panel cannot be
 * deleted — empty it instead, and it stays out of sight until refilled.
 */
export function removePanel(layout, groups, panelId) {
  if (isHome(panelId) || !layout.panels[panelId]) return layout;
  const next = clone(layout);
  delete next.panels[panelId];
  for (const lane of next.lanes) lane.panels = lane.panels.filter((p) => p !== panelId);
  next.lanes = next.lanes.filter((l) => l.panels.length);
  return reconcile(next, groups);
}

/** The first panel of your own titled `title`, made if missing. */
export function ensurePanel(layout, groups, title) {
  const found = Object.values(layout.panels).find((p) => !p.group && p.title === title);
  if (found) return { layout, id: found.id };
  return addPanel(layout, groups, { title });
}

// --------------------------------------------------------------- geometry --

/**
 * Split a panel's channels into its columns, in reading order down each one.
 * Balanced by height rather than by count, so a column of five compact lines
 * is not set beside a column of five cards.
 */
export function splitColumns(panel) {
  const cols = Math.min(panel.cols, Math.max(1, panel.items.length));
  if (cols === 1) return [panel.items];
  const h = (it) => SIZE_PX[itemSize(panel, it)].min + ITEM_GAP;
  const total = panel.items.reduce((sum, it) => sum + h(it), 0);
  const out = [];
  let col = [], acc = 0;
  for (const it of panel.items) {
    const target = (total * (out.length + 1)) / cols;
    if (col.length && out.length < cols - 1 && acc + h(it) / 2 > target) { out.push(col); col = []; }
    col.push(it);
    acc += h(it);
  }
  out.push(col);
  return out;
}

/**
 * How tall a panel may be: the bounds its tallest column puts on it, and how
 * strongly it should claim spare lane height. A panel of compact lines claims
 * none — it is exactly as tall as its lines.
 */
export function panelExtent(panel, headPx, { fill = false } = {}) {
  let min = 0, max = 0, grow = 0;
  for (const col of splitColumns(panel)) {
    let cmin = 0, cmax = 0, cgrow = 0;
    col.forEach((it, i) => {
      const size = itemSize(panel, it);
      const px = SIZE_PX[size];
      const gap = i ? ITEM_GAP : 0;
      cmin += px.min + gap;
      cmax += px.max + gap;
      cgrow += fill && size === 'compact' ? FILL_COMPACT_GROW : px.grow;
    });
    min = Math.max(min, cmin);
    max = Math.max(max, cmax);
    grow = Math.max(grow, cgrow);
  }
  return { min: min + headPx, max: fill ? Infinity : max + headPx, grow };
}

const round2 = (n) => Math.round(n * 100) / 100;

function clampWidth(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? round2(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n))) : 1;
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

// ---------------------------------------------------------------- presets --
//
// A stand keeps several layouts under names, and the page shows one at a
// time: a fill-and-chill view, a hot-fire view, one for checking every
// channel before a test. A preset is just a name around a layout, so each one
// keeps the same guarantee — every channel somewhere on the page.
//
//   { v: 1, active: 'a', list: [{ id: 'a', name: 'Default', layout }] }

export const MAX_PRESETS = 12;
export const PRESET_NAME_MAX = 24;
const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, PRESET_NAME_MAX);

/**
 * Presets from storage, checked and with every layout reconciled. With
 * nothing usable saved, one preset named Default — holding `legacy`, the
 * single layout the page kept before it had presets, when there is one.
 */
export function reconcilePresets(saved, groups, legacy = null) {
  const list = [];
  const seen = new Set();
  if (saved && typeof saved === 'object' && saved.v === 1 && Array.isArray(saved.list)) {
    for (const p of saved.list) {
      if (!p || typeof p !== 'object') continue;
      const id = typeof p.id === 'string' && p.id && !seen.has(p.id) ? p.id : null;
      if (!id || list.length >= MAX_PRESETS) continue;
      seen.add(id);
      list.push({ id, name: cleanName(p.name) || `Layout ${list.length + 1}`, layout: reconcile(p.layout, groups) });
    }
  }
  if (!list.length) list.push({ id: 'a', name: 'Default', layout: reconcile(legacy, groups) });
  const active = list.some((p) => p.id === saved?.active) ? saved.active : list[0].id;
  return { v: 1, active, list };
}

export const activePreset = (presets) => presets.list.find((p) => p.id === presets.active) || presets.list[0];

const freshPresetId = (presets) => {
  const used = new Set(presets.list.map((p) => p.id));
  for (let n = 0; ; n++) { const id = `p${n}`; if (!used.has(id)) return id; }
};

/** The active preset's layout replaced — every layout edit lands here. */
export function setActiveLayout(presets, layout) {
  return { ...presets, list: presets.list.map((p) => (p.id === presets.active ? { ...p, layout } : p)) };
}

export function selectPreset(presets, id) {
  return presets.list.some((p) => p.id === id) && id !== presets.active ? { ...presets, active: id } : presets;
}

/**
 * A new preset, made active. It starts as a copy of `layout` (the one on
 * screen), since a new view is nearly always a variation on the current one.
 */
export function addPreset(presets, groups, { name, layout } = {}) {
  if (presets.list.length >= MAX_PRESETS) return presets;
  const id = freshPresetId(presets);
  const taken = new Set(presets.list.map((p) => p.name.toLowerCase()));
  let fallback = '';
  for (let n = presets.list.length + 1; !fallback || taken.has(fallback.toLowerCase()); n++) fallback = `Layout ${n}`;
  const entry = { id, name: cleanName(name) || fallback, layout: reconcile(clone(layout ?? activePreset(presets).layout), groups) };
  return { ...presets, active: id, list: [...presets.list, entry] };
}

export function renamePreset(presets, id, name) {
  const clean = cleanName(name);
  const p = presets.list.find((x) => x.id === id);
  if (!p || !clean || clean === p.name) return presets;
  return { ...presets, list: presets.list.map((x) => (x.id === id ? { ...x, name: clean } : x)) };
}

/** The last preset cannot go; deleting the active one shows its neighbour. */
export function removePreset(presets, id) {
  const i = presets.list.findIndex((p) => p.id === id);
  if (i < 0 || presets.list.length <= 1) return presets;
  const list = presets.list.filter((p) => p.id !== id);
  const active = presets.active === id ? list[Math.min(i, list.length - 1)].id : presets.active;
  return { ...presets, active, list };
}

