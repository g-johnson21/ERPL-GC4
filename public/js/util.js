/* util.js — DOM helpers, formatting, icons, toasts, confirm dialogs. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * el('div.foo#bar', {attrs}, ...children)
 *
 * Tag, classes and id may appear in any order — 'span.clock#id' and
 * 'span#id.clock' are equivalent. Tag defaults to div.
 */
export function el(spec, attrs = {}, ...children) {
  const tagMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(spec);
  const tag = tagMatch ? tagMatch[0] : 'div';
  const classes = [];
  let id = null;
  for (const [, sigil, name] of spec.slice(tag.length).matchAll(/([#.])([^#.]+)/g)) {
    if (sigil === '#') id = name;
    else classes.push(name);
  }

  const node = document.createElement(tag);
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className += ' ' + v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    // A `value` attribute does nothing on a textarea (its content is a child
    // text node) so set the property instead. Same path for input keeps the
    // two consistent. <option value> stays an attribute, which is correct.
    else if (k === 'value' && (tag === 'textarea' || tag === 'input')) node.value = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        // Custom properties must go through setProperty; plain assignment
        // to node.style['--x'] is silently ignored.
        if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
        else node.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ------------------------------------------------------------- formatting --

export function fmtValue(v, decimals = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '––––';
  return v.toFixed(decimals);
}

/**
 * Rate of change, as it appears beside a reading: `▲ 12.4 psi/s`.
 *
 * Returns { text, dir } where dir is 'up' | 'down' | 'flat'. "Flat" is not
 * zero — it is anything inside a small band of the sensor's own span, because
 * a least-squares slope on a noisy transducer never sits exactly at zero and
 * an arrow that flickers between ▲ and ▼ on a still tank is worse than none.
 *
 * `compact` drops the unit name and leaves `▲ 12.4/s`, for places where the
 * units are already printed on the same line and repeating them would push
 * the number out of the box.
 */
export function fmtRate(rate, sensor, { compact = false } = {}) {
  const per = compact ? '/s' : ` ${sensor.units}/s`;
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return { text: `––${per}`, dir: 'flat' };
  }
  const span = Math.abs((sensor.max ?? 1) - (sensor.min ?? 0)) || 1;
  const deadband = span * 0.0005;                 // 0.05 % of full scale per second
  const dir = rate > deadband ? 'up' : rate < -deadband ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '–';
  const magnitude = Math.abs(rate).toFixed(sensor.decimals ?? 1);
  return { text: `${arrow} ${magnitude}${per}`, dir };
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtClock(ms) {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

export function fmtTimeMs(ms) {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// ------------------------------------------------------------------ icons --

const ICON_PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  schematic: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V15a3 3 0 0 0 3 3h6.5"/><path d="M8.5 6H15a3 3 0 0 1 3 3v6.5"/>',
  gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M13.4 10.6 19 5"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.7-1.4"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  record: '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  warning: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17.5v.5"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
};

export function icon(name, size = 16) {
  const path = ICON_PATHS[name] || ICON_PATHS.grid;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// ----------------------------------------------------------------- toasts --

let toastStack = null;
export function toast(message, kind = 'info', ms = 4200) {
  if (!toastStack) {
    toastStack = el('div.toast-stack');
    document.body.append(toastStack);
  }
  const node = el(`div.toast.${kind}`, { text: message });
  toastStack.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, ms);
  return node;
}

// ---------------------------------------------------------------- confirm --

/** Returns a Promise<boolean>. Escape / backdrop click cancels. */
export function confirmAction({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const done = (v) => { backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };

    const confirmBtn = el('button.btn', { class: danger ? 'danger' : 'accent', text: confirmLabel, onclick: () => done(true) });
    const backdrop = el('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) done(false); } },
      el('div.modal', {},
        el('h2', { text: title }),
        el('p', { text: message }),
        el('div.modal-actions', {},
          el('button.btn.ghost', { text: 'Cancel', onclick: () => done(false) }),
          confirmBtn
        )
      )
    );

    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    confirmBtn.focus();
  });
}

// ------------------------------------------------------------------ misc --

/**
 * Widest reading a sensor can produce, in characters.
 *
 * Readouts are monospaced, so reserving this many `ch` stops a card or table
 * cell from resizing as the value swings — 4497 -> -297.7 -> 15 must not shove
 * the units label or the neighbouring columns around during a test.
 */
export function valueWidthCh(sensor) {
  const decimals = sensor.decimals ?? 1;
  const bounds = [sensor.min, sensor.max, sensor.dangerLow, sensor.dangerHigh, sensor.warnLow, sensor.warnHigh]
    .filter((v) => Number.isFinite(v));
  const widest = bounds.length
    ? Math.max(...bounds.map((v) => Number(v).toFixed(decimals).length))
    : decimals + 4;
  return Math.max(4, widest);
}

/** Normalize a value into 0..1 across a sensor's configured range. */
export function normalize(v, min, max) {
  if (!Number.isFinite(v) || max === min) return 0;
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
