/* page-data.js — every instrument on one screen, plus a dense table view.
 *
 * LAYOUT
 *   Cards mode is a dashboard: LANES across the screen, each a stack of
 *   PANELS, each panel a box of channels drawn large, as cards, or as compact
 *   telemetry lines. The arrangement is the operator's (Customize in the page
 *   head) and lives in data-layout.js; out of the box it is one lane per
 *   sensor group, every channel a card — the page as it always was.
 *
 *   Each lane sizes its own cards. A group gaining channels shrinks the cards
 *   in its own lane and nobody else's, and a group of channels that matter
 *   less can be folded down to lines and stacked under another, so the
 *   channels that matter keep their size.
 *
 *   Nothing scrolls if it can be helped: during a test an operator reads this
 *   page at a glance, and a channel that is one flick of a scroll wheel away
 *   is a channel nobody is watching. Cards shrink to fit down to a readable
 *   minimum, and only past that does the page scroll. Every channel is always
 *   somewhere on the page — the layout can move one, shrink it, or show it
 *   twice, never hide it.
 */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { $, el, clear, icon, fmtValue, fmtRate, normalize, valueWidthCh, toast } from './util.js';
import { WINDOWS, drawTrace, statusColor, cssVar, windowChips } from './spark.js';
import * as DL from './data-layout.js';

const content = await bootPage('data', { sidebar: false });

/** Window for the rate-of-change fit. Not the sparkline window — a rate
 *  averaged over two minutes would say nothing about a pressurization ramp. */
const RATE_SECONDS = 3;

/** A panel head and the gap under it, in px: `--col-head` plus the body padding in the CSS. */
const HEAD_PX = 28;

// `table` was the name of the old plain table; the telemetry table replaced
// it, so a saved preference for one opens the other.
let mode = loadPref('gc4-data-mode', 'cards') === 'cards' ? 'cards' : 'telemetry';
let windowSeconds = Number(loadPref('gc4-data-window', '60'));
if (!WINDOWS.some((w) => w.s === windowSeconds)) windowSeconds = 60;
let showValves = loadPref('gc4-data-valves', 'off') === 'on';
let editing = false;

// ------------------------------------------------------------------ shell --

content.append(
  el('div.page-head', {},
    el('h1', { text: 'Data' }),
    // Saved layouts, one click apart: see buildPresetTabs.
    el('div#preset-tabs.seg'),
    el('div#data-head-tools', { style: { marginLeft: 'auto', display: 'flex', gap: '14px', alignItems: 'center' } },
      // The window scales every trend on the page and the MIN/MAX beside it.
      windowChips(el, windowSeconds, (s) => {
        windowSeconds = s;
        savePref('gc4-data-window', String(s));
        update();
      }, 'Trend window — also the span MIN and MAX are taken over'),
      el('div.seg', {},
        el('button', {
          id: 'valve-toggle',
          class: showValves ? 'active' : '',
          'aria-pressed': String(showValves),
          title: 'Mark every valve actuation on the trends — green solid OPEN, red dashed CLOSED',
          text: 'Valves',
          onclick: (e) => {
            showValves = !showValves;
            savePref('gc4-data-valves', showValves ? 'on' : 'off');
            e.currentTarget.classList.toggle('active', showValves);
            e.currentTarget.setAttribute('aria-pressed', String(showValves));
            update();
          },
        })
      ),
      el('div.seg', {},
        el('button', {
          id: 'layout-toggle',
          title: 'Arrange this page: move channels between panels, fold the less important ones to compact lines, '
            + 'add a Watch panel of large cards, change lane widths',
          text: 'Customize',
          onclick: () => setEditing(!editing),
        })
      ),
      el('div.seg', {},
        el('button', { id: 'mode-cards', class: mode === 'cards' ? 'active' : '', text: 'Cards', onclick: () => setMode('cards') }),
        el('button', { id: 'mode-telemetry', class: mode === 'telemetry' ? 'active' : '', text: 'Telemetry', onclick: () => setMode('telemetry') })
      )
    )
  ),
  el('div#layout-bar.hidden'),
  el('div#data-body')
);

addViewerLink();

/**
 * A button that copies the read-only spectator address, for texting to whoever
 * is watching. Operator stations only: a spectator is already on it, and the
 * control port is the one that knows the stand's LAN addresses. Absent when
 * the spectator port is off or the host has no network address to give out.
 */
async function addViewerLink() {
  if (bus.spectator) return;
  let info;
  try {
    const res = await fetch('/api/viewer', { cache: 'no-store' });
    if (!res.ok) return;
    info = await res.json();
  } catch (e) { return; }
  if (!info.enabled || !info.addresses?.length) return;

  // Prefer the address this station was itself opened on, so the link is one
  // the viewers' network is known to route to.
  const host = info.addresses.includes(location.hostname) ? location.hostname : info.addresses[0];
  const url = `http://${host}:${info.port}`;
  const btn = el('button.btn', {
    id: 'viewer-link',
    title: ['Read-only viewer link - click to copy', ...info.addresses.map((a) => `http://${a}:${info.port}`)].join(String.fromCharCode(10)),
    text: `Viewer: ${url}`,
    onclick: async () => {
      if (await copyText(url)) toast('Viewer link copied', 'ok');
      else toast(`Copy failed - ${url}`, 'warn', 8000);
    },
  });
  $('#data-head-tools').prepend(btn);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // navigator.clipboard needs a secure context; the station is plain http
    // on a LAN address, so fall back to a selection copy.
    const ta = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* fall through */ }
    ta.remove();
    return ok;
  }
}

// Cards mode owns the viewport: the lanes size themselves against a
// definite height, which they only have if nothing above them can scroll.
content.classList.add('data-page');

function setMode(next) {
  mode = next;
  savePref('gc4-data-mode', next);
  $('#mode-cards').classList.toggle('active', next === 'cards');
  $('#mode-telemetry').classList.toggle('active', next === 'telemetry');
  if (next !== 'cards') editing = false;
  build();
}

function setEditing(on) {
  editing = on;
  if (on && mode !== 'cards') { setMode('cards'); return; }
  build();
}

// ----------------------------------------------------------------- layout --

// Per stand: a layout for MOE means nothing on another stand's channels.
const standKey = () => bus.config.meta?.standName || 'stand';
const presetsKey = () => `gc4-data-presets:${standKey()}`;
/** Where the page kept its one layout before presets; read to seed Default. */
const legacyLayoutKey = () => `gc4-data-layout:${standKey()}`;

let presets = null;
let layout = null;            // the active preset's layout

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

/** The presets, reconciled against the channels this stand has today. */
function loadPresets(groups) {
  return DL.reconcilePresets(readJSON(presetsKey()), groups, readJSON(legacyLayoutKey()));
}

function savePresets() { savePref(presetsKey(), JSON.stringify(presets)); }

/** Apply an edit to the layout on screen: keep it in its preset, and redraw. */
function commit(next) {
  if (next === layout) return;
  layout = next;
  presets = DL.setActiveLayout(presets, layout);
  savePresets();
  build();
}

/** Apply a change to the presets themselves: switch, add, rename, delete. */
function commitPresets(next, { rebuild = true } = {}) {
  if (next === presets) return;
  presets = next;
  layout = DL.activePreset(presets).layout;
  savePresets();
  if (rebuild) build();
  else buildPresetTabs();
}

/** Switch to a preset's layout, bringing the Cards view up if it was not. */
function showPreset(next) {
  if (mode === 'cards') { commitPresets(next); return; }
  presets = next;
  savePresets();
  setMode('cards');
}

/**
 * The preset strip beside the title. A click shows that layout (and the
 * Cards view, if Telemetry was up); a double-click renames it; + saves the
 * layout on screen as a new preset and asks for its name. Deleting one is in
 * Customize, out of reach of a stray click mid-test.
 */
function buildPresetTabs({ renaming = null } = {}) {
  const strip = $('#preset-tabs');
  clear(strip);
  for (const p of presets.list) {
    if (p.id === renaming) {
      strip.append(presetNameInput(p));
      continue;
    }
    const active = p.id === presets.active && mode === 'cards';
    strip.append(el('button', {
      class: active ? 'active' : '',
      'aria-pressed': String(active),
      dataset: { preset: p.id },
      title: `${p.name} · double-click to rename`,
      text: p.name,
      onclick: () => showPreset(DL.selectPreset(presets, p.id)),
      ondblclick: () => buildPresetTabs({ renaming: p.id }),
    }));
  }
  const full = presets.list.length >= DL.MAX_PRESETS;
  strip.append(el('button.preset-add', {
    title: full ? `At most ${DL.MAX_PRESETS} presets` : 'Save this layout as a new preset',
    'aria-label': 'New preset',
    disabled: full,
    html: icon('plus', 12),
    onclick: () => {
      const next = DL.addPreset(presets, renderedGroups, { layout });
      if (next === presets) return;
      showPreset(next);
      buildPresetTabs({ renaming: presets.active });
    },
  }));
  const input = strip.querySelector('input');
  if (input) { input.focus(); input.select(); }
}

/** Rename in place: Enter or leaving the field keeps it, Esc puts it back. */
function presetNameInput(p) {
  let done = false;
  const fit = (node) => { node.style.width = `${Math.max(6, node.value.length + 1)}ch`; };
  const input = el('input.preset-name', {
    value: p.name,
    maxLength: DL.PRESET_NAME_MAX,
    'aria-label': 'Preset name',
    spellcheck: false,
    oninput: (e) => fit(e.currentTarget),
    onkeydown: (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    },
    onblur: () => finish(true),
  });
  fit(input);
  function finish(keep) {
    if (done) return;
    done = true;
    const next = keep ? DL.renamePreset(presets, p.id, input.value) : presets;
    if (next !== presets) commitPresets(next, { rebuild: false });
    else buildPresetTabs();
    if (editing) buildLayoutBar();
  }
  return input;
}

// ------------------------------------------------------------------ build --

/**
 * Every channel on screen, one entry per place it is drawn — a channel copied
 * into a Watch panel is two views of one sensor. Captured at build time; the
 * update loop walks it instead of looking nodes up by id every frame.
 */
let views = [];
let renderedGroups = [];
let panelTares = [];         // { ids, clearBtn } per panel with a TARE
const sparkView = new WeakMap(); // canvas -> view, for the hover readout

function build() {
  const host = $('#data-body');
  cancelDrag();
  clear(host);
  views = [];
  panelTares = [];
  content.classList.toggle('table-mode', mode !== 'cards');
  content.classList.toggle('layout-editing', editing);
  $('#layout-toggle').classList.toggle('active', editing);
  $('#layout-toggle').closest('.seg').classList.toggle('hidden', mode !== 'cards');
  renderedGroups = groupedSensors();
  // Read from storage once; after that the copy here is the truth (storage
  // can refuse a write), reconciled each build against today's channels.
  presets = presets ? DL.reconcilePresets(presets, renderedGroups) : loadPresets(renderedGroups);
  layout = DL.activePreset(presets).layout;
  buildPresetTabs();
  if (mode === 'cards') buildCards(host, renderedGroups);
  else buildTelemetry(host, renderedGroups);
  buildLayoutBar();
  update();
}

const groupedSensors = () => bus.sensorGroups();

/**
 * The lanes, left to right. A lane's width is its share of the screen; the
 * panels in it divide its height by what they hold (see panelExtent), so a
 * panel of compact lines takes exactly its lines and the cards in the lane
 * take the rest.
 */
function buildCards(host, groups) {
  const sensorById = new Map(groups.flatMap((g) => g.sensors.map((s) => [s.id, s])));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupOf = new Map(groups.flatMap((g) => g.sensors.map((s) => [s.id, g])));
  const ctx = { sensorById, groupById, groupOf };

  // An emptied group panel is out of sight until refilled, and a lane with
  // nothing left to show gives its width to the others.
  const lanes = layout.lanes
    .map((lane, index) => ({
      lane, index,
      panels: lane.panels.map((id) => layout.panels[id]).filter((p) => editing || p.items.length),
    }))
    .filter((l) => editing || l.panels.length);

  // Gutters sit between the lanes as grid columns of their own: drag one to
  // resize the lanes either side of it. While editing they widen a little and
  // there is one at each end too, for dropping a panel into a new lane.
  const gutterPx = editing ? 14 : 10;
  gridSpec = [];
  const dash = el('div.dash', { class: editing ? 'editing' : '' });
  if (editing) { dash.append(laneSlot(0, null, null)); gridSpec.push(gutterPx); }
  lanes.forEach(({ lane, index, panels }, i) => {
    if (i > 0) { dash.append(laneSlot(index, lanes[i - 1].index, index)); gridSpec.push(gutterPx); }
    gridSpec.push({ lane: index });
    dash.append(el('div.dash-lane', { class: lane.fill ? 'fill' : '', dataset: { lane: String(index) } },
      editing ? laneBar(lane, index) : null,
      panels.map((p) => panelNode(p, ctx, lane))
    ));
  });
  if (editing) { dash.append(laneSlot(layout.lanes.length, null, null)); gridSpec.push(gutterPx); }
  applyGrid(dash, layout.lanes.map((l) => l.w));
  host.append(dash);
}

/** The dash's columns: gutters in px, lanes as `fr` shares. */
let gridSpec = [];
function applyGrid(dash, widths) {
  dash.style.gridTemplateColumns = gridSpec
    .map((c) => (typeof c === 'number' ? `${c}px` : `minmax(0, ${widths[c.lane]}fr)`))
    .join(' ');
  // Shares as a percentage of what is on screen, on each lane's bar.
  const shown = gridSpec.filter((c) => typeof c !== 'number').map((c) => c.lane);
  const total = shown.reduce((sum, i) => sum + widths[i], 0);
  for (const node of dash.querySelectorAll('.lane-w')) {
    node.textContent = `${Math.round((widths[Number(node.dataset.lane)] / total) * 100)}%`;
  }
}

/**
 * A gutter between two lanes, or (`left`/`right` null) at an end of the row.
 * Between lanes it is a resize handle; while editing, every gutter is also a
 * drop target for a panel that wants a lane of its own.
 */
function laneSlot(at, left, right) {
  const resizable = left != null && right != null;
  return el('div.lane-slot', {
    class: resizable ? 'resizable' : '',
    dataset: { at: String(at) },
    title: [
      resizable ? 'Drag to resize the lanes either side · double-click to make them equal' : null,
      editing ? 'Drop a panel here for a new lane' : null,
    ].filter(Boolean).join('\n'),
    onpointerdown: resizable ? (e) => startResize(e, left, right) : null,
    ondblclick: resizable ? () => {
      const even = (layout.lanes[left].w + layout.lanes[right].w) / 2;
      const widths = layout.lanes.map((l) => l.w);
      widths[left] = widths[right] = even;
      commit(DL.setLaneWidths(layout, renderedGroups, widths));
    } : null,
  });
}

/**
 * Drag a gutter: the two lanes beside it trade width, live, and the result is
 * kept on release. Only those two move — the rest of the row holds still, so
 * a border can be put exactly where it is wanted without chasing the others.
 */
function startResize(e, left, right) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const dash = handle.closest('.dash');
  const laneEl = (i) => dash.querySelector(`.dash-lane[data-lane="${i}"]`);
  const pxL = laneEl(left).getBoundingClientRect().width;
  const pxR = laneEl(right).getBoundingClientRect().width;
  const wL = layout.lanes[left].w, wR = layout.lanes[right].w;
  const x0 = e.clientX;
  const widths = layout.lanes.map((l) => l.w);
  let moved = false;
  handle.classList.add('active');
  document.body.classList.add('lane-resizing');

  const move = (ev) => {
    if (Math.abs(ev.clientX - x0) > 2) moved = true;
    [widths[left], widths[right]] = DL.resizePair(wL, wR, pxL, pxR, ev.clientX - x0);
    applyGrid(dash, widths);
    // Redraw now so the traces follow their new width instead of stretching.
    update();
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    handle.classList.remove('active');
    document.body.classList.remove('lane-resizing');
    if (moved) commit(DL.setLaneWidths(layout, renderedGroups, widths));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function laneBar(lane, index) {
  return el('div.lane-bar', {},
    el('span.lane-bar-label', { text: 'Width' }),
    el('span.lane-w', { dataset: { lane: String(index) }, title: 'Share of the screen — drag the gap beside the lane to change it' }),
    el('button.lb-btn.lb-fill', {
      class: lane.fill ? 'active' : '',
      'aria-pressed': String(!!lane.fill),
      title: lane.fill
        ? 'Filling: everything in this lane stretches to its full height. Click to go back to standard heights.'
        : 'Stretch everything in this lane — cards and compact lines — to fill its full height',
      text: 'Fill',
      onclick: () => commit(DL.setLaneFill(layout, renderedGroups, index, !lane.fill)),
    }),
    el('button.lb-btn.lb-add', {
      title: 'Add an empty panel at the bottom of this lane',
      html: icon('plus', 11),
      onclick: () => commit(DL.addPanel(layout, renderedGroups, { title: 'Panel', size: 'compact', laneIndex: index }).layout),
    })
  );
}

function panelNode(panel, ctx, lane) {
  const group = panel.group ? ctx.groupById.get(panel.group) : null;
  const title = panel.title || group?.label || 'Panel';
  const ext = DL.panelExtent(panel, HEAD_PX, { fill: !!lane.fill });
  const style = { '--group-color': group?.color || 'var(--text-muted)' };
  // Compact lines share one reading width, so everything after the name —
  // trend, reading, rate — lines up down the panel like table columns.
  const rows = panel.items.filter((it) => DL.itemSize(panel, it) === 'compact');
  if (rows.length) {
    style['--row-num'] = `${Math.max(...rows.map((it) => valueWidthCh(ctx.sensorById.get(it.id))))}ch`;
  }
  // A panel grows into spare lane height in proportion to the cards it holds,
  // and no further than its cards can usefully use. Lines never grow —
  // unless the lane is set to fill, where nothing has a ceiling.
  if (ext.grow > 0) {
    Object.assign(style, { flex: `${ext.grow} 1 0px`, minHeight: `${ext.min}px` });
    if (Number.isFinite(ext.max)) style.maxHeight = `${ext.max}px`;
  } else {
    style.flex = 'none';
  }

  const columns = DL.splitColumns(panel);
  const node = el('section.dash-panel', {
    dataset: { panel: panel.id, size: panel.size, ...(panel.group ? {} : { custom: 'true' }) },
    style,
  },
    el('div.col-head', {
      onpointerdown: editing ? (e) => pressDrag(e, 'panel', { panelId: panel.id }) : null,
    },
      editing ? el('span.grip', { title: 'Drag to move this panel', text: '⋮⋮' }) : null,
      el('span.group-swatch'),
      editing && !panel.group
        ? el('input.panel-title', {
          value: title,
          title: 'Rename this panel',
          onchange: (e) => commit(DL.renamePanel(layout, renderedGroups, panel.id, e.target.value)),
          onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
        })
        : el('span.col-label', { text: title, title }),
      el('span.col-count', { text: String(panel.items.length) }),
      editing ? panelTools(panel) : panelTareButtons(panel)
    ),
    el('div.panel-body', { style: { '--cols': String(columns.length) } },
      columns.map((items) => el('div.panel-col', {},
        items.map((item) => itemNode(panel, item, ctx))
      )),
      editing && !panel.items.length
        ? el('div.panel-empty', { text: panel.group ? 'Empty — hidden until a channel is dragged back' : 'Drag channels here' })
        : null
    )
  );
  return node;
}

/** Size, columns and delete, on a panel's head while editing. */
function panelTools(panel) {
  const sizeBtn = (size, label, title) => el('button', {
    class: panel.size === size && !panel.items.some((it) => it.size) ? 'active' : '',
    title, text: label,
    onclick: () => commit(DL.setPanelSize(layout, renderedGroups, panel.id, size)),
  });
  return el('div.panel-tools', {},
    el('div.seg.xs', { title: 'Size of every channel in this panel' },
      sizeBtn('large', 'L', 'Large cards — for the channels being watched'),
      sizeBtn('card', 'C', 'Standard cards'),
      sizeBtn('compact', '≡', 'Compact lines, stacked tight — like the telemetry table')
    ),
    el('div.seg.xs', { title: 'Columns of channels inside this panel' },
      [1, 2, 3].map((n) => el('button', {
        class: panel.cols === n ? 'active' : '',
        text: String(n),
        title: `${n} column${n > 1 ? 's' : ''} inside the panel`,
        onclick: () => commit(DL.setPanelCols(layout, renderedGroups, panel.id, n)),
      }))
    ),
    panel.group ? null : el('button.lb-btn', {
      title: 'Delete this panel — its channels go back to their groups',
      text: '✕',
      onclick: () => commit(DL.removePanel(layout, renderedGroups, panel.id)),
    })
  );
}

function itemNode(panel, item, ctx) {
  const sensor = ctx.sensorById.get(item.id);
  const group = ctx.groupOf.get(item.id);
  const size = DL.itemSize(panel, item);
  const view = size === 'compact' ? sensorRow(sensor) : sensorCard(sensor, size);
  views.push(view);
  const node = view.node;
  node.dataset.sensor = sensor.id;
  // A channel carries its own group's colour wherever it is put, so a copy in
  // a Watch panel still says LOX or Fuel at a glance.
  node.style.setProperty('--group-color', group?.color || '#64748b');
  if (editing) {
    node.addEventListener('pointerdown', (e) => pressDrag(e, 'item', { sensorId: sensor.id, fromPanel: panel.id }));
    node.append(itemTools(panel, item, size));
  }
  return node;
}

/** Per-channel size, copy-to-Watch and remove, over a channel while editing. */
function itemTools(panel, item, size) {
  const set = (s) => commit(DL.setItemSize(layout, renderedGroups, panel.id, item.id, s));
  const dup = DL.placements(layout, item.id) > 1;
  return el('div.item-tools', {},
    el('div.seg.xs', {},
      [['large', 'L'], ['card', 'C'], ['compact', '≡']].map(([s, label]) => el('button', {
        class: size === s ? 'active' : '', text: label, title: `Show ${item.id} ${s === 'compact' ? 'as a compact line' : `as a ${s} card`}`,
        onclick: () => set(s),
      }))
    ),
    panel.title === 'Watch' && !panel.group ? null : el('button.lb-btn', {
      title: `Also show ${item.id} in the Watch panel`,
      text: '★',
      onclick: () => {
        const made = DL.ensurePanel(layout, renderedGroups, 'Watch');
        commit(DL.moveItem(made.layout, renderedGroups, { sensorId: item.id, fromPanel: panel.id, toPanel: made.id, copy: true }));
      },
    }),
    dup ? el('button.lb-btn', {
      title: `Remove this copy of ${item.id} (it is shown elsewhere too)`,
      text: '✕',
      onclick: () => commit(DL.removeItem(layout, renderedGroups, panel.id, item.id)),
    }) : null
  );
}

/** The editing toolbar: how-to, add a panel, reset, done. */
function buildLayoutBar() {
  const bar = $('#layout-bar');
  clear(bar);
  bar.classList.toggle('hidden', !editing);
  if (!editing) return;
  bar.append(
    el('span.lb-hint', {},
      el('b', { text: `Customizing ${DL.activePreset(presets).name}` }),
      ' Drag channels between panels (hold Ctrl to copy) · drag a panel by its header, or onto a gap between lanes for a new lane · ',
      'drag a gap to resize lanes · L / C / ≡ set large, card or compact line'),
    el('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      el('button.btn.sm', {
        title: 'A new panel of large cards on the left, for the channels you are watching',
        html: `${icon('plus', 13)} Watch panel`,
        onclick: () => commit(DL.ensurePanel(layout, renderedGroups, 'Watch').layout),
      }),
      el('button.btn.sm', {
        title: 'Give every lane the same width',
        text: 'Even widths',
        onclick: () => commit(DL.setLaneWidths(layout, renderedGroups, layout.lanes.map(() => 1))),
      }),
      el('button.btn.sm', {
        title: 'Back to one lane per sensor group, every channel a card',
        text: 'Reset',
        onclick: () => {
          if (!confirm(`Reset "${DL.activePreset(presets).name}" to one lane per group, every channel a card?`)) return;
          commit(DL.defaultLayout(renderedGroups));
        },
      }),
      el('button.btn.sm', {
        title: presets.list.length > 1 ? 'Delete this preset' : 'The last preset cannot be deleted',
        disabled: presets.list.length <= 1,
        text: 'Delete preset',
        onclick: () => {
          const { id, name } = DL.activePreset(presets);
          if (!confirm(`Delete the preset "${name}"? This cannot be undone.`)) return;
          commitPresets(DL.removePreset(presets, id));
        },
      }),
      el('button.btn.sm.accent', { text: 'Done', onclick: () => setEditing(false) })
    )
  );
}

/**
 * Zero every channel in a panel, rendered only where the hardware can do it.
 *
 * Addressed by explicit sensor list rather than by group name: the server
 * knows nothing about how this page chooses to arrange things, and shipping
 * the ids keeps the two from having to agree on a taxonomy. That also makes a
 * Watch panel's TARE zero exactly what is in it.
 */
function panelTareButtons(panel) {
  if (bus.spectator) return [];
  const ids = panel.items.map((it) => it.id).filter((id) => bus.canTare(id));
  if (!ids.length) return [];
  const label = panel.title || bus.sensorGroups().find((g) => g.id === panel.group)?.label || 'panel';
  const clearBtn = el('button.tare-chip.clear.hidden', {
    title: `Remove every zero offset in ${label}`,
    text: '✕',
    onclick: () => runTare({ sensors: ids, clear: true }, label),
  });
  panelTares.push({ ids, clearBtn });
  return [
    el('button.tare-chip', {
      title: `Zero all ${ids.length} ${label} channels against their current readings`,
      text: 'TARE',
      onclick: () => runTare({ sensors: ids }, label),
    }),
    clearBtn,
  ];
}

/**
 * Issue a tare and report what came back.
 *
 * Deliberately no confirmation dialog. A tare is visible for as long as it is
 * applied (the button shows the offset), reversible in one click, and written
 * to the event log and the CSV. That is a better safety property than a modal,
 * and it does not cost a click every time a channel is zeroed before a test.
 */
async function runTare(spec, what) {
  const res = await bus.post('/api/tare', spec);
  if (!res.ok) return;                       // bus already toasted the reason
  const n = res.tared?.length ?? 0;
  toast(spec.clear ? `Tare cleared on ${n} channel(s)` : `Tared ${n} channel(s) — ${what}`, 'ok');
}

/** What a DAQ channel status means, on the card. */
const DAQ_FAULTS = {
  unconfigured: ['NOT CALIBRATED', 'The DAQ has no calibration for this channel, so it sends no reading.\n'
    + 'For a load cell: set its rated capacity and rated output (mV/V) in Config › Channels.'],
  disconnected: ['NO SIGNAL', 'The DAQ sees an open or out-of-range input on this channel: check the cable and the transducer.'],
};

function showDaqFault(node, daq) {
  if (!node) return;
  node.classList.toggle('hidden', !daq);
  if (!daq) return;
  const [label, title] = DAQ_FAULTS[daq] || [String(daq).toUpperCase(), `DAQ channel status: ${daq}`];
  node.textContent = label;
  node.title = title;
}

/**
 * A card: the standard size, or `large` for the channels being watched.
 *
 * The name leads and the tag follows it, not the other way round. On a wall
 * of twenty-two cards "LOX Tank Downstream" is what an operator is looking
 * for; PT4 is how they confirm it once found. The tag stays in monospace so
 * it still scans as an identifier.
 */
function sensorCard(sensor, size = 'card') {
  // An empty title, so the card's own tooltip does not cover the hover readout.
  const canvas = el('canvas.s-spark', { title: '' });
  const v = {
    sensor, kind: 'card', canvas,
    num: el('span.s-num', { style: { minWidth: `${valueWidthCh(sensor)}ch` }, text: '––––' }),
    rate: el('span.s-rate', { dataset: { dir: 'flat' }, text: '' }),
    min: el('span', { text: '––' }),
    max: el('span', { text: '––' }),
    bar: el('i', { style: { width: '0%' } }),
    daq: el('span.s-daq.hidden'),
    ...tareControls(sensor),
  };
  sparkView.set(canvas, v);

  v.node = el('div.sensor-card', {
    class: size === 'large' ? 'sz-large' : '',
    // Spread rather than a null: `dataset` is assigned wholesale, and a null
    // there lands in the DOM as the string "null".
    dataset: { status: 'stale', ...(sensor.board && { board: 'true' }) },
  },
    el('div.s-top', {},
      el('span.s-name', { text: sensor.name, title: sensor.name }),
      // Why there is no reading, when the DAQ says (an uncalibrated load
      // cell, an open input). Hidden while the channel is healthy.
      v.daq,
      el('span.s-status')
    ),
    // Window min/max on the face of the card rather than in its tooltip:
    // "how high did it peak" is asked during the run, and an answer that
    // needs a mouse hover is an answer nobody gets while working the valves.
    // It rides in the tag row rather than taking one of its own, because a
    // row costs every card 13px.
    el('div.s-sub', {},
      el('span.s-id', { text: sensor.id }),
      el('span.s-ch', { text: channelLabel(sensor), title: channelTitle(sensor) }),
      el('span.s-stat', {}, el('i', { text: 'MIN' }), v.min),
      el('span.s-stat', {}, el('i', { text: 'MAX' }), v.max),
      v.tb, v.tx
    ),
    el('div.s-value', {},
      // Width reserved for the widest reading in range, so the units label
      // and the rate beside it never shift as digits come and go.
      v.num,
      el('span.s-units', { text: sensor.units }),
      v.rate
    ),
    canvas,
    el('div.s-bar', {}, v.bar)
  );
  return v;
}

/**
 * A compact line, for channels that need to be on the page but not watched:
 * the telemetry table's row, cut loose from the table.
 *
 *   ● Name      ~~~trend~~~  12.3 psi  ▲ 0.4/s  MIN … MAX …
 *
 * No channel tag: on a line, during ops, the name is what is read (the tag
 * is in the name's tooltip). The name takes a fixed share of the line, so
 * every trend in a panel starts at the same x and the readings line up.
 *
 * What fits is decided by the panel's width (container queries in the CSS):
 * the name and the reading always, then the trend and rate, then min/max.
 */
function sensorRow(sensor) {
  const canvas = el('canvas.r-spark', { title: '' });
  const v = {
    sensor, kind: 'row', canvas,
    // Width from the panel's --row-num, shared by every line in it.
    num: el('span.s-num', { text: '––––' }),
    rate: el('span.s-rate', { dataset: { dir: 'flat' }, text: '' }),
    min: el('span', { text: '––' }),
    max: el('span', { text: '––' }),
    daq: el('span.s-daq.hidden'),
    ...tareControls(sensor),
  };
  sparkView.set(canvas, v);
  v.node = el('div.sensor-row', {
    dataset: { status: 'stale', ...(sensor.board && { board: 'true' }) },
  },
    el('span.s-status'),
    el('span.r-name', { text: sensor.name, title: `${sensor.name} · ${sensor.id}\n${channelTitle(sensor)}` }),
    canvas,
    v.daq,
    el('span.r-value', {}, v.num, el('span.s-units', { text: sensor.units })),
    v.rate,
    el('span.r-stats', {},
      el('span.s-stat', {}, el('i', { text: 'MIN' }), v.min),
      el('span.s-stat', {}, el('i', { text: 'MAX' }), v.max)),
    v.tb, v.tx
  );
  return v;
}

/**
 * Where the reading comes from: a DAQ channel number, or the bang-bang bus.
 *
 * The distinction is worth a line on the card. A board PT is not in the
 * recorded CSV, it does not tare with the rest of its column, and it is the
 * one transducer whose value a controller acts on directly — reading it as
 * just another channel would be reading it wrong.
 */
function channelLabel(sensor) {
  return sensor.board ? `board ${sensor.side}` : `ch ${sensor.channel}`;
}

function channelTitle(sensor) {
  if (!sensor.board) return `DAQ channel ${sensor.channel}`;
  const name = bus.controller(sensor.controller)?.name || sensor.controller;
  return [
    `The bang-bang board's own transducer on bus ${sensor.side} — the one ${name}`,
    'regulates against. It arrives on the board heartbeat, not the DAQ stream,',
    'and it is not written to the recorded CSV.',
    '',
    'Zeroed from its card on the actuation pages, never from here.',
  ].join('\n');
}

/**
 * The zero controls for one channel: a TARE button that shows the live offset
 * once one is applied, and a CLEAR button that only exists while there is
 * something to clear.
 *
 * One button doing both jobs would mean either a modifier key nobody
 * discovers, or losing the ability to re-zero a channel that has drifted
 * without first clearing it. Two buttons cost one small glyph.
 */
function tareControls(sensor) {
  // A tare changes what every screen reads, the operator's included. It is an
  // instrumentation command, not a view setting, so the spectator port neither
  // offers it nor accepts it — updateTareControls tolerates the missing nodes.
  // Nor is one offered while the layout is being edited, where a stray click
  // meant for a drag handle would zero a channel.
  if (bus.spectator || editing) return { tb: null, tx: null };
  // Nor does a board transducer get one. Its zero lives in the board's EEPROM,
  // is refused while that side is regulating, and belongs on the card that
  // owns the loop — /api/tare could not apply it if this button sent it.
  if (sensor.board) return { tb: null, tx: null };
  return {
    tb: el('button.tare-chip.hidden', {
      title: `Zero ${sensor.id} against its current reading`,
      text: 'TARE',
      onclick: () => runTare({ sensors: [sensor.id] }, sensor.id),
    }),
    tx: el('button.tare-chip.clear.hidden', {
      title: `Remove the zero offset on ${sensor.id}`,
      text: '✕',
      onclick: () => runTare({ sensors: [sensor.id], clear: true }, sensor.id),
    }),
  };
}

/**
 * The telemetry table: one row per channel, with the channel's recent history
 * drawn inline between its name and its value.
 *
 *   Subsystem | Tag | Channel | ───trend─── | Value | Rate | Min | Max | Ch | Tare
 *
 * The trend takes the widest column on purpose. A value tells you where a
 * channel is; the trace beside it tells you where it is going, and on a table
 * of thirty rows that is what lets the eye find the one channel that is
 * moving. Step channels -- a pressure that jumps when a valve cycles -- read
 * as square waves, which is exactly how they should read.
 *
 * Rows are grouped (LOX, then Fuel, ...) and the subsystem column carries the
 * group in the same quiet mono as the tag, with its colour as a small swatch,
 * rather than a banner row: the table stays one uninterrupted list to scan.
 */
function buildTelemetry(host, groups) {
  const wrap = el('div.table-wrap.telemetry-wrap');
  // Fixed layout: with `auto`, every column re-measures as readings change and
  // the whole table twitches at the stream rate.
  const table = el('table.data-table.telemetry.fixed');

  // The Tare column goes entirely on a spectator view rather than standing
  // empty: a header over a column that can never hold anything reads as a
  // feature that failed to load.
  const tare = !bus.spectator;
  const cols = [
    { h: 'Subsystem', w: '118px', cls: 'opt' },
    { h: 'Tag', w: '72px' },
    { h: 'Channel', w: '19%' },
    { h: 'Trend', w: 'auto', cls: 'trend-col' },
    { h: 'Value', w: '118px', num: true },
    { h: 'Rate', w: '112px', num: true, cls: 'opt' },
    { h: 'Min', w: '78px', num: true },
    { h: 'Max', w: '78px', num: true },
    { h: 'Ch', w: '70px', num: true, cls: 'opt' },
  ];
  if (tare) cols.push({ h: 'Tare', w: '96px' });

  table.append(el('colgroup', {}, cols.map((c) => el('col', { class: c.cls || '', style: c.w === 'auto' ? {} : { width: c.w } }))));
  table.append(el('thead', {}, el('tr', {},
    cols.map((c) => el('th', {
      class: [c.num ? 'num' : '', c.cls || ''].join(' ').trim(),
      text: c.h === 'Trend' ? `Trend · ${windowLabel()}` : c.h,
      id: c.h === 'Trend' ? 'trend-head' : null,
    }))
  )));

  const tbody = el('tbody');
  for (const group of groups) {
    group.sensors.forEach((s, i) => {
      const canvas = el('canvas.t-spark');
      const v = {
        sensor: s, kind: 'tele', canvas,
        num: el('span', { text: '––––' }),
        rate: el('td.num.s-rate.opt', { dataset: { dir: 'flat' }, text: '' }),
        min: el('td.num.t-stat', { text: '––' }),
        max: el('td.num.t-stat', { text: '––' }),
        ...tareControls(s),
      };
      sparkView.set(canvas, v);
      views.push(v);
      v.node = el('tr', {
        class: i === 0 ? 'group-first' : '',
        dataset: { status: 'stale' },
        style: { '--group-color': group.color || '#64748b' },
      },
        el('td.t-sub.opt', {}, el('span.group-swatch'), el('span', { text: group.label })),
        el('td.t-tag', { text: s.id }),
        el('td.t-name', { text: s.name, title: s.name }),
        el('td.t-trend', {}, canvas),
        el('td.num.t-value', {}, v.num, el('span.t-units', { text: s.units })),
        v.rate,
        v.min,
        v.max,
        el('td.num.t-stat.opt', { text: channelLabel(s), title: channelTitle(s) }),
        tare ? el('td.tare-cell', {}, v.tb, v.tx) : null
      );
      tbody.append(v.node);
    });
  }
  table.append(tbody);
  wrap.append(table);
  host.append(wrap);
}

function windowLabel() {
  return WINDOWS.find((w) => w.s === windowSeconds)?.label ?? `${windowSeconds}s`;
}

// ----------------------------------------------------------------- update --

let pendingFrame = false;
bus.on('state', () => {
  if (pendingFrame) return;
  pendingFrame = true;
  requestAnimationFrame(() => { pendingFrame = false; update(); });
});

function update() {
  if (!bus.state) return;

  updateTareControls();

  // One computation per sensor however many times it is drawn.
  const memo = new Map();
  for (const v of views) {
    const sensor = v.sensor;
    let m = memo.get(sensor.id);
    if (!m) {
      const value = bus.reading(sensor.id);
      m = {
        value,
        status: bus.sensorStatus(sensor.id),
        stats: windowStats(sensor.id, windowSeconds),
        rate: fmtRate(bus.rate(sensor.id, RATE_SECONDS), sensor),
        daq: bus.state.sensors?.[sensor.id]?.daq,
      };
      memo.set(sensor.id, m);
    }

    v.node.dataset.status = m.status;
    v.rate.textContent = m.rate.text;
    v.rate.dataset.dir = m.rate.dir;
    v.min.textContent = fmtValue(m.stats.min, sensor.decimals);
    v.max.textContent = fmtValue(m.stats.max, sensor.decimals);

    if (v.kind === 'tele') {
      v.num.textContent = m.daq ? (DAQ_FAULTS[m.daq]?.[0] || String(m.daq).toUpperCase()) : fmtValue(m.value, sensor.decimals);
      v.num.title = m.daq ? (DAQ_FAULTS[m.daq]?.[1] || '') : '';
    } else {
      v.num.textContent = fmtValue(m.value, sensor.decimals);
      showDaqFault(v.daq, m.daq);
      if (v.bar) v.bar.style.width = `${normalize(m.value, sensor.min, sensor.max) * 100}%`;
      v.node.title = `${sensor.id} — ${sensor.name}\n`
        + `min ${fmtValue(m.stats.min, sensor.decimals)} · max ${fmtValue(m.stats.max, sensor.decimals)} `
        + `${sensor.units} over ${windowSeconds}s`;
    }
    drawSpark(v, m.status);
  }
  const head = $('#trend-head');
  if (head) head.textContent = `Trend · ${windowLabel()}`;
}


/**
 * Reflect tare state: which channels offer the buttons, which are currently
 * zeroed, and by how much.
 *
 * A tared channel reading 0 psi is indistinguishable from an untared one, so
 * the offset is shown on the button itself rather than tucked in a tooltip.
 */
function updateTareControls() {
  for (const { sensor, tb, tx } of views) {
    if (!tb) continue;
    const offset = bus.tare(sensor.id);
    const tareable = offset !== null;
    const tared = tareable && offset !== 0;

    tb.classList.toggle('hidden', !tareable);
    tb.classList.toggle('on', tared);
    const shown = tared
      ? `${offset > 0 ? '−' : '+'}${fmtValue(Math.abs(offset), sensor.decimals)}`
      : 'TARE';
    if (tb.textContent !== shown) tb.textContent = shown;
    // The sign on the button is the shift applied to what you see, so the
    // wording has to match it: a negative offset ADDS to the reading.
    tb.title = tared
      ? `${fmtValue(Math.abs(offset), sensor.decimals)} ${sensor.units} is being `
        + `${offset > 0 ? 'subtracted from' : 'added to'} ${sensor.id}.\n`
        + 'Click to re-zero at the current reading.'
      : `Zero ${sensor.id} against its current reading`;
    tx.classList.toggle('hidden', !tared);
  }

  for (const { ids, clearBtn } of panelTares) {
    clearBtn.classList.toggle('hidden', !ids.some((id) => (bus.tare(id) ?? 0) !== 0));
  }
}

function windowStats(id, seconds) {
  const series = bus.history.get(id);
  if (!series || !series.v.length) return { min: null, max: null };
  const cutoff = Date.now() - seconds * 1000;
  let min = Infinity, max = -Infinity, found = false;
  for (let i = series.t.length - 1; i >= 0; i--) {
    if (series.t[i] < cutoff) break;
    const v = series.v[i];
    if (v < min) min = v;
    if (v > max) max = v;
    found = true;
  }
  return found ? { min, max } : { min: null, max: null };
}

// --------------------------------------------------------------- sparkline --

function drawSpark(view, status) {
  const alarm = status === 'danger' || status === 'warn';
  // Table rows and compact lines are short: no midline there, just the trace
  // — and no marker labels, which would sit on top of it.
  const short = view.kind !== 'card';
  const hovered = hover?.view === view;
  const sample = drawTrace(view.canvas, bus.history.get(view.sensor.id), windowSeconds, {
    color: statusColor(status),
    fill: alarm,
    grid: short ? null : cssVar('--border', '#232326'),
    markers: showValves ? valveMarkers(!short) : null,
    cursor: hovered ? { t: hoverTime() } : null,
  });
  if (hovered) showHoverTip(view.sensor, sample);
}

// -------------------------------------------------------- valve actuations --

/**
 * Every valve transition still in the event log, oldest first.
 *
 * Read from the log rather than collected from snapshots so that the
 * actuations from before this page was opened are on the trend too. The
 * server logs each real change of position exactly once — "B2 (LOX Main)
 * -> OPEN" when commanded, "B2 -> OPEN" when a sequence or controller moved
 * it — and a re-command of the position a valve already holds is not logged,
 * so nothing here is a duplicate. Bang-bang pulses are not logged edge by
 * edge, so a regulating valve shows only the command that handed it over.
 */
let actuationCache = { key: null, list: [] };
function actuations() {
  const last = bus.events[bus.events.length - 1];
  const key = `${bus.events.length}:${last?.seq}`;
  if (actuationCache.key === key) return actuationCache.list;
  const list = [];
  for (const e of bus.events) {
    if (e.level !== 'command' && e.level !== 'control') continue;
    const m = /^(\S+)(?: \(.*\))? -> (OPEN|CLOSED)$/.exec(e.message);
    if (m && bus.valve(m[1])) list.push({ t: e.t, id: m[1], state: m[2] });
  }
  actuationCache = { key, list };
  return list;
}

function valveMarkers(labels) {
  const open = cssVar('--ok', '#22c55e');
  const closed = cssVar('--danger', '#ef4444');
  return actuations().map((a) => ({
    t: a.t,
    color: a.state === 'OPEN' ? open : closed,
    dashed: a.state !== 'OPEN',
    label: labels ? a.id : null,
  }));
}

// ------------------------------------------------------------ hover readout --

/**
 * Pointing at a trend reads it: the sample under the pointer, how long ago it
 * was taken, and any valve that moved within a few pixels of it.
 *
 * The hover is kept as a fraction of the trace's width rather than as a time,
 * so a pointer held still keeps reading the same spot on the screen while the
 * data scrolls under it — the readout tracks what is under the hairline.
 */
let hover = null;   // { view, frac, width, x, y } — x/y are the pointer, for placing the tip
let hoverTip = null;

function hoverTime() {
  return Date.now() - (1 - hover.frac) * windowSeconds * 1000;
}

function onSparkMove(e) {
  if (editing) return;
  const canvas = e.target.closest?.('canvas.s-spark, canvas.t-spark, canvas.r-spark');
  const view = canvas && sparkView.get(canvas);
  if (!view) { clearHover(); return; }
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const prev = hover?.view;
  hover = {
    view,
    frac: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    width: r.width,
    x: e.clientX,
    y: e.clientY,
  };
  if (prev && prev !== view) redraw(prev);
  redraw(view);
}

function clearHover() {
  if (!hover) return;
  const { view } = hover;
  hover = null;
  if (hoverTip) hoverTip.hidden = true;
  redraw(view);
}

function redraw(view) {
  if (views.includes(view)) drawSpark(view, bus.sensorStatus(view.sensor.id));
}

function showHoverTip(sensor, sample) {
  hoverTip ??= document.body.appendChild(el('div.spark-tip', { role: 'tooltip' }));
  if (!sample) { hoverTip.hidden = true; return; }
  clear(hoverTip);
  const ago = (Date.now() - sample.t) / 1000;
  hoverTip.append(
    el('div.st-name', {}, el('span.st-tag', { text: sensor.id }), el('span', { text: sensor.name })),
    el('div.st-value', {},
      el('b', { text: fmtValue(sample.v, sensor.decimals) }),
      el('span', { text: ` ${sensor.units}` })),
    el('div.st-time', { text: `${ago < 0.05 ? 'now' : `${ago.toFixed(1)} s ago`} · ${clockTime(sample.t)}` })
  );

  // Valves that moved within a few pixels of the hairline: close enough that
  // the eye would attribute that marker to this spot on the trace.
  if (showValves) {
    const slack = (windowSeconds * 1000 * 4) / hover.width;
    const near = actuations().filter((a) => Math.abs(a.t - sample.t) <= slack);
    for (const a of near) {
      const valve = bus.valve(a.id);
      hoverTip.append(el('div.st-valve', { dataset: { state: a.state.toLowerCase() } },
        el('b', { text: `${a.id} → ${a.state}` }),
        el('span', { text: ` ${valve?.name ?? ''} · ${clockTime(a.t)}` })));
    }
  }

  hoverTip.hidden = false;
  // Beside the pointer, flipped to the other side near the window's edges.
  const tw = hoverTip.offsetWidth, th = hoverTip.offsetHeight;
  const left = hover.x + 14 + tw > innerWidth ? hover.x - 14 - tw : hover.x + 14;
  const top = hover.y + 14 + th > innerHeight ? hover.y - 10 - th : hover.y + 14;
  hoverTip.style.left = `${Math.max(4, left)}px`;
  hoverTip.style.top = `${Math.max(4, top)}px`;
}

function clockTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour12: false }) + `.${String(d.getMilliseconds()).padStart(3, '0').slice(0, 1)}`;
}

$('#data-body').addEventListener('pointermove', onSparkMove);
$('#data-body').addEventListener('pointerleave', clearHover);

// ------------------------------------------------------------ drag & drop --
//
// Pointer events rather than HTML5 drag and drop, as in the channel editor:
// the native kind does nothing on a touchscreen. A press only becomes a drag
// once it has moved a few pixels, so the size buttons are still clickable.

let drag = null;

function pressDrag(e, kind, spec) {
  if (e.button !== 0 || e.target.closest('input, select, button')) return;
  const node = e.currentTarget.closest(kind === 'item' ? '[data-sensor]' : '.dash-panel');
  drag = { kind, spec, node, x0: e.clientX, y0: e.clientY, active: false, ghost: null };
  window.addEventListener('pointermove', moveDrag);
  window.addEventListener('pointerup', dropDrag, { once: true });
  window.addEventListener('pointercancel', cancelDrag, { once: true });
  window.addEventListener('keydown', dragKey);
  window.addEventListener('keyup', dragKey);
}

function moveDrag(e) {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    drag.active = true;
    const r = drag.node.getBoundingClientRect();
    drag.dx = Math.min(drag.x0 - r.left, 60);
    drag.dy = Math.min(drag.y0 - r.top, 20);
    drag.ghost = el('div.dash-ghost', {},
      el('span.group-swatch', { style: { background: getComputedStyle(drag.node).getPropertyValue('--group-color') } }),
      el('span', { text: drag.kind === 'item'
        ? `${drag.spec.sensorId} · ${drag.node.querySelector('.s-name, .r-name')?.textContent ?? ''}`
        : drag.node.querySelector('.col-label, .panel-title')?.textContent || drag.node.querySelector('.panel-title')?.value || 'Panel' }),
      el('b.dg-copy', { text: '+ copy' }));
    document.body.append(drag.ghost);
    drag.node.classList.add('dragging');
    document.body.classList.add('dash-dragging');
  }
  e.preventDefault();
  drag.copy = e.ctrlKey || e.altKey;
  drag.ghost.classList.toggle('copy', drag.kind === 'item' && drag.copy);
  drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
  autoScroll(e.clientY);
  if (drag.kind === 'item') showItemMarker(e.clientX, e.clientY);
  else showPanelMarker(e.clientX, e.clientY);
}

function dragKey(e) {
  if (!drag?.active) return;
  if (e.key === 'Escape') { cancelDrag(); return; }
  drag.copy = e.ctrlKey || e.altKey;
  drag.ghost.classList.toggle('copy', drag.kind === 'item' && drag.copy);
}

function dropDrag(e) {
  const d = drag;
  if (!d?.active) { cancelDrag(); return; }
  const marker = document.querySelector('.dash-marker');
  const slot = document.querySelector('.lane-slot.over');
  const target = marker ? { ...marker.dataset } : null;
  const copy = e.ctrlKey || e.altKey || d.copy;
  cancelDrag();
  // The click that follows this pointerup would otherwise land on whatever
  // button the drop was over.
  window.addEventListener('click', swallowClick, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);

  if (d.kind === 'item' && target?.panel) {
    commit(DL.moveItem(layout, renderedGroups, {
      sensorId: d.spec.sensorId, fromPanel: d.spec.fromPanel, toPanel: target.panel,
      beforeId: target.before || null, copy,
    }));
  } else if (d.kind === 'panel') {
    if (slot) commit(DL.movePanel(layout, renderedGroups, { panelId: d.spec.panelId, newLaneAt: Number(slot.dataset.at) }));
    else if (target?.lane) {
      commit(DL.movePanel(layout, renderedGroups, {
        panelId: d.spec.panelId, toLane: Number(target.lane), beforeId: target.before || null,
      }));
    }
  }
}

function swallowClick(e) { e.stopPropagation(); e.preventDefault(); }

function cancelDrag() {
  window.removeEventListener('pointermove', moveDrag);
  window.removeEventListener('keydown', dragKey);
  window.removeEventListener('keyup', dragKey);
  drag?.ghost?.remove();
  drag = null;
  document.body.classList.remove('dash-dragging');
  document.querySelectorAll('.dash-marker').forEach((m) => m.remove());
  document.querySelectorAll('.lane-slot.over').forEach((m) => m.classList.remove('over'));
  document.querySelectorAll('#data-body .dragging').forEach((n) => n.classList.remove('dragging'));
}

function autoScroll(y) {
  const body = $('#data-body');
  const r = body.getBoundingClientRect();
  if (y < r.top + 30) body.scrollTop -= 12;
  else if (y > r.bottom - 30) body.scrollTop += 12;
}

/** The element under the pointer, ignoring the ghost and markers. */
function under(x, y) {
  return document.elementFromPoint(x, y);
}

/**
 * A line where the channel will land. Over a panel, the nearest column of it
 * and the gap in that column nearest the pointer.
 */
function showItemMarker(x, y) {
  const panel = under(x, y)?.closest('.dash-panel');
  const old = document.querySelector('.dash-marker');
  if (!panel) { old?.remove(); return; }
  const cols = [...panel.querySelectorAll('.panel-col')];
  const col = cols.find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right; })
    || cols[cols.length - 1];
  const items = [...col.querySelectorAll(':scope > [data-sensor]:not(.dragging)')];
  const before = items.find((n) => { const r = n.getBoundingClientRect(); return y < r.top + r.height / 2; });
  // Past the end of a column that is not the last, the channel lands before
  // the first in the next column — the same spot in reading order.
  let beforeId = before?.dataset.sensor;
  if (!before) {
    const nextCol = cols[cols.indexOf(col) + 1];
    beforeId = nextCol?.querySelector(':scope > [data-sensor]:not(.dragging)')?.dataset.sensor;
  }
  const marker = old || el('div.dash-marker');
  marker.dataset.panel = panel.dataset.panel;
  if (beforeId) marker.dataset.before = beforeId; else delete marker.dataset.before;
  if (before) { if (marker.nextElementSibling !== before || marker.parentNode !== col) col.insertBefore(marker, before); }
  else if (col.lastElementChild !== marker) col.append(marker);
}

function showPanelMarker(x, y) {
  const hit = under(x, y);
  const slot = hit?.closest('.lane-slot');
  document.querySelectorAll('.lane-slot.over').forEach((s) => { if (s !== slot) s.classList.remove('over'); });
  const old = document.querySelector('.dash-marker');
  if (slot) { slot.classList.add('over'); old?.remove(); return; }
  const lane = hit?.closest('.dash-lane');
  if (!lane) { old?.remove(); return; }
  const panels = [...lane.querySelectorAll(':scope > .dash-panel:not(.dragging)')];
  const before = panels.find((p) => { const r = p.getBoundingClientRect(); return y < r.top + r.height / 2; });
  const marker = old || el('div.dash-marker.panel-marker');
  marker.dataset.lane = lane.dataset.lane;
  if (before) marker.dataset.before = before.dataset.panel; else delete marker.dataset.before;
  delete marker.dataset.panel;
  if (before) { if (marker.nextElementSibling !== before || marker.parentNode !== lane) lane.insertBefore(marker, before); }
  else if (lane.lastElementChild !== marker) lane.append(marker);
}

// ------------------------------------------------------------------ prefs --

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

build();
