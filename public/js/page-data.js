/* page-data.js — all instrumentation in a grid, plus a dense table view. */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { $, el, clear, icon, fmtValue, normalize, valueWidthCh } from './util.js';

const content = await bootPage('data', { sidebar: false });

const KIND_LABELS = {
  pressure: 'Pressure Transducers',
  temperature: 'Thermocouples',
  force: 'Load Cells',
  flow: 'Flow Meters',
  level: 'Level Sensors',
  voltage: 'Voltage Channels',
  other: 'Other Channels',
};

let mode = loadPref('gc4-data-mode', 'cards');
let windowSeconds = Number(loadPref('gc4-data-window', '60'));

// ------------------------------------------------------------------ shell --

content.append(
  el('div.page-head', {},
    el('h1', { text: 'Data' }),
    el('span.sub#data-sub', { text: `${bus.config.sensors.length} channels @ ${bus.config.telemetry.streamRateHz} Hz` }),
    el('div', { style: { marginLeft: 'auto', display: 'flex', gap: '10px', alignItems: 'center' } },
      el('label.field', { style: { margin: 0 }, text: 'Window' }),
      el('select', {
        style: { width: 'auto' },
        onchange: (e) => { windowSeconds = Number(e.target.value); savePref('gc4-data-window', e.target.value); },
      },
        [15, 30, 60, 120].map((s) =>
          el('option', { value: s, selected: s === windowSeconds ? '' : null, text: `${s}s` })
        )
      ),
      el('div.seg', {},
        el('button', { id: 'mode-cards', class: mode === 'cards' ? 'active' : '', text: 'Cards', onclick: () => setMode('cards') }),
        el('button', { id: 'mode-table', class: mode === 'table' ? 'active' : '', text: 'Table', onclick: () => setMode('table') })
      )
    )
  ),
  el('div#data-body')
);

function setMode(next) {
  mode = next;
  savePref('gc4-data-mode', next);
  $('#mode-cards').classList.toggle('active', next === 'cards');
  $('#mode-table').classList.toggle('active', next === 'table');
  build();
}

// ------------------------------------------------------------------ build --

const sparks = new Map(); // sensorId -> canvas

function build() {
  const host = $('#data-body');
  clear(host);
  sparks.clear();
  if (mode === 'cards') buildCards(host);
  else buildTable(host);
  update();
}

function groupedSensors() {
  const kinds = [...new Set(bus.config.sensors.map((s) => s.kind))];
  const order = ['pressure', 'temperature', 'force', 'flow', 'level', 'voltage', 'other'];
  kinds.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return kinds.map((kind) => ({
    kind,
    label: KIND_LABELS[kind] || kind,
    sensors: bus.config.sensors.filter((s) => s.kind === kind),
  }));
}

function buildCards(host) {
  for (const group of groupedSensors()) {
    host.append(
      el('div.group-head', {}, group.label,
        el('span.faint', { style: { textTransform: 'none', letterSpacing: 0 }, text: `${group.sensors.length}` })
      ),
      el('div.sensor-grid', { style: { '--scols': String(bus.config.ui.sensorGridColumns) } },
        group.sensors.map(sensorCard)
      )
    );
  }
}

function sensorCard(sensor) {
  const canvas = el('canvas.s-spark', { id: `spark-${sensor.id}` });
  sparks.set(sensor.id, canvas);
  const w = valueWidthCh(sensor);

  return el('div.sensor-card', { id: `sc-${sensor.id}`, dataset: { status: 'stale' } },
    el('div.s-top', {},
      el('span.s-id', { text: sensor.id }),
      el('span.s-status')
    ),
    el('div.s-name', { text: sensor.name, title: sensor.name }),
    el('div.s-value', {},
      // Width reserved for the widest reading in range, so the units label
      // and the card never shift as digits come and go.
      el('span.s-num', { id: `sv-${sensor.id}`, style: { minWidth: `${w}ch` }, text: '––––' }),
      el('span.s-units', { text: sensor.units })
    ),
    canvas,
    el('div.s-bar', {}, el('i', { id: `sb-${sensor.id}`, style: { width: '0%' } })),
    el('div.rec-stats', { style: { marginTop: '4px' } },
      el('span.stat-slot', { id: `smin-${sensor.id}`, style: { minWidth: `${w + 5}ch` }, text: 'min ––' }),
      el('span.stat-slot', { id: `smax-${sensor.id}`, style: { minWidth: `${w + 5}ch` }, text: 'max ––' }),
      el('span', { style: { marginLeft: 'auto' }, text: `ch ${sensor.channel}` })
    )
  );
}

function buildTable(host) {
  const wrap = el('div.table-wrap');
  // Fixed layout: with `auto`, every column re-measures as readings change and
  // the whole table twitches at 20 Hz.
  const table = el('table.data-table.fixed');

  const widths = ['96px', '20%', '96px', '120px', '64px', '104px', '104px', '132px', '52px', '92px'];
  const cols = el('colgroup');
  for (const w of widths) cols.append(el('col', { style: { width: w } }));
  table.append(cols);

  table.append(el('thead', {}, el('tr', {},
    ['Tag', 'Description', 'Type', 'Value', 'Units', 'Min', 'Max', 'Range', 'Ch', 'Status'].map((h) =>
      el('th', { text: h, class: ['Value', 'Min', 'Max', 'Ch'].includes(h) ? 'num' : '' })
    )
  )));

  const tbody = el('tbody');
  for (const group of groupedSensors()) {
    tbody.append(el('tr', {},
      el('td', {
        colspan: 10,
        style: { background: 'var(--surface-2)', fontWeight: '700', fontSize: '10.5px', letterSpacing: '.07em', textTransform: 'uppercase' },
        text: group.label,
      })
    ));
    for (const s of group.sensors) {
      tbody.append(el('tr', { id: `tr-${s.id}` },
        el('td.mono', { style: { fontWeight: '700' }, text: s.id }),
        el('td', { text: s.name }),
        el('td.muted', { text: s.kind }),
        el('td.num', { id: `tv-${s.id}`, text: '––––' }),
        el('td.muted', { text: s.units }),
        el('td.num.muted', { id: `tmin-${s.id}`, text: '––' }),
        el('td.num.muted', { id: `tmax-${s.id}`, text: '––' }),
        el('td.mono.muted', { text: `${s.min} … ${s.max}` }),
        el('td.num.muted', { text: s.channel }),
        el('td', { id: `ts-${s.id}`, text: '–' })
      ));
    }
  }
  table.append(tbody);
  wrap.append(table);
  host.append(wrap);
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

  for (const sensor of bus.config.sensors) {
    const value = bus.reading(sensor.id);
    const status = bus.sensorStatus(sensor.id);
    const stats = windowStats(sensor.id, windowSeconds);

    if (mode === 'cards') {
      const card = $(`#sc-${sensor.id}`);
      if (!card) continue;
      card.dataset.status = status;
      $(`#sv-${sensor.id}`).textContent = fmtValue(value, sensor.decimals);
      $(`#sb-${sensor.id}`).style.width = `${normalize(value, sensor.min, sensor.max) * 100}%`;
      $(`#smin-${sensor.id}`).textContent = `min ${fmtValue(stats.min, sensor.decimals)}`;
      $(`#smax-${sensor.id}`).textContent = `max ${fmtValue(stats.max, sensor.decimals)}`;
      drawSpark(sensor, status);
    } else {
      const cell = $(`#tv-${sensor.id}`);
      if (!cell) continue;
      cell.textContent = fmtValue(value, sensor.decimals);
      cell.className = `num st-${status}`;
      $(`#tmin-${sensor.id}`).textContent = fmtValue(stats.min, sensor.decimals);
      $(`#tmax-${sensor.id}`).textContent = fmtValue(stats.max, sensor.decimals);
      const st = $(`#ts-${sensor.id}`);
      st.textContent = status.toUpperCase();
      st.className = `st-${status}`;
    }
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
  const canvas = sparks.get(sensor.id);
  if (!canvas || !canvas.isConnected) return;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const series = bus.history.get(sensor.id);
  if (!series || series.v.length < 2) return;

  const cutoff = Date.now() - windowSeconds * 1000;
  let start = series.t.findIndex((t) => t >= cutoff);
  if (start < 0) start = Math.max(0, series.t.length - 2);
  const times = series.t.slice(start);
  const values = series.v.slice(start);
  if (values.length < 2) return;

  // Autoscale to the window, with a floor so a flat line does not look noisy.
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.005, 0.5);
  lo -= pad; hi += pad;
  const span = hi - lo || 1;

  const t0 = times[0], t1 = times[times.length - 1];
  const tSpan = t1 - t0 || 1;
  const px = (i) => ((times[i] - t0) / tSpan) * w;
  const py = (i) => h - ((values[i] - lo) / span) * h;

  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(status === 'danger' ? '--danger' : status === 'warn' ? '--warn' : '--ok').trim() || '#4ade80';

  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  for (let i = 1; i < values.length; i++) ctx.lineTo(px(i), py(i));

  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, hexWithAlpha(color, 0.28));
  fill.addColorStop(1, hexWithAlpha(color, 0));
  ctx.save();
  ctx.lineTo(px(values.length - 1), h);
  ctx.lineTo(px(0), h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  for (let i = 1; i < values.length; i++) ctx.lineTo(px(i), py(i));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function hexWithAlpha(color, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
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
