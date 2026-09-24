/* page-config.js — configuration editor.
 *
 * Three tabs:
 *   Autosequences — swimlane timeline editor (seq-editor.js).
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
        el('button.btn', { text: 'Validate', onclick: () => validate(true) }),
        el('button.btn', { html: `${icon('refresh', 14)} Revert`, onclick: revert }),
        el('button.btn.accent', { title: 'Save and apply (Ctrl+S)', html: `${icon('save', 14)} Save & Apply`, onclick: save })
      )
    ),
    el('div.tabs#cfg-tabs'),
    el('div.config-status#cfg-status', { text: 'Loaded.' })
  ),
  el('div#cfg-panel')
);

// Keep the sequence picker pinned just below the bar, whatever height it is
// (the validation list makes it grow).
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

  return el('div.card', {},
    el('h3', { text: 'General settings' }),
    el('p', { text: 'Everything else — valves, sensors, calibrations, P&ID layout — lives on the Advanced tab.' }),
    el('div.kv-grid', {},
      textField('Stand name', meta.standName, (v) => { meta.standName = v; markDirty(); }),
      colorField('Accent colour', ui.accent, (v) => { ui.accent = v; markDirty(); }),
      selectField('Default theme', [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
        ui.defaultTheme || 'dark', (v) => { ui.defaultTheme = v; markDirty(); }),
      numberField('Valve grid columns', ui.gridColumns, (v) => { ui.gridColumns = v; markDirty(); }, false, 1, 8),
      numberField('Control loop (Hz)', tel.sampleRateHz, (v) => { tel.sampleRateHz = v; markDirty(); }, false, 1, 500),
      numberField('Browser stream (Hz)', tel.streamRateHz, (v) => { tel.streamRateHz = v; markDirty(); }, false, 1, 60),
      numberField('CSV rate (Hz)', rec.rateHz, (v) => { rec.rateHz = v; markDirty(); }, false, 1, 500),
      textField('Recording directory', rec.directory, (v) => { rec.directory = v; markDirty(); }),
      textField('Default test name', rec.defaultTestName, (v) => { rec.defaultTestName = v; markDirty(); }),
      textField('Control PIN (4–12 digits, blank = none)', safety.controlPin,
        (v) => { safety.controlPin = v.trim(); markDirty(); }),
      numberField('Tank height (in)', tankLevel.heightIn ?? 70,
        (v) => { tankLevel.heightIn = v; markDirty(); }, false, 1, 500),
      numberField('Tank level smoothing (s)', tankLevel.smoothingSeconds ?? 5,
        (v) => { tankLevel.smoothingSeconds = v; markDirty(); }, false, 0, 120)
    ),
    el('div.toggle-row', { style: { marginTop: '12px' } },
      toggleField('Require ARM to actuate', safety.requireArmToActuate !== false,
        (v) => { safety.requireArmToActuate = v; markDirty(); }),
      toggleField('Show tank fill level on P&ID', tankLevel.enabled !== false,
        (v) => { tankLevel.enabled = v; markDirty(); }),
      toggleField('Hold SHIFT to enable a valve', ui.requireShiftToActuate !== false,
        (v) => { ui.requireShiftToActuate = v; markDirty(); })
    )
  );
}

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
    return null;
  }

  if (res.ok) {
    showStatus('ok', `Valid — ${draft.valves.length} actuators, ${draft.sensors.length} sensors, ${draft.autosequences?.length ?? 0} sequences.`);
    if (verbose) toast('Configuration is valid', 'ok');
  } else {
    showStatus('error', `${res.errors.length} problem${res.errors.length === 1 ? '' : 's'} found`, res.errors);
  }
  return res.ok ? draft : null;
}

function showStatus(kind, message, details = []) {
  const host = $('#cfg-status');
  if (!host) return;
  clear(host);
  host.className = `config-status ${kind}`;
  host.append(el('div', { text: message }));
  if (details.length) {
    host.append(el('ul', {}, details.slice(0, 25).map((d) => el('li', { text: d }))));
    if (details.length > 25) host.append(el('div', { text: `…and ${details.length - 25} more` }));
  }
}

// ============================================================ ACTIONS =====

async function save() {
  if (bus.state?.sequence?.running) {
    toast('A sequence is running — wait for it to finish', 'error');
    return;
  }

  const valid = await validate(false);
  if (!valid) { toast('Fix the errors before saving', 'error'); return; }

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

function textField(label, value, onChange) {
  return el('div', {},
    el('label.field', { text: label }),
    el('input', { type: 'text', value: value ?? '', oninput: (e) => onChange(e.target.value) })
  );
}

function numberField(label, value, onChange, readOnly = false, min, max) {
  return el('div', {},
    el('label.field', { text: label }),
    el('input', {
      type: 'number', value: value ?? '', min, max,
      readonly: readOnly ? '' : null,
      disabled: readOnly ? '' : null,
      onchange: readOnly ? null : (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(v);
        else e.target.value = value ?? '';
      },
    })
  );
}

function colorField(label, value, onChange) {
  return el('div', {},
    el('label.field', { text: label }),
    el('input', {
      type: 'color', value: value || '#ff7a1a',
      style: { height: '32px', padding: '2px' },
      onchange: (e) => onChange(e.target.value),
    })
  );
}

function selectField(label, options, value, onChange) {
  return el('div', {},
    el('label.field', { text: label }),
    el('select', { onchange: (e) => onChange(e.target.value) },
      options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const t = typeof o === 'string' ? o : o.label;
        return el('option', { value: v, selected: v === value ? '' : null, text: t });
      })
    )
  );
}

function toggleField(label, value, onChange) {
  return el('label.toggle', {},
    el('input', {
      type: 'checkbox',
      checked: value ? '' : null,
      onchange: (e) => onChange(e.target.checked),
    }),
    el('span.track'),
    el('span', { text: label })
  );
}

// ---------------------------------------------------------------- boot ----

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

render();
validate(false);
