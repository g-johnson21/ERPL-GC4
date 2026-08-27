/* page-config.js — configuration editor.
 *
 * Three tabs:
 *   Autosequences — full visual editor: steps, timings, abort conditions.
 *   General       — the settings that get changed most often.
 *   Advanced      — raw JSON, for everything else (P&ID layout, calibrations).
 *
 * All three edit one in-memory `draft`. Saving validates server-side, backs up
 * the current file, writes it, and hot-reloads every connected browser.
 */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { $, el, clear, icon, toast, confirmAction, debounce } from './util.js';

const content = await bootPage('config', { sidebar: false });

let draft = structuredClone(bus.config);
let dirty = false;
let activeTab = 'sequences';
let selectedSeqId = draft.autosequences?.[0]?.id ?? null;

const STEP_ACTIONS = [
  { value: 'valve', label: 'Set valve', hint: 'Command a valve open or closed' },
  { value: 'bangbang', label: 'Bang-bang control', hint: "Start or stop the board's regulator, or change what it regulates to" },
  { value: 'log', label: 'Log message', hint: 'Write a line to the event log and the CSV' },
  { value: 'safeAll', label: 'Safe all actuators', hint: 'Drive every valve to its safe state' },
  { value: 'abortStates', label: 'Apply abort states', hint: 'Drive every valve to its abort state' },
  { value: 'abort', label: 'Trigger ABORT', hint: 'Latch a stand-wide abort' },
  { value: 'end', label: 'End sequence', hint: 'Stop here' },
];

const STYLES = [
  { value: 'normal', label: 'Normal' },
  { value: 'safe', label: 'Safe (green)' },
  { value: 'caution', label: 'Caution (amber)' },
  { value: 'danger', label: 'Danger (red)' },
  { value: 'abort', label: 'Abort' },
];

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
    if (!draft.autosequences?.some((s) => s.id === selectedSeqId)) {
      selectedSeqId = draft.autosequences?.[0]?.id ?? null;
    }
  }
  activeTab = id;
  render();
}

function render() {
  renderTabs();
  const panel = $('#cfg-panel');
  clear(panel);
  if (activeTab === 'sequences') panel.append(sequencesTab());
  else if (activeTab === 'general') panel.append(generalTab());
  else panel.append(jsonTab());
}

function markDirty() {
  dirty = true;
  $('#dirty-chip')?.classList.remove('hidden');
}

// ====================================================== AUTOSEQUENCES =====

function sequencesTab() {
  const wrap = el('div.seq-layout');
  wrap.append(el('div.seq-picker#seq-picker'), el('div.seq-editor#seq-editor'));
  queueMicrotask(() => { renderSeqList(); renderSeqEditor(); });
  return wrap;
}

function renderSeqList() {
  const host = $('#seq-picker');
  if (!host) return;
  clear(host);

  host.append(el('div.section-title', {}, 'Sequences'));

  for (const seq of draft.autosequences || []) {
    const isAbort = draft.safety?.abortSequenceId === seq.id;
    host.append(el('button.seq-pick', {
      class: seq.id === selectedSeqId ? 'active' : '',
      dataset: { style: seq.style || 'normal' },
      onclick: () => { selectedSeqId = seq.id; renderSeqList(); renderSeqEditor(); },
    },
      el('span.seq-dot'),
      el('span.seq-pick-body', {},
        el('span.seq-pick-name', { text: seq.name || seq.id }),
        el('span.seq-pick-meta', {
          text: `${(seq.steps || []).length} steps · ${seqDuration(seq).toFixed(1)}s${isAbort ? ' · ABORT' : ''}`,
        })
      )
    ));
  }

  host.append(el('button.btn.wide.sm', {
    style: { marginTop: '8px' },
    text: '+ New sequence',
    onclick: newSequence,
  }));
}

function currentSeq() {
  return (draft.autosequences || []).find((s) => s.id === selectedSeqId) || null;
}

function seqDuration(seq) {
  const steps = seq.steps || [];
  return steps.length ? Math.max(...steps.map((s) => Number(s.t) || 0)) : 0;
}

function renderSeqEditor() {
  const host = $('#seq-editor');
  if (!host) return;
  clear(host);

  const seq = currentSeq();
  if (!seq) {
    host.append(el('div.empty-note', { text: 'No sequence selected. Create one to get started.' }));
    return;
  }

  const isAbortSeq = draft.safety?.abortSequenceId === seq.id;

  host.append(
    el('div.card', {},
      el('div.seq-title-row', {},
        el('h3', { text: seq.name || seq.id }),
        el('span.mono.faint', { text: seq.id }),
        el('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
          el('button.btn.sm', { text: 'Duplicate', onclick: () => duplicateSequence(seq) }),
          el('button.btn.sm.danger', { text: 'Delete', onclick: () => deleteSequence(seq) })
        )
      ),
      isAbortSeq
        ? el('div.inline-note', {}, `${icon('warning', 13)} This is the abort sequence (safety.abortSequenceId). It runs automatically on ABORT.`)
        : null,

      el('div.kv-grid', { style: { marginTop: '10px' } },
        textField('Name', seq.name, (v) => {
          seq.name = v;
          markDirty();
          renderSeqList();
          const heading = $('#seq-editor .seq-title-row h3');
          if (heading) heading.textContent = v;
        }),
        textField('Short label', seq.abbrev, (v) => { seq.abbrev = v; markDirty(); }),
        selectField('Button style', STYLES, seq.style || 'normal', (v) => { seq.style = v; markDirty(); renderSeqList(); }),
        numberField('Est. duration (s)', seqDuration(seq).toFixed(1), null, true)
      ),

      el('label.field', { style: { marginTop: '10px' }, text: 'Description (shown on hover and in the confirm dialog)' }),
      el('textarea', {
        rows: 2,
        value: seq.description || '',
        oninput: (e) => { seq.description = e.target.value; markDirty(); },
      }),

      el('div.toggle-row', {},
        toggleField('Requires ARM', seq.requiresArm !== false, (v) => { seq.requiresArm = v; markDirty(); }),
        toggleField('Confirm before running', seq.confirm !== false, (v) => { seq.confirm = v; markDirty(); }),
        toggleField('Hide from sidebar', seq.hidden === true, (v) => { seq.hidden = v; markDirty(); renderSeqList(); })
      )
    ),

    el('div.card', { style: { marginTop: '12px' } },
      el('div.section-title', {}, 'Timeline'),
      timeline(seq)
    ),

    el('div.card', { style: { marginTop: '12px' } },
      el('div.section-title', {}, `Steps (${(seq.steps || []).length})`,
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          el('span.faint', { style: { textTransform: 'none', letterSpacing: 0 }, text: 'Enter times as' }),
          el('div.seg', {},
            el('button', {
              class: timeMode(seq) === 'absolute' ? 'active' : '',
              title: 'Each step holds its own time measured from T+0, the start of the sequence.',
              text: 'T+ from start',
              onclick: () => { seq.timeMode = 'absolute'; markDirty(); renderSeqEditor(); },
            }),
            el('button', {
              class: timeMode(seq) === 'relative' ? 'active' : '',
              title: 'Each step holds the gap since the step before it. Changing a gap shifts every later step with it.',
              text: 'Δ from previous',
              onclick: () => { seq.timeMode = 'relative'; markDirty(); renderSeqEditor(); },
            })
          ),
          el('button.btn.sm', { text: '+ Add step', onclick: () => addStep(seq) })
        )
      ),
      stepsTable(seq)
    ),

    el('div.card', { style: { marginTop: '12px' } },
      el('div.section-title', {}, `Abort conditions (${(seq.abortConditions || []).length})`,
        el('button.btn.sm', { text: '+ Add condition', onclick: () => addCondition(seq) })
      ),
      el('p', { style: { marginTop: 0 }, text: 'Checked every control tick while this sequence runs. Any trip aborts the stand immediately.' }),
      conditionsTable(seq)
    )
  );
}

// ------------------------------------------------------------- timeline --

function timeline(seq) {
  const steps = [...(seq.steps || [])].sort((a, b) => (a.t || 0) - (b.t || 0));
  const dur = Math.max(seqDuration(seq), 1);
  const wrap = el('div.timeline');

  if (!steps.length) {
    wrap.append(el('div.empty-note', { style: { padding: '10px' }, text: 'No steps yet' }));
    return wrap;
  }

  const track = el('div.tl-track');
  for (const [i, s] of steps.entries()) {
    const pct = ((Number(s.t) || 0) / dur) * 100;
    track.append(el('i.tl-mark', {
      style: { left: `${pct}%` },
      dataset: { action: s.action },
      title: `T+${(Number(s.t) || 0).toFixed(2)}s — ${describeStep(s)}`,
      onclick: () => {
        const row = $(`#step-row-${i}`);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row?.classList.add('flash');
        setTimeout(() => row?.classList.remove('flash'), 900);
      },
    }));
  }
  wrap.append(track);

  const axis = el('div.tl-axis');
  for (let i = 0; i <= 4; i++) {
    axis.append(el('span', { text: `${((dur * i) / 4).toFixed(1)}s` }));
  }
  wrap.append(axis);
  return wrap;
}

function describeStep(s) {
  switch (s.action) {
    case 'valve': return `${s.target} → ${String(s.state || '').toUpperCase()}`;
    case 'bangbang': {
      const bits = [];
      if (s.enabled !== undefined) bits.push(s.enabled ? 'enable' : 'disable');
      if (s.setpoint !== undefined) bits.push(`sp ${s.setpoint}`);
      if (s.deadband !== undefined) bits.push(`db ${s.deadband}`);
      // Board overrides. Not offered in the editor above, but a hand-written
      // step may carry them and the timeline must not render them as nothing.
      if (s.vent !== undefined) bits.push(s.vent ? 'vent OPEN' : 'vent closed');
      if (s.abort) bits.push('SIDE ABORT');
      return `${s.target}: ${bits.join(', ') || 'no change'}`;
    }
    case 'log': return `log "${s.message || ''}"`;
    case 'abort': return `ABORT: ${s.message || ''}`;
    default: return STEP_ACTIONS.find((a) => a.value === s.action)?.label || s.action;
  }
}

// ---------------------------------------------------------------- steps --

function stepsTable(seq) {
  seq.steps ??= [];
  if (!seq.steps.length) {
    return el('div.empty-note', { text: 'No steps. Add one to build the sequence.' });
  }

  const relative = timeMode(seq) === 'relative';
  const table = el('table.step-table.steps-table');
  table.append(el('thead', {}, el('tr', {},
    el('th', { style: { width: relative ? '150px' : '96px' }, text: relative ? 'Δt (s)' : 'T+ (s)' }),
    el('th', { style: { width: '170px' }, text: 'Action' }),
    el('th', { style: { width: '190px' }, text: 'Target' }),
    el('th', { text: 'Setting' }),
    el('th', { style: { width: '64px' }, text: '' })
  )));

  const body = el('tbody');
  seq.steps.forEach((step, i) => body.append(stepRow(seq, step, i, relative)));
  table.append(body);
  return table;
}

/** 'absolute' (T+ from sequence start) or 'relative' (gap from previous step). */
function timeMode(seq) {
  return seq.timeMode === 'relative' ? 'relative' : 'absolute';
}

function round3(n) { return Number(n.toFixed(3)); }

function stepRow(seq, step, index, relative) {
  const row = el('tr.step-row', { id: `step-row-${index}` });

  // --- time ---
  const prevT = index === 0 ? 0 : Number(seq.steps[index - 1].t) || 0;
  const delta = round3((Number(step.t) || 0) - prevT);

  const timeInput = el('input', {
    type: 'number', step: '0.05', min: '0',
    value: relative ? delta : (step.t ?? 0),
    class: 'cell-input mono',
    style: relative ? { width: '78px' } : {},
    title: relative
      ? `Gap after the previous step. Absolute time T+${(Number(step.t) || 0).toFixed(2)}s.`
      : 'Seconds from the start of the sequence.',
    onchange: (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v < 0) { e.target.value = relative ? delta : (step.t ?? 0); return; }
      if (relative) setStepDelta(seq, index, v);
      else { step.t = v; markDirty(); resortSteps(seq); }
    },
  });

  row.append(el('td', {}, relative
    ? el('div.setting-group', {}, timeInput, el('span.faint.mono', { text: `T+${(Number(step.t) || 0).toFixed(2)}` }))
    : timeInput));

  // --- action ---
  row.append(el('td', {}, el('select', {
    class: 'cell-input',
    title: STEP_ACTIONS.find((a) => a.value === step.action)?.hint || '',
    onchange: (e) => {
      step.action = e.target.value;
      // Drop fields that no longer apply so the saved JSON stays clean.
      for (const k of ['target', 'state', 'enabled', 'setpoint', 'deadband', 'message']) delete step[k];
      if (step.action === 'valve') {
        step.target = draft.valves?.[0]?.id;
        step.state = 'closed';
      } else if (step.action === 'bangbang') {
        step.target = draft.bangbang?.[0]?.id ?? '*';
        step.enabled = false;
      }
      markDirty();
      renderSeqEditor();
    },
  }, STEP_ACTIONS.map((a) =>
    el('option', { value: a.value, selected: a.value === step.action ? '' : null, text: a.label })
  ))));

  // --- target ---
  row.append(el('td', {}, targetCell(step)));

  // --- setting ---
  row.append(el('td', {}, settingCell(step)));

  // --- row actions ---
  row.append(el('td', {}, el('div.row-actions', {},
    el('button.mini-btn', {
      title: 'Duplicate step', text: '⧉',
      onclick: () => { seq.steps.splice(index + 1, 0, structuredClone(step)); markDirty(); renderSeqEditor(); },
    }),
    el('button.mini-btn.danger', {
      title: 'Delete step', text: '✕',
      onclick: () => { seq.steps.splice(index, 1); markDirty(); renderSeqEditor(); },
    })
  )));

  return row;
}

function targetCell(step) {
  if (step.action === 'valve') {
    return el('select', {
      class: 'cell-input',
      onchange: (e) => { step.target = e.target.value; markDirty(); },
    }, (draft.valves || []).map((v) =>
      el('option', { value: v.id, selected: v.id === step.target ? '' : null, text: `${v.id} — ${v.name}` })
    ));
  }
  if (step.action === 'bangbang') {
    return el('select', {
      class: 'cell-input',
      onchange: (e) => { step.target = e.target.value; markDirty(); },
    },
      el('option', { value: '*', selected: step.target === '*' ? '' : null, text: '★ All controllers' }),
      (draft.bangbang || []).map((c) =>
        el('option', { value: c.id, selected: c.id === step.target ? '' : null, text: `${c.id} — ${c.name}` })
      )
    );
  }
  return el('span.faint', { text: '—' });
}

function settingCell(step) {
  if (step.action === 'valve') {
    const valve = (draft.valves || []).find((v) => v.id === step.target);
    return el('div.setting-group', {},
      el('select', {
        class: 'cell-input',
        style: { width: '130px' },
        onchange: (e) => { step.state = e.target.value; markDirty(); },
      },
        el('option', { value: 'open', selected: step.state === 'open' ? '' : null, text: valve?.openLabel || 'OPEN' }),
        el('option', { value: 'closed', selected: step.state === 'closed' ? '' : null, text: valve?.closedLabel || 'CLOSED' })
      ),
      valve?.requiresArm ? el('span.mini-tag', { title: 'This valve needs the stand ARMED', text: 'ARM' }) : null
    );
  }

  if (step.action === 'bangbang') {
    const ctrl = (draft.bangbang || []).find((c) => c.id === step.target);
    const units = ctrl ? (draft.sensors || []).find((s) => s.id === ctrl.sensor)?.units || '' : '';
    return el('div.setting-group', {},
      el('select', {
        class: 'cell-input', style: { width: '120px' },
        onchange: (e) => {
          if (e.target.value === '') delete step.enabled;
          else step.enabled = e.target.value === 'true';
          markDirty();
        },
      },
        el('option', { value: '', selected: step.enabled === undefined ? '' : null, text: '— no change —' }),
        el('option', { value: 'true', selected: step.enabled === true ? '' : null, text: 'Enable' }),
        el('option', { value: 'false', selected: step.enabled === false ? '' : null, text: 'Disable' })
      ),
      optionalNumber(step, 'setpoint', `Setpoint${units ? ` (${units})` : ''}`),
      optionalNumber(step, 'deadband', 'Deadband ±')
    );
  }

  if (step.action === 'log' || step.action === 'abort') {
    return el('input', {
      type: 'text',
      class: 'cell-input',
      placeholder: step.action === 'abort' ? 'Abort reason' : 'Message written to the log and CSV',
      value: step.message || '',
      oninput: (e) => { step.message = e.target.value; markDirty(); },
    });
  }

  return el('span.faint', { text: STEP_ACTIONS.find((a) => a.value === step.action)?.hint || '—' });
}

/** A number input that removes the key entirely when left blank. */
function optionalNumber(step, key, placeholder) {
  return el('input', {
    type: 'number',
    class: 'cell-input mono',
    style: { width: '104px' },
    placeholder,
    title: placeholder,
    value: step[key] ?? '',
    onchange: (e) => {
      const raw = e.target.value.trim();
      if (raw === '') delete step[key];
      else {
        const v = Number(raw);
        if (Number.isFinite(v)) step[key] = v;
        else { e.target.value = step[key] ?? ''; return; }
      }
      markDirty();
    },
  });
}

/**
 * Relative-mode edit: set the gap between step `index` and the one before it,
 * then carry every later step along by the same shift so their own gaps are
 * preserved. That is what "time since last step" has to mean — otherwise
 * retiming one step silently rewrites the spacing of the whole sequence.
 */
function setStepDelta(seq, index, deltaSeconds) {
  const steps = seq.steps;
  const prevT = index === 0 ? 0 : Number(steps[index - 1].t) || 0;
  const newT = round3(prevT + deltaSeconds);
  const shift = round3(newT - (Number(steps[index].t) || 0));
  if (shift === 0) return;

  steps[index].t = newT;
  for (let i = index + 1; i < steps.length; i++) {
    steps[i].t = round3(Math.max(0, (Number(steps[i].t) || 0) + shift));
  }
  markDirty();
  resortSteps(seq);
}

function resortSteps(seq) {
  seq.steps.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
  renderSeqEditor();
}

function addStep(seq) {
  seq.steps ??= [];
  const lastT = seq.steps.length ? Math.max(...seq.steps.map((s) => Number(s.t) || 0)) : -1;
  seq.steps.push({
    t: round3(lastT + 1),
    action: 'valve',
    target: draft.valves?.[0]?.id,
    state: 'closed',
  });
  markDirty();
  renderSeqEditor();
}

// --------------------------------------------------- abort conditions --

function conditionsTable(seq) {
  seq.abortConditions ??= [];
  if (!seq.abortConditions.length) {
    return el('div.empty-note', { text: 'No abort conditions. The sequence will run to completion regardless of sensor readings.' });
  }

  const table = el('table.step-table.conditions-table');
  table.append(el('thead', {}, el('tr', {},
    el('th', { style: { width: '210px' }, text: 'Sensor' }),
    el('th', { style: { width: '90px' }, text: 'Trips when' }),
    el('th', { style: { width: '120px' }, text: 'Value' }),
    el('th', { text: 'Message' }),
    el('th', { style: { width: '44px' }, text: '' })
  )));

  const body = el('tbody');
  seq.abortConditions.forEach((cond, i) => {
    const sensor = (draft.sensors || []).find((s) => s.id === cond.sensor);
    body.append(el('tr.step-row', {},
      el('td', {}, el('select', {
        class: 'cell-input',
        onchange: (e) => { cond.sensor = e.target.value; markDirty(); renderSeqEditor(); },
      }, (draft.sensors || []).map((s) =>
        el('option', { value: s.id, selected: s.id === cond.sensor ? '' : null, text: `${s.id} — ${s.name}` })
      ))),
      el('td', {}, el('select', {
        class: 'cell-input mono',
        onchange: (e) => { cond.op = e.target.value; markDirty(); },
      }, ['>', '<', '>=', '<='].map((op) =>
        el('option', { value: op, selected: op === cond.op ? '' : null, text: op })
      ))),
      el('td', {}, el('div.setting-group', {},
        el('input', {
          type: 'number', class: 'cell-input mono', style: { width: '80px' },
          value: cond.value ?? 0,
          onchange: (e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) { cond.value = v; markDirty(); }
            else e.target.value = cond.value ?? 0;
          },
        }),
        el('span.faint', { text: sensor?.units || '' })
      )),
      el('td', {}, el('input', {
        type: 'text', class: 'cell-input',
        placeholder: 'Shown in the log when it trips',
        value: cond.message || '',
        oninput: (e) => { cond.message = e.target.value; markDirty(); },
      })),
      el('td', {}, el('button.mini-btn.danger', {
        title: 'Delete condition', text: '✕',
        onclick: () => { seq.abortConditions.splice(i, 1); markDirty(); renderSeqEditor(); },
      }))
    ));
  });
  table.append(body);
  return table;
}

function addCondition(seq) {
  seq.abortConditions ??= [];
  const first = draft.sensors?.[0];
  seq.abortConditions.push({
    sensor: first?.id,
    op: '>',
    value: first?.dangerHigh ?? first?.max ?? 0,
    message: '',
  });
  markDirty();
  renderSeqEditor();
}

// ------------------------------------------------- sequence lifecycle --

function newSequence() {
  draft.autosequences ??= [];
  let n = draft.autosequences.length + 1;
  let id = `seq-custom-${n}`;
  while (draft.autosequences.some((s) => s.id === id)) id = `seq-custom-${++n}`;

  draft.autosequences.push({
    id,
    name: `New Sequence ${n}`,
    abbrev: 'NEW',
    description: '',
    style: 'normal',
    requiresArm: true,
    confirm: true,
    abortConditions: [],
    steps: [{ t: 0, action: 'log', message: 'Sequence start' }],
  });
  selectedSeqId = id;
  markDirty();
  renderSeqList();
  renderSeqEditor();
  toast(`Created "${id}" — remember to Save & Apply`, 'ok');
}

function duplicateSequence(seq) {
  let n = 2;
  let id = `${seq.id}-copy`;
  while (draft.autosequences.some((s) => s.id === id)) id = `${seq.id}-copy${n++}`;

  const copy = structuredClone(seq);
  copy.id = id;
  copy.name = `${seq.name} (copy)`;
  delete copy.duration;
  draft.autosequences.push(copy);
  selectedSeqId = id;
  markDirty();
  renderSeqList();
  renderSeqEditor();
}

async function deleteSequence(seq) {
  const isAbortSeq = draft.safety?.abortSequenceId === seq.id;
  const ok = await confirmAction({
    title: `Delete "${seq.name}"?`,
    message: isAbortSeq
      ? 'This is the configured ABORT sequence. Deleting it means ABORT will fall back to driving every valve straight to its abort state. You will need to clear safety.abortSequenceId as well or the config will not validate.'
      : 'The sequence and all of its steps will be removed.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;

  draft.autosequences = draft.autosequences.filter((s) => s.id !== seq.id);
  if (isAbortSeq) delete draft.safety.abortSequenceId;
  selectedSeqId = draft.autosequences[0]?.id ?? null;
  markDirty();
  renderTabs();
  renderSeqList();
  renderSeqEditor();
}

// ============================================================ GENERAL =====

function generalTab() {
  const ui = draft.ui ??= {};
  const rec = draft.recording ??= {};
  const tel = draft.telemetry ??= {};
  const safety = draft.safety ??= {};
  const meta = draft.meta ??= {};

  return el('div.card', {},
    el('h3', { text: 'General settings' }),
    el('p', { text: 'Everything else — valves, sensors, calibrations, P&ID layout — lives on the Advanced tab.' }),
    el('div.kv-grid', {},
      textField('Organization', meta.organization, (v) => { meta.organization = v; markDirty(); }),
      textField('Stand name', meta.standName, (v) => { meta.standName = v; markDirty(); }),
      textField('Brand (header)', ui.brand, (v) => { ui.brand = v; markDirty(); }),
      colorField('Accent colour', ui.accent, (v) => { ui.accent = v; markDirty(); }),
      selectField('Default theme', [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }],
        ui.defaultTheme || 'dark', (v) => { ui.defaultTheme = v; markDirty(); }),
      numberField('Valve grid columns', ui.gridColumns, (v) => { ui.gridColumns = v; markDirty(); }, false, 1, 8),
      numberField('Control loop (Hz)', tel.sampleRateHz, (v) => { tel.sampleRateHz = v; markDirty(); }, false, 1, 500),
      numberField('Browser stream (Hz)', tel.streamRateHz, (v) => { tel.streamRateHz = v; markDirty(); }, false, 1, 60),
      numberField('CSV rate (Hz)', rec.rateHz, (v) => { rec.rateHz = v; markDirty(); }, false, 1, 500),
      textField('Recording directory', rec.directory, (v) => { rec.directory = v; markDirty(); }),
      textField('Default test name', rec.defaultTestName, (v) => { rec.defaultTestName = v; markDirty(); }),
      numberField('Auto-disarm after (s, 0 = never)', safety.autoDisarmAfterSeconds,
        (v) => { safety.autoDisarmAfterSeconds = v; markDirty(); }, false, 0)
    ),
    el('div.toggle-row', { style: { marginTop: '12px' } },
      toggleField('Require ARM to actuate', safety.requireArmToActuate !== false,
        (v) => { safety.requireArmToActuate = v; markDirty(); })
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

  // Armed saves are allowed for autosequences only, and the server is the one
  // that decides whether this draft qualifies — it compares the draft against
  // the running config section by section. Don't second-guess it here; a
  // client-side copy of that rule is one more thing to keep in step.
  const armed = Boolean(bus.state?.armed);
  const ok = await confirmAction({
    title: 'Save configuration?',
    message: armed
      ? 'The stand is ARMED. Autosequence edits are applied live — every station picks up the new sequences without reloading. Anything outside autosequences is refused until you disarm.'
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
    toast('Configuration saved — reloading', 'ok');
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
  if (!draft.autosequences?.some((s) => s.id === selectedSeqId)) {
    selectedSeqId = draft.autosequences?.[0]?.id ?? null;
  }
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
