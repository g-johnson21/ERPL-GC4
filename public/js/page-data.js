/* page-data.js — every instrument on one screen, plus a dense table view.
 *
 * LAYOUT
 *   Cards mode gives each sensor group its own full-height column, and sizes
 *   every card so the longest column exactly fills the viewport. Nothing
 *   scrolls: during a test an operator reads this page at a glance, and a
 *   channel that is one flick of a scroll wheel away is a channel nobody is
 *   watching. That constraint is what every cramped decision below is paying
 *   for — window min/max sits in the tag row for exactly this reason.
 *
 *   Groups come from `sensorGroups` in the config, so LOX and Fuel are
 *   columns with their own outline colour rather than one undifferentiated
 *   wall of pressure transducers.
 */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { $, el, clear, icon, fmtValue, fmtRate, normalize, valueWidthCh, toast } from './util.js';
import { WINDOWS, drawTrace, statusColor, cssVar, windowChips } from './spark.js';

const content = await bootPage('data', { sidebar: false });

/** Window for the rate-of-change fit. Not the sparkline window — a rate
 *  averaged over two minutes would say nothing about a pressurization ramp. */
const RATE_SECONDS = 3;

// `table` was the name of the old plain table; the telemetry table replaced
// it, so a saved preference for one opens the other.
let mode = loadPref('gc4-data-mode', 'cards') === 'cards' ? 'cards' : 'telemetry';
let windowSeconds = Number(loadPref('gc4-data-window', '60'));
if (!WINDOWS.some((w) => w.s === windowSeconds)) windowSeconds = 60;

// ------------------------------------------------------------------ shell --

content.append(
  el('div.page-head', {},
    el('h1', { text: 'Data' }),
    el('span.sub#data-sub', { text: channelSummary() }),
    el('div', { style: { marginLeft: 'auto', display: 'flex', gap: '14px', alignItems: 'center' } },
      // The window scales every trend on the page and the MIN/MAX beside it.
      windowChips(el, windowSeconds, (s) => {
        windowSeconds = s;
        savePref('gc4-data-window', String(s));
        update();
      }, 'Trend window — also the span MIN and MAX are taken over'),
      el('div.seg', {},
        el('button', { id: 'mode-cards', class: mode === 'cards' ? 'active' : '', text: 'Cards', onclick: () => setMode('cards') }),
        el('button', { id: 'mode-telemetry', class: mode === 'telemetry' ? 'active' : '', text: 'Telemetry', onclick: () => setMode('telemetry') })
      )
    )
  ),
  el('div#data-body')
);

// Cards mode owns the viewport: the column grid sizes itself against a
// definite height, which it only has if nothing above it can scroll.
content.classList.add('data-page');

/**
 * The DAQ channels and the boards' transducers counted apart, because they do
 * not arrive the same way: the DAQ streams at the telemetry rate, the board
 * PTs come in on the bang-bang heartbeat.
 */
function channelSummary() {
  const daq = `${bus.config.sensors.length} channels @ ${bus.config.telemetry.streamRateHz} Hz`;
  const board = bus.boardSensors().length;
  return board ? `${daq} · ${board} board PT` : daq;
}

function setMode(next) {
  mode = next;
  savePref('gc4-data-mode', next);
  $('#mode-cards').classList.toggle('active', next === 'cards');
  $('#mode-telemetry').classList.toggle('active', next === 'telemetry');
  build();
}

// ------------------------------------------------------------------ build --

const sparks = new Map(); // sensorId -> canvas

/**
 * Everything currently on screen, in column order: the DAQ channels plus the
 * bang-bang boards' own transducers, which `sensorGroups()` folds in.
 *
 * Captured at build time rather than recomputed every frame. It only changes
 * with the config, and a config reload rebuilds the page anyway.
 */
let rendered = [];
let renderedGroups = [];

function build() {
  const host = $('#data-body');
  clear(host);
  sparks.clear();
  content.classList.toggle('table-mode', mode !== 'cards');
  renderedGroups = groupedSensors();
  rendered = renderedGroups.flatMap((g) => g.sensors);
  if (mode === 'cards') buildCards(host, renderedGroups);
  else buildTelemetry(host, renderedGroups);
  update();
}

const groupedSensors = () => bus.sensorGroups();

/**
 * One column per group, every card the same height.
 *
 * `--rows` is the largest group, and the card height is derived from it in
 * CSS, so the longest column fills the available height exactly and the rest
 * line up with it. Sizing in CSS rather than JS means it survives a window
 * resize with no listener and no reflow loop.
 */
function buildCards(host, groups) {
  const rows = Math.max(1, ...groups.map((g) => g.sensors.length));

  host.append(el('div.sensor-columns', { style: { '--rows': String(rows) } },
    groups.map((group) =>
      el('div.sensor-column', { style: { '--group-color': group.color || '#64748b' } },
        el('div.col-head', {},
          el('span.group-swatch'),
          el('span.col-label', { text: group.label, title: group.label }),
          el('span.col-count', { text: String(group.sensors.length) }),
          ...groupTareButtons(group)
        ),
        group.sensors.map(sensorCard)
      )
    )
  ));
}

/**
 * Zero the whole group, rendered only where the hardware can actually do it.
 *
 * Addressed by explicit sensor list rather than by group name: the server
 * knows nothing about how this page chooses to arrange things, and shipping
 * the ids keeps the two from having to agree on a taxonomy.
 */
function groupTareButtons(group) {
  if (bus.spectator) return [];
  const ids = group.sensors.filter((s) => bus.canTare(s.id)).map((s) => s.id);
  if (!ids.length) return [];
  return [
    el('button.tare-chip', {
      id: `tare-group-${group.id}`,
      title: `Zero all ${ids.length} ${group.label} channels against their current readings`,
      text: 'TARE',
      onclick: () => runTare({ sensors: ids }, group.label),
    }),
    el('button.tare-chip.clear.hidden', {
      id: `untare-group-${group.id}`,
      title: `Remove every zero offset in ${group.label}`,
      text: '✕',
      onclick: () => runTare({ sensors: ids, clear: true }, group.label),
    }),
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

/**
 * The name leads and the tag follows it, not the other way round.
 *
 * On a wall of twenty-two cards "LOX Tank Downstream" is what an operator is
 * looking for; PT4 is how they confirm it once found. The tag stays in
 * monospace so it still scans as an identifier.
 */
function sensorCard(sensor) {
  const canvas = el('canvas.s-spark', { id: `spark-${sensor.id}` });
  sparks.set(sensor.id, canvas);
  const w = valueWidthCh(sensor);

  return el('div.sensor-card', {
    // Spread rather than a null: `dataset` is assigned wholesale, and a null
    // there lands in the DOM as the string "null".
    id: `sc-${sensor.id}`,
    dataset: { status: 'stale', ...(sensor.board && { board: 'true' }) },
  },
    el('div.s-top', {},
      el('span.s-name', { text: sensor.name, title: sensor.name }),
      el('span.s-status')
    ),
    // Window min/max on the face of the card rather than in its tooltip:
    // "how high did it peak" is asked during the run, and an answer that
    // needs a mouse hover is an answer nobody gets while working the valves.
    //
    // It rides in the tag row rather than taking one of its own. A row of its
    // own is what it deserves on merit, and it cost 13px a card — six cards
    // to a column, which put the longest column 47px past the bottom of a
    // 1280x720 screen. This page's whole premise is that nothing scrolls, so
    // the extremes go where there was already room.
    el('div.s-sub', {},
      el('span.s-id', { text: sensor.id }),
      el('span.s-ch', { text: channelLabel(sensor), title: channelTitle(sensor) }),
      el('span.s-stat', {}, el('i', { text: 'MIN' }), el('span', { id: `smin-${sensor.id}`, text: '––' })),
      el('span.s-stat', {}, el('i', { text: 'MAX' }), el('span', { id: `smax-${sensor.id}`, text: '––' })),
      ...tareControls(sensor)
    ),
    el('div.s-value', {},
      // Width reserved for the widest reading in range, so the units label
      // and the rate beside it never shift as digits come and go.
      el('span.s-num', { id: `sv-${sensor.id}`, style: { minWidth: `${w}ch` }, text: '––––' }),
      el('span.s-units', { text: sensor.units }),
      el('span.s-rate', { id: `sr-${sensor.id}`, dataset: { dir: 'flat' }, text: '' })
    ),
    canvas,
    el('div.s-bar', {}, el('i', { id: `sb-${sensor.id}`, style: { width: '0%' } }))
  );
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
 *
 * Both views render these, and only one view is mounted at a time, so the ids
 * stay unique.
 */
function tareControls(sensor) {
  // A tare changes what every screen reads, the operator's included. It is an
  // instrumentation command, not a view setting, so the spectator port neither
  // offers it nor accepts it — updateTareControls tolerates the missing nodes.
  if (bus.spectator) return [];
  // Nor does a board transducer get one. Its zero lives in the board's EEPROM,
  // is refused while that side is regulating, and belongs on the card that
  // owns the loop — /api/tare could not apply it if this button sent it.
  if (sensor.board) return [];
  return [
    el('button.tare-chip.hidden', {
      id: `tb-${sensor.id}`,
      title: `Zero ${sensor.id} against its current reading`,
      text: 'TARE',
      onclick: () => runTare({ sensors: [sensor.id] }, sensor.id),
    }),
    el('button.tare-chip.clear.hidden', {
      id: `tx-${sensor.id}`,
      title: `Remove the zero offset on ${sensor.id}`,
      text: '✕',
      onclick: () => runTare({ sensors: [sensor.id], clear: true }, sensor.id),
    }),
  ];
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
      const canvas = el('canvas.t-spark', { id: `tspark-${s.id}` });
      sparks.set(s.id, canvas);
      tbody.append(el('tr', {
        id: `tr-${s.id}`,
        class: i === 0 ? 'group-first' : '',
        dataset: { status: 'stale' },
        style: { '--group-color': group.color || '#64748b' },
      },
        el('td.t-sub.opt', {}, el('span.group-swatch'), el('span', { text: group.label })),
        el('td.t-tag', { text: s.id }),
        el('td.t-name', { text: s.name, title: s.name }),
        el('td.t-trend', {}, canvas),
        el('td.num.t-value', {},
          el('span', { id: `tv-${s.id}`, text: '––––' }),
          el('span.t-units', { text: s.units })
        ),
        el('td.num.s-rate.opt', { id: `trate-${s.id}`, dataset: { dir: 'flat' }, text: '' }),
        el('td.num.t-stat', { id: `tmin-${s.id}`, text: '––' }),
        el('td.num.t-stat', { id: `tmax-${s.id}`, text: '––' }),
        el('td.num.t-stat.opt', { text: channelLabel(s), title: channelTitle(s) }),
        tare ? el('td.tare-cell', {}, tareControls(s)) : null
      ));
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

  for (const sensor of rendered) {
    const value = bus.reading(sensor.id);
    const status = bus.sensorStatus(sensor.id);
    const stats = windowStats(sensor.id, windowSeconds);

    const rate = fmtRate(bus.rate(sensor.id, RATE_SECONDS), sensor);

    if (mode === 'cards') {
      const card = $(`#sc-${sensor.id}`);
      if (!card) continue;
      card.dataset.status = status;
      $(`#sv-${sensor.id}`).textContent = fmtValue(value, sensor.decimals);
      $(`#sb-${sensor.id}`).style.width = `${normalize(value, sensor.min, sensor.max) * 100}%`;

      const rateEl = $(`#sr-${sensor.id}`);
      rateEl.textContent = rate.text;
      rateEl.dataset.dir = rate.dir;

      $(`#smin-${sensor.id}`).textContent = fmtValue(stats.min, sensor.decimals);
      $(`#smax-${sensor.id}`).textContent = fmtValue(stats.max, sensor.decimals);

      card.title = `${sensor.id} — ${sensor.name}\n`
        + `min ${fmtValue(stats.min, sensor.decimals)} · max ${fmtValue(stats.max, sensor.decimals)} `
        + `${sensor.units} over ${windowSeconds}s`;

      drawSpark(sensor, status);
    } else {
      const row = $(`#tr-${sensor.id}`);
      if (!row) continue;
      row.dataset.status = status;
      $(`#tv-${sensor.id}`).textContent = fmtValue(value, sensor.decimals);

      const rateCell = $(`#trate-${sensor.id}`);
      rateCell.textContent = rate.text;
      rateCell.dataset.dir = rate.dir;

      $(`#tmin-${sensor.id}`).textContent = fmtValue(stats.min, sensor.decimals);
      $(`#tmax-${sensor.id}`).textContent = fmtValue(stats.max, sensor.decimals);
      drawSpark(sensor, status);
    }
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
  for (const sensor of rendered) {
    const offset = bus.tare(sensor.id);
    const tareable = offset !== null;
    const tared = tareable && offset !== 0;

    const btn = $(`#tb-${sensor.id}`);
    if (btn) {
      btn.classList.toggle('hidden', !tareable);
      btn.classList.toggle('on', tared);
      const shown = tared
        ? `${offset > 0 ? '−' : '+'}${fmtValue(Math.abs(offset), sensor.decimals)}`
        : 'TARE';
      if (btn.textContent !== shown) btn.textContent = shown;
      // The sign on the button is the shift applied to what you see, so the
      // wording has to match it: a negative offset ADDS to the reading.
      btn.title = tared
        ? `${fmtValue(Math.abs(offset), sensor.decimals)} ${sensor.units} is being `
          + `${offset > 0 ? 'subtracted from' : 'added to'} ${sensor.id}.\n`
          + 'Click to re-zero at the current reading.'
        : `Zero ${sensor.id} against its current reading`;
    }
    $(`#tx-${sensor.id}`)?.classList.toggle('hidden', !tared);
  }

  for (const group of renderedGroups) {
    const anyTared = group.sensors.some((s) => (bus.tare(s.id) ?? 0) !== 0);
    $(`#untare-group-${group.id}`)?.classList.toggle('hidden', !anyTared);
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

function drawSpark(sensor, status) {
  const alarm = status === 'danger' || status === 'warn';
  // The table rows are short: no midline there, just the trace.
  const inTable = mode !== 'cards';
  drawTrace(sparks.get(sensor.id), bus.history.get(sensor.id), windowSeconds, {
    color: statusColor(status),
    fill: alarm,
    grid: inTable ? null : cssVar('--border', '#232326'),
  });
}

// ------------------------------------------------------------------ prefs --

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

build();
void icon;
