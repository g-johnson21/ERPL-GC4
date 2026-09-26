/* page-config.js — configuration editor.
 *
 * Four tabs:
 *   Autosequences — swimlane timeline editor (seq-editor.js).
 *   Alerts        — minor/major bounds for every PT, applied live.
 *   General       — the settings that get changed most often.
 *   Advanced      — raw JSON, for everything else (P&ID layout, calibrations).
 *
 * All three edit one in-memory `draft`. Saving validates server-side, backs up
 * the current file, writes it, and hot-reloads every connected browser.
 */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { $, el, clear, icon, toast, confirmAction, debounce } from './util.js';
import { createSequenceEditor } from './seq-editor.js';

const content = await bootPage('config', { sidebar: false });

let draft = structuredClone(bus.config);
let dirty = false;
let activeTab = 'sequences';
/** The server's last verdict on the draft: { ok, errors, changed, inPlace }. */
let lastValidation = null;
const seqEditor = createSequenceEditor({
  getDraft: () => draft,
  markDirty: () => markDirty(),
  isDirty: () => dirty,
  onListChange: () => renderTabs(),
});

// ============================================================== SHELL =====

// The action bar and tabs stay pinned to the top of the scroll area. Editing a
// long sequence pushes the page well past a screen, and the Validate / Save
// buttons must never scroll out of reach.
content.classList.add('config-page');
content.append(
  el('div.config-sticky#cfg-sticky', {},
    el('div.page-head', {},
      el('h1', { text: 'Configuration' }),
      el('span.sub#cfg-sub', { text: 'config/stand.json' }),
      el('div#cfg-actions', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' } },
        el('span.chip.warn.hidden#dirty-chip', {}, el('span.dot'), 'Unsaved changes'),
        el('div.config-status-wrap', {},
          el('button.chip.config-status#cfg-status', {
            type: 'button',
            title: 'Loaded.',
            onclick: () => $('#cfg-status-pop')?.classList.toggle('hidden'),
          }, el('span.dot'), el('span#cfg-status-text', { text: 'Loaded' })),
          el('div.config-status-pop.hidden#cfg-status-pop')
        ),
        el('button.btn', { text: 'Validate', onclick: () => validate(true) }),
        el('button.btn', { html: `${icon('refresh', 14)} Revert`, onclick: revert }),
        el('button.btn.accent', { title: 'Save and apply (Ctrl+S)', html: `${icon('save', 14)} Save & Apply`, onclick: save })
      )
    ),
    el('div.tabs#cfg-tabs')
  ),
  el('div#cfg-panel')
);

// Keep the sequence picker pinned just below the bar, whatever height it is.
const stickyBar = $('#cfg-sticky');
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    content.style.setProperty('--cfg-sticky-h', `${stickyBar.offsetHeight}px`);
  }).observe(stickyBar);
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

function renderTabs() {
  const host = $('#cfg-tabs');
  clear(host);
  const tabs = [
    ['sequences', `Autosequences (${draft.autosequences?.length ?? 0})`],
    ['alerts', 'Alerts'],
    ['general', 'General'],
    ['json', 'Advanced (JSON)'],
  ];
  for (const [id, label] of tabs) {
    host.append(el('button.tab', {
      class: id === activeTab ? 'active' : '',
      text: label,
      onclick: () => switchTab(id),
    }));
  }
}

function switchTab(id) {
  // The JSON tab is authoritative while it is open; adopt its text on the
  // way out so edits made there are not silently discarded.
  if (activeTab === 'json' && id !== 'json') {
    const parsed = parseEditor();
    if (!parsed.ok) {
      toast('Fix the JSON before leaving this tab', 'error');
      return;
    }
    draft = parsed.value;
    seqEditor.reset();
  }
  activeTab = id;
  render();
}

function render() {
  renderTabs();
  const panel = $('#cfg-panel');
  clear(panel);
  content.classList.toggle('seq-tab', activeTab === 'sequences');
  if (activeTab === 'sequences') seqEditor.mount(panel);
  else if (activeTab === 'alerts') panel.append(alertsTab());
  else if (activeTab === 'general') panel.append(generalTab());
  else panel.append(jsonTab());
}

function markDirty() {
  dirty = true;
  $('#dirty-chip')?.classList.remove('hidden');
}

// ============================================================ GENERAL =====

function generalTab() {
  const ui = draft.ui ??= {};
  const rec = draft.recording ??= {};
  const tel = draft.telemetry ??= {};
  const safety = draft.safety ??= {};
  const meta = draft.meta ??= {};
  const tankLevel = ui.tankLevel ??= {};
  const set = (fn) => (v) => { fn(v); markDirty(); };

  // Grouped by what an operator is deciding, not by where the key lives in
  // the file: one question per row, the answer in a narrow column on the right.
  return el('div.settings', {},
    el('p.settings-intro', { text: 'The settings that change most often. Valves, sensors, calibrations and the P&ID layout are on the Advanced tab.' }),
    el('div.settings-grid', {},
      settingsGroup('Station', [
        textRow('Stand name', 'Shown in the header and on the login screen.',
          meta.standName, set((v) => { meta.standName = v; })),
        segRow('Default theme', 'What a station opens in. Each station can still switch from the header.',
          [{ value: 'dark', label: 'DARK' }, { value: 'light', label: 'LIGHT' }],
          ui.defaultTheme || 'dark', set((v) => { ui.defaultTheme = v; })),
        colorRow('Accent colour', 'The signal colour: focus, selection, the running sequence.',
          ui.accent, set((v) => { ui.accent = v; })),
        numberRow('Valve grid columns', 'Actuator cards per row on the Control Grid.',
          ui.gridColumns, set((v) => { ui.gridColumns = v; }), { min: 1, max: 8 }),
      ]),
      settingsGroup('Safety', [
        toggleRow('Require ARM to actuate', 'Valves marked "requires ARM" only move while the stand is armed.',
          safety.requireArmToActuate !== false, set((v) => { safety.requireArmToActuate = v; })),
        toggleRow('Hold SHIFT to open a valve', 'A stray click cannot drive the stand away from safe.',
          ui.requireShiftToActuate !== false, set((v) => { ui.requireShiftToActuate = v; })),
        textRow('Control PIN', '4–12 digits. Blank runs the control port without a PIN.',
          safety.controlPin, set((v) => { safety.controlPin = v.trim(); }), { mono: true, placeholder: 'none' }),
      ]),
      settingsGroup('Rates', [
        numberRow('Control loop', 'How often the server samples, regulates and steps sequences.',
          tel.sampleRateHz, set((v) => { tel.sampleRateHz = v; }), { min: 1, max: 500, unit: 'Hz' }),
        numberRow('Browser stream', 'How often every connected screen is updated.',
          tel.streamRateHz, set((v) => { tel.streamRateHz = v; }), { min: 1, max: 60, unit: 'Hz' }),
        numberRow('CSV rate', 'Rows per second written to the log file.',
          rec.rateHz, set((v) => { rec.rateHz = v; }), { min: 1, max: 500, unit: 'Hz' }),
      ]),
      settingsGroup('Recording', [
        textRow('Recording directory', 'Where log files are written, on the server.',
          rec.directory, set((v) => { rec.directory = v; }), { mono: true, wide: true }),
        textRow('Default test name', 'Pre-filled when a new log file is started.',
          rec.defaultTestName, set((v) => { rec.defaultTestName = v; }), { wide: true }),
      ]),
      settingsGroup('Tank level', [
        toggleRow('Show fill level on the P&ID', 'Draw the liquid level inside the run tanks.',
          tankLevel.enabled !== false, set((v) => { tankLevel.enabled = v; })),
        numberRow('Tank height', 'The column a full tank stands in.',
          tankLevel.heightIn ?? 70, set((v) => { tankLevel.heightIn = v; }), { min: 1, max: 500, unit: 'in' }),
        numberRow('Level smoothing', 'Averaging time for the level reading. 0 = raw.',
          tankLevel.smoothingSeconds ?? 5, set((v) => { tankLevel.smoothingSeconds = v; }), { min: 0, max: 120, unit: 's' }),
      ])
    )
  );
}

// ============================================================= ALERTS =====

/**
 * Minor and major bounds for every PT, as one table, so retuning an alert
 * between attempts is a few keystrokes and Ctrl+S.
 *
 * The bounds ARE each sensor's warnLow/warnHigh/dangerLow/dangerHigh — the same ones that
 * colour its tile on the P&ID and its card on the Data page — not a second
 * set kept beside them. A save that changes nothing else applies live: no
 * station reloads, and it skips the reload warning (see save()).
 *
 * Columns run low to high, the way the number line does, so a bound in the
 * wrong order is visibly out of place before the validator says so. The Now
 * column is coloured against the DRAFT bounds: it previews what would alert
 * if this were saved.
 */
const ALERT_COLS = [
  ['dangerLow', 'Major low'],
  ['warnLow', 'Minor low'],
  ['warnHigh', 'Minor high'],
  ['dangerHigh', 'Major high'],
];

function alertsTab() {
  const alerts = draft.alerts ??= {};
  const set = (fn) => (v) => { fn(v); markDirty(); };

  const rows = [];
  const groups = new Map((draft.sensorGroups || []).map((g) => [g.id, g]));
  for (const s of draft.sensors || []) {
    if (s.kind !== 'pressure') continue;
    rows.push({ target: s, id: s.id, tag: s.pid?.tag, name: s.name, group: groups.get(s.group), board: false });
  }
  for (const b of draft.bangbang || []) {
    const bs = b.boardSensor;
    if (!bs?.id) continue;
    rows.push({ target: bs, id: bs.id, tag: null, name: bs.name || `${b.abbrev || b.id} board PT`, group: groups.get(bs.group), board: true, units: bs.units });
  }

  const body = el('tbody');
  for (const r of rows) body.append(alertRow(r));

  return el('div.settings.alerts-settings', {},
    el('p.settings-intro', {
      text: 'Minor bounds raise a yellow alert and major bounds a flashing red one, in the tray at the bottom of '
        + 'the control screens. Leave a box blank for no bound. A save that only changes these applies live — '
        + 'no station reloads.',
    }),
    el('div.settings-grid', {},
      settingsGroup('Alert tray', [
        toggleRow('Raise alerts', 'Off hides the tray on every station. The bounds still colour the readings.',
          alerts.enabled !== false, set((v) => { alerts.enabled = v; })),
        toggleRow('Tone for major alerts', 'A repeating chirp while a major alert is showing and not muted.',
          alerts.sound !== false, set((v) => { alerts.sound = v; })),
      ])
    ),
    el('div.alert-table-wrap', {},
      el('table.alert-table', {},
        el('thead', {}, el('tr', {},
          el('th', { text: 'PT' }),
          el('th', { text: 'Name' }),
          el('th.num', { text: 'Range' }),
          el('th.num', { text: 'Now' }),
          ALERT_COLS.map(([k, label]) => el('th.num', { class: k.startsWith('danger') ? 'major' : 'minor', text: label }))
        )),
        body
      )
    ),
    rows.length ? null : el('p.settings-intro', { text: 'This stand has no pressure sensors.' }),
    valveAlertsSection(alerts)
  );
}

// ------------------------------------------------------ valve alert rules --

/**
 * Custom valve alerts: "raise a MAJOR alert when LOX Vent has been OPEN for
 * more than 2 minutes". One row per rule; several rules on the same valve and
 * state become one alert in the tray that escalates as each comes due, so a
 * minor at 60 s and a major at 300 s is two rows here and one row there.
 *
 * The limit is typed as m:ss or plain seconds, the way a timer is.
 */
const VALVE_STATES = [['open', 'Open'], ['closed', 'Closed'], ['bb', 'Under bang-bang']];

function valveAlertsSection(alerts) {
  alerts.valves ??= [];
  const body = el('tbody');
  const redraw = () => {
    clear(body);
    alerts.valves.forEach((rule, i) => body.append(valveAlertRow(alerts, rule, i, redraw)));
    if (!alerts.valves.length) {
      body.append(el('tr', {}, el('td.faint', { colspan: 7, text: 'No valve alerts yet.' })));
    }
  };
  redraw();

  return el('section.valve-alerts', {},
    el('h3.eyebrow', { text: 'Valve alerts' }),
    el('p.settings-intro', {
      text: 'Raise an alert when a valve has been in a state longer than you set — a vent left open, a fill left '
        + 'running, bang-bang on longer than a press should take. Measured from when the valve last changed '
        + 'position, on the server\'s clock. Applies live, like the PT bounds.',
    }),
    el('div.alert-table-wrap', {},
      el('table.alert-table.valve-alert-table', {},
        el('thead', {}, el('tr', {},
          el('th', { text: 'Valve' }),
          el('th', { text: 'When it is' }),
          el('th.num', { text: 'For longer than' }),
          el('th', { text: 'Level' }),
          el('th', { text: 'Message (optional)' }),
          el('th', { text: 'On' }),
          el('th', { text: '' })
        )),
        body
      )
    ),
    el('button.btn.sm', {
      style: { marginTop: '10px' },
      text: '+ Add valve alert',
      onclick: () => {
        const first = draft.valves?.[0];
        if (!first) { toast('This stand has no valves', 'error'); return; }
        alerts.valves.push({ valve: first.id, state: 'open', afterSeconds: 60, level: 'minor' });
        markDirty();
        redraw();
        body.lastElementChild?.querySelector('select')?.focus();
      },
    })
  );
}

function valveAlertRow(alerts, rule, index, redraw) {
  const change = (fn) => (e) => { fn(e.target); markDirty(); };

  const valve = el('select', { 'aria-label': 'Valve', onchange: change((t) => { rule.valve = t.value; }) },
    (draft.valves || []).map((v) => el('option', {
      value: v.id,
      text: `${(v.pid?.tag || v.id).replace(/\n/g, ' ')} — ${v.name}`,
      selected: v.id === rule.valve,
    })));
  // A rule left pointing at a valve that has since been removed keeps its
  // value on screen, so the validator's complaint names something visible.
  if (!(draft.valves || []).some((v) => v.id === rule.valve)) {
    valve.prepend(el('option', { value: rule.valve, text: `${rule.valve} (missing)`, selected: true }));
  }

  const state = el('select', { 'aria-label': 'State', onchange: change((t) => { rule.state = t.value; }) },
    VALVE_STATES.map(([v, label]) => el('option', { value: v, text: label, selected: v === rule.state })));

  const after = el('input.mono', {
    type: 'text',
    value: fmtLimit(rule.afterSeconds),
    placeholder: 'm:ss',
    'aria-label': 'Longer than (m:ss or seconds)',
    oninput: (e) => {
      const secs = parseLimit(e.target.value);
      e.target.classList.toggle('invalid', secs === null);
      if (secs === null) return;
      rule.afterSeconds = secs;
      markDirty();
    },
    onchange: (e) => {
      if (parseLimit(e.target.value) !== null) e.target.value = fmtLimit(rule.afterSeconds);
    },
  });

  const level = el('select', {
    'aria-label': 'Level',
    class: `level-${rule.level || 'minor'}`,
    onchange: change((t) => { rule.level = t.value; t.className = `level-${t.value}`; }),
  },
    el('option', { value: 'minor', text: 'Minor', selected: rule.level !== 'major' }),
    el('option', { value: 'major', text: 'Major', selected: rule.level === 'major' }));

  const message = el('input', {
    type: 'text', value: rule.message || '', placeholder: 'e.g. close it before loading',
    'aria-label': 'Message',
    oninput: change((t) => { if (t.value.trim()) rule.message = t.value; else delete rule.message; }),
  });

  const on = el('input', {
    type: 'checkbox', checked: rule.enabled !== false, 'aria-label': 'Enabled',
    onchange: change((t) => { if (t.checked) delete rule.enabled; else rule.enabled = false; }),
  });

  return el('tr', {},
    el('td', {}, valve),
    el('td', {}, state),
    el('td.num', {}, after),
    el('td', {}, level),
    el('td', {}, message),
    el('td', {}, on),
    el('td', {}, el('button.alert-x.valve-alert-del', {
      text: '✕', title: 'Delete this alert', 'aria-label': 'Delete this alert',
      onclick: () => { alerts.valves.splice(index, 1); markDirty(); redraw(); },
    }))
  );
}

/** "2:30" / "150" / "1:02:00" -> seconds, or null. Blank is 0: as soon as it is. */
function parseLimit(text) {
  const t = String(text).trim();
  if (t === '') return 0;
  const parts = t.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) return null;
  return parts.map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

function fmtLimit(secs) {
  const s = Math.max(0, Number(secs) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = +(s % 60).toFixed(1);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function alertRow(r) {
  const s = r.target;
  const units = s.units || r.units || 'psi';
  const now = el('td.num.alert-now', { dataset: { sensorId: r.id } }, '––');
  const msg = el('div.alert-row-msg');
  const inputs = {};

  const check = () => {
    // Same nesting the server enforces (config-store.js checkAlertBounds),
    // shown on the row as it is typed rather than as a list after Save.
    const b = Object.fromEntries(ALERT_COLS.map(([k]) => [k, s[k]]).filter(([, v]) => Number.isFinite(v)));
    const bad = new Set();
    const problems = [];
    const need = (lo, hi, strict, text) => {
      if (b[lo] === undefined || b[hi] === undefined) return;
      if (strict ? b[lo] >= b[hi] : b[lo] > b[hi]) { bad.add(lo); bad.add(hi); problems.push(text); }
    };
    need('dangerLow', 'warnLow', false, 'major low is above minor low');
    need('warnHigh', 'dangerHigh', false, 'minor high is above major high');
    need('warnLow', 'warnHigh', true, 'minor low is not below minor high');
    need('dangerLow', 'dangerHigh', true, 'major low is not below major high');
    // Not an error, but an alert that can never fire is worth a word.
    const hints = [];
    for (const [k, label] of ALERT_COLS) {
      if (b[k] === undefined) continue;
      if (Number.isFinite(s.max) && k.endsWith('High') && b[k] > s.max) hints.push(`${label.toLowerCase()} is above the ${s.max} ${units} range`);
      if (Number.isFinite(s.min) && k.endsWith('Low') && b[k] < s.min) hints.push(`${label.toLowerCase()} is below the ${s.min} ${units} range`);
    }
    for (const [k, input] of Object.entries(inputs)) input.classList.toggle('invalid', bad.has(k));
    msg.textContent = [...problems, ...hints].join(' · ');
    msg.dataset.kind = problems.length ? 'error' : hints.length ? 'hint' : '';
    paintAlertNow(now, r);
  };

  const cells = ALERT_COLS.map(([k]) => {
    const input = el('input.mono', {
      type: 'number', step: 'any', placeholder: '—',
      value: Number.isFinite(s[k]) ? String(s[k]) : '',
      'aria-label': `${r.id} ${k}`,
      oninput: (e) => {
        const text = e.target.value.trim();
        if (text === '') s[k] = null;
        else if (Number.isFinite(e.target.valueAsNumber)) s[k] = e.target.valueAsNumber;
        else return;
        markDirty();
        check();
      },
    });
    inputs[k] = input;
    return el(`td.num.${k.startsWith('danger') ? 'major' : 'minor'}`, {}, input);
  });

  const tr = el('tr', { style: { '--group-color': r.group?.color || 'var(--border-strong)' } },
    el('td.alert-pt', {},
      el('span.alert-pt-tag', { text: (r.tag || r.id).replace(/\n/g, ' ') }),
      r.board ? el('span.alert-board', { text: 'BOARD', title: 'The bang-bang board\'s own transducer' }) : null),
    el('td', {}, el('div', { text: r.name || '' }), msg),
    el('td.num.faint', { text: Number.isFinite(s.min) && Number.isFinite(s.max) ? `${s.min}–${s.max} ${units}` : '' }),
    now,
    cells
  );
  queueMicrotask(check);
  return tr;
}

/** The live reading, coloured by what the DRAFT bounds would make of it. */
function paintAlertNow(cell, r) {
  const s = r.target;
  const v = bus.reading(r.id);
  cell.textContent = Number.isFinite(v) ? v.toFixed(s.decimals ?? 1) : '––';
  let level = '';
  if (Number.isFinite(v)) {
    if ((Number.isFinite(s.dangerHigh) && v >= s.dangerHigh) || (Number.isFinite(s.dangerLow) && v <= s.dangerLow)) level = 'major';
    else if ((Number.isFinite(s.warnHigh) && v >= s.warnHigh) || (Number.isFinite(s.warnLow) && v <= s.warnLow)) level = 'minor';
  }
  cell.dataset.level = level;
}

bus.on('state', () => {
  if (activeTab !== 'alerts') return;
  for (const cell of document.querySelectorAll('.alert-now')) {
    const id = cell.dataset.sensorId;
    const target = (draft.sensors || []).find((s) => s.id === id)
      || (draft.bangbang || []).map((b) => b.boardSensor).find((b) => b?.id === id);
    if (target) paintAlertNow(cell, { id, target });
  }
});

// =========================================================== JSON TAB =====

function jsonTab() {
  const card = el('div.card', {},
    el('h3', { text: 'Raw configuration' }),
    el('p', {}, 'Full JSON, including the P&ID layout and sensor calibrations. Edits here are picked up when you switch tabs or save.'),
    el('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } },
      el('button.btn.sm', { html: `${icon('download', 13)} Download`, onclick: download }),
      el('label.btn.sm', { style: { cursor: 'pointer' } }, 'Upload…',
        el('input', { type: 'file', accept: '.json', style: { display: 'none' }, onchange: upload })
      ),
      el('button.btn.sm.ghost', { text: 'Reload from disk', onclick: reloadFromDisk })
    ),
    el('textarea.config-editor#cfg-editor', {
      spellcheck: 'false',
      oninput: debounce(() => { markDirty(); validate(false); }, 500),
    })
  );
  queueMicrotask(() => { $('#cfg-editor').value = JSON.stringify(draft, null, 2); });
  return card;
}

function parseEditor() {
  const ta = $('#cfg-editor');
  if (!ta) return { ok: true, value: draft };
  try {
    return { ok: true, value: JSON.parse(ta.value) };
  } catch (err) {
    showStatus('error', 'Invalid JSON', [err.message]);
    return { ok: false, error: err.message };
  }
}

// ========================================================== VALIDATE ======

async function validate(verbose) {
  if (activeTab === 'json') {
    const parsed = parseEditor();
    if (!parsed.ok) return null;
    draft = parsed.value;
  }

  let res;
  try {
    res = await fetch('/api/config/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: draft }),
    }).then((r) => r.json());
  } catch (err) {
    showStatus('error', `Could not reach the server: ${err.message}`);
    lastValidation = null;
    return null;
  }

  lastValidation = res;
  if (res.ok) {
    showStatus('ok', `Valid — ${draft.valves.length} actuators, ${draft.sensors.length} sensors, ${draft.autosequences?.length ?? 0} sequences.`, [], 'Valid');
    if (verbose) toast('Configuration is valid', 'ok');
  } else {
    showStatus('error', `${res.errors.length} problem${res.errors.length === 1 ? '' : 's'} found`, res.errors);
  }
  return res.ok ? draft : null;
}

/**
 * The status is a chip in the action bar, not a full-width row: it only
 * needs to say "valid" or "N problems". The problems themselves open in a
 * dropdown under it (shown at once when there are any, since they block Save).
 */
function showStatus(kind, message, details = [], short = null) {
  const chip = $('#cfg-status');
  const pop = $('#cfg-status-pop');
  if (!chip || !pop) return;
  chip.className = `chip config-status ${kind === 'error' ? 'danger' : kind}`;
  chip.title = message;
  $('#cfg-status-text').textContent = short
    ?? (details.length ? `${details.length} problem${details.length === 1 ? '' : 's'}` : message.replace(/\.$/, ''));
  clear(pop);
  pop.append(el('div.config-status-msg', { text: message }));
  if (details.length) {
    pop.append(el('ul', {}, details.slice(0, 25).map((d) => el('li', { text: d }))));
    if (details.length > 25) pop.append(el('div', { text: `…and ${details.length - 25} more` }));
  }
  chip.classList.toggle('has-details', details.length > 0);
  pop.classList.toggle('hidden', details.length === 0);
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.config-status-wrap')) $('#cfg-status-pop')?.classList.add('hidden');
});

// ============================================================ ACTIONS =====

async function save() {
  if (bus.state?.sequence?.running) {
    toast('A sequence is running — wait for it to finish', 'error');
    return;
  }

  const valid = await validate(false);
  if (!valid) { toast('Fix the errors before saving', 'error'); return; }

  // Alert bounds and the tray's switches are read live and reload nothing,
  // and they are the edit an operator makes in a hurry — so a save that
  // touches only those goes straight through. The server computed `changed`;
  // this only reads it.
  const changed = lastValidation?.changed ?? null;
  const alertOnly = Array.isArray(changed) && changed.length > 0
    && changed.every((k) => k === 'alertBounds' || k === 'alerts');
  if (alertOnly) return commitSave(valid);

  // What the server will do with this draft is the server's decision — it
  // compares section by section against the running config. This only has to
  // describe the consequence honestly, so it reads a policy flag rather than
  // recomputing that diff; a client-side copy of the rule is one more thing to
  // keep in step.
  const armed = Boolean(bus.state?.armed);
  const locked = armed && bus.config.safety?.requireDisarmToEditConfig === true;
  const ok = await confirmAction({
    title: 'Save configuration?',
    message: locked
      ? 'The stand is ARMED, and this stand is set to require a DISARM for anything '
        + 'but autosequences. Autosequence edits apply live; any other change will be '
        + 'refused, with the sections named.'
      : armed
        ? [
          'The stand is ARMED and stays armed. Autosequence edits apply live with no reload.',
          '',
          'Anything else -- valves, sensors, calibrations, the P&ID -- changes what the '
          + 'controls on screen MEAN, so it takes effect on the server at once and then '
          + 'reloads every station, this one included, a few seconds after a warning. '
          + 'Valve positions are preserved.',
        ].join('\n')
        : 'The current file is backed up, then every connected browser reloads with the new configuration. Valve positions are preserved.',
    confirmLabel: 'Save & Apply',
    danger: armed,
  });
  if (!ok) return;
  return commitSave(valid);
}

async function commitSave(valid) {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: valid }),
  }).then((r) => r.json());

  if (res.ok) {
    dirty = false;
    $('#dirty-chip')?.classList.add('hidden');
    // Deliberately not "reloading": whether this page reloads depends on what
    // moved, and the config event says which a moment later. Claiming a reload
    // that does not come is worse than saying less.
    toast('Configuration saved', 'ok');
  } else {
    showStatus('error', 'Server rejected the configuration', res.errors || [res.error]);
  }
}

async function revert() {
  if (dirty) {
    const ok = await confirmAction({
      title: 'Discard changes?',
      message: 'The editor returns to the configuration currently running on the server.',
      confirmLabel: 'Discard',
    });
    if (!ok) return;
  }
  draft = structuredClone(bus.config);
  dirty = false;
  $('#dirty-chip')?.classList.add('hidden');
  seqEditor.reset();
  render();
  showStatus('', 'Reverted to the running configuration.');
}

async function reloadFromDisk() {
  const res = await fetch('/api/config/reload', { method: 'POST' }).then((r) => r.json());
  if (res.ok) toast('Reloaded from disk', 'ok');
  else showStatus('error', 'Reload failed', res.errors || []);
}

function download() {
  const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `stand-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function upload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const ta = $('#cfg-editor');
    if (ta) ta.value = String(reader.result);
    markDirty();
    validate(true);
    toast(`Loaded ${file.name} — review, then Save & Apply`, 'info', 6000);
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ======================================================= FIELD HELPERS ====
// A settings row: the question on the left (name + one line of what it does),
// the answer on the right. Controls share one column width so the answers
// line up down the whole group.

function settingsGroup(title, rows) {
  return el('section.settings-group', {},
    el('h3.eyebrow', { text: title }),
    el('div.settings-rows', {}, rows)
  );
}

function settingRow(label, hint, control, { wide = false } = {}) {
  return el('div.setting-row', { class: wide ? 'wide' : '' },
    el('div.setting-text', {},
      el('div.setting-name', { text: label }),
      hint ? el('div.setting-hint', { text: hint }) : null
    ),
    el('div.setting-ctl', {}, control)
  );
}

function textRow(label, hint, value, onChange, { mono = false, placeholder = '', wide = false } = {}) {
  return settingRow(label, hint, el('input', {
    type: 'text',
    class: mono ? 'mono' : '',
    value: value ?? '',
    placeholder,
    'aria-label': label,
    oninput: (e) => onChange(e.target.value),
  }), { wide });
}

function numberRow(label, hint, value, onChange, { min, max, unit = '' } = {}) {
  return settingRow(label, hint, el('div.setting-num', {},
    el('input', {
      type: 'number', value: value ?? '', min, max,
      'aria-label': label,
      onchange: (e) => {
        const v = Number(e.target.value);
        const ok = e.target.value !== '' && Number.isFinite(v)
          && (min === undefined || v >= min) && (max === undefined || v <= max);
        if (ok) onChange(v);
        else e.target.value = value ?? '';
      },
    }),
    el('span.setting-unit', { text: unit })
  ));
}

function colorRow(label, hint, value, onChange) {
  const hex = el('span.setting-hex', { text: (value || '#3b82f6').toLowerCase() });
  return settingRow(label, hint, el('div.setting-color', {},
    el('input', {
      type: 'color', value: value || '#3b82f6',
      'aria-label': label,
      oninput: (e) => { hex.textContent = e.target.value; },
      onchange: (e) => onChange(e.target.value),
    }),
    hex
  ));
}

function segRow(label, hint, options, value, onChange) {
  const seg = el('div.seg');
  for (const o of options) {
    const button = el('button', {
      type: 'button',
      class: o.value === value ? 'active' : '',
      text: o.label,
      onclick: () => {
        for (const b of seg.children) b.classList.toggle('active', b === button);
        onChange(o.value);
      },
    });
    seg.append(button);
  }
  return settingRow(label, hint, seg);
}

function toggleRow(label, hint, value, onChange) {
  const state = el('span.setting-state', { text: value ? 'ON' : 'OFF' });
  return settingRow(label, hint, el('label.toggle', {},
    el('input', {
      type: 'checkbox',
      checked: value ? '' : null,
      'aria-label': label,
      onchange: (e) => {
        state.textContent = e.target.checked ? 'ON' : 'OFF';
        onChange(e.target.checked);
      },
    }),
    el('span.track'),
    state
  ));
}

// ---------------------------------------------------------------- boot ----

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

render();
validate(false);
