/* spark.js — one way to turn a rolling sensor history into a trace.
 *
 * Every trend on the station reads through here: the Data page's card
 * sparklines, the telemetry table's inline trends, the value tiles pinned to
 * the P&ID, and the P&ID hover card. They share the slicing and decimation so
 * a 5-minute window at 50 Hz (15,000 samples) costs the same to draw as a
 * 10-second one: the window is found by binary search, and the samples inside
 * it are folded into at most one min/max pair per horizontal pixel.
 *
 * Min/max rather than averaging or striding, because the trace has to keep
 * the spike. A 30 ms pressure transient is exactly the thing an operator is
 * looking at a trend to catch, and a stride of 12 samples steps right over it.
 */

/** The time-window chips offered wherever a trace can be re-scaled. */
export const WINDOWS = [
  { s: 10, label: '10s' },
  { s: 30, label: '30s' },
  { s: 60, label: '1m' },
  { s: 120, label: '2m' },
  { s: 300, label: '5m' },
];

/** The longest window above; the history buffer is sized to hold it. */
export const MAX_WINDOW_S = Math.max(...WINDOWS.map((w) => w.s));

/** Index of the first sample at or after `t` (binary search; `t` is sorted). */
function firstAtOrAfter(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The last `seconds` of a series, decimated to at most `buckets` min/max
 * pairs. Returns null when there is not enough to draw a line.
 *
 * The time axis is anchored to `now` rather than to the newest sample, so a
 * channel that has stopped reporting visibly stops short of the right edge
 * instead of stretching its last reading across the whole window.
 */
export function windowed(series, seconds, buckets, now = Date.now()) {
  if (!series || series.t.length < 2) return null;
  const t0 = now - seconds * 1000;
  const start = Math.max(0, firstAtOrAfter(series.t, t0) - 1);
  const n = series.t.length - start;
  if (n < 2) return null;

  const pts = [];
  let lo = Infinity, hi = -Infinity;
  const nb = Math.max(1, Math.floor(buckets));
  const span = seconds * 1000;

  if (n <= nb * 2) {
    for (let i = start; i < series.t.length; i++) {
      const v = series.v[i];
      pts.push([(series.t[i] - t0) / span, v]);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  } else {
    // One bucket per slice of time. Emitting the min and the max in the order
    // they occurred keeps a rising edge rising.
    let b = -1, bMin, bMax, tMin, tMax;
    const flush = () => {
      if (b < 0) return;
      if (tMin <= tMax) { pts.push([tMin, bMin], [tMax, bMax]); } else { pts.push([tMax, bMax], [tMin, bMin]); }
    };
    for (let i = start; i < series.t.length; i++) {
      const x = (series.t[i] - t0) / span;
      const v = series.v[i];
      const bi = Math.min(nb - 1, Math.max(0, Math.floor(x * nb)));
      if (bi !== b) {
        flush();
        b = bi; bMin = bMax = v; tMin = tMax = x;
      } else {
        if (v < bMin) { bMin = v; tMin = x; }
        if (v > bMax) { bMax = v; tMax = x; }
      }
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    flush();
  }
  return pts.length >= 2 ? { pts, lo, hi } : null;
}

/**
 * Vertical range for a window: the data, padded, with a floor so a flat
 * channel reads as a flat line and not as amplified noise.
 */
export function yRange(lo, hi) {
  const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.005, 0.5);
  return { lo: lo - pad, hi: hi + pad };
}

/**
 * SVG path data for a trace inside a w×h box whose top-left is (x, y).
 * Used by the P&ID tiles, which live inside the drawing's own SVG.
 */
export function tracePath(series, seconds, w, h, x = 0, y = 0, now = Date.now()) {
  const win = windowed(series, seconds, Math.max(8, w / 1.5), now);
  if (!win) return '';
  const { lo, hi } = yRange(win.lo, win.hi);
  const span = hi - lo || 1;
  let d = '';
  for (let i = 0; i < win.pts.length; i++) {
    const [fx, v] = win.pts[i];
    const px = x + Math.max(0, fx) * w;
    const py = y + h - ((v - lo) / span) * h;
    d += `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
  }
  return d;
}

/**
 * Draw a trace onto a canvas, sized to its CSS box at device resolution.
 *
 * options:
 *   color   stroke colour (a resolved CSS colour, not a var())
 *   fill    true to tint under the trace (reserved for out-of-limit channels)
 *   grid    colour for a single dashed midline, or null for none
 *   axis    colour for right-edge min/max labels, or null for none
 */
export function drawTrace(canvas, series, seconds, options = {}) {
  if (!canvas || !canvas.isConnected) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (options.grid) {
    ctx.strokeStyle = options.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h / 2) + 0.5);
    ctx.lineTo(w, Math.round(h / 2) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // With an axis, the trace gives up a gutter on the right for the labels
  // rather than having them printed over its newest samples.
  const pw = options.axis ? Math.max(10, w - 34) : w;
  const win = windowed(series, seconds, pw);
  if (!win) return;
  const { lo, hi } = yRange(win.lo, win.hi);
  const span = hi - lo || 1;
  const px = (p) => Math.max(0, p[0]) * pw;
  const py = (p) => h - ((p[1] - lo) / span) * h;
  const color = options.color || '#818cf8';

  if (options.fill) {
    ctx.beginPath();
    ctx.moveTo(px(win.pts[0]), py(win.pts[0]));
    for (const p of win.pts) ctx.lineTo(px(p), py(p));
    ctx.lineTo(px(win.pts[win.pts.length - 1]), h);
    ctx.lineTo(px(win.pts[0]), h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, withAlpha(color, 0.22));
    g.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = g;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(px(win.pts[0]), py(win.pts[0]));
  for (const p of win.pts) ctx.lineTo(px(p), py(p));
  ctx.strokeStyle = color;
  ctx.lineWidth = options.lineWidth ?? 1;
  ctx.lineJoin = 'round';
  ctx.stroke();

  if (options.axis) {
    ctx.font = '9px "JetBrains Mono", "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = options.axis;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(fmtAxis(hi), w, 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmtAxis(lo), w, h - 1);
  }
}

function fmtAxis(v) {
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** Resolve a CSS custom property on :root to its current value. */
export function cssVar(name, fallback = '') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Trace colour for a channel status: quiet ink when nominal, signal otherwise. */
export function statusColor(status) {
  if (status === 'danger') return cssVar('--danger', '#ef4444');
  if (status === 'warn') return cssVar('--warn', '#f59e0b');
  return cssVar('--spark', '#818cf8');
}

function withAlpha(color, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * Build a row of window chips. `onPick(seconds)` fires on change; the chip
 * for `current` starts active. Returns the element.
 */
export function windowChips(el, current, onPick, title = 'Trend window') {
  const row = el('div.win-chips', { role: 'group', 'aria-label': title, title });
  for (const w of WINDOWS) {
    row.append(el('button', {
      type: 'button',
      class: w.s === current ? 'active' : '',
      dataset: { s: String(w.s) },
      text: w.label,
      onclick: (e) => {
        for (const b of row.children) b.classList.toggle('active', b === e.currentTarget);
        onPick(w.s);
      },
    }));
  }
  return row;
}
