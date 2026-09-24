/* seq-editor.js — the autosequence editor on the Config page.
 *
 * A sequence is drawn as what it does: one swimlane per actuator, time running
 * left to right, each valve's open window a green bar between the step that
 * opens it and the step that closes it. Steps are handles on those lanes and
 * are moved by dragging them. Under the timeline, the same sequence reads top
 * to bottom as a script (T+, gap, what happens), and the inspector beside it
 * edits whatever is selected.
 *
 * Replaces a table of dropdowns in which a step's time was a number in a box
 * and the only picture of the run was a strip of unlabelled ticks: moving an
 * actuation meant retyping times, and knowing when a valve was open meant
 * reading two rows that might be ten rows apart.
 *
 * What the steps MEAN (states over time, SAFE ALL, pulses, END) is worked out
 * in seq-model.js; this file only draws it and edits it.
 */
import { bus } from './bus.js';
import { el, clear, icon, toast, confirmAction } from './util.js';
import * as M from './seq-model.js';

const STYLES = [
  { value: 'normal', label: 'Normal' },
  { value: 'safe', label: 'Safe' },
  { value: 'caution', label: 'Caution' },
  { value: 'danger', label: 'Danger' },
  { value: 'abort', label: 'Abort' },
];

const SNAPS = [
  { value: 0, label: 'OFF' },
  { value: 0.01, label: '.01' },
  { value: 0.05, label: '.05' },
  { value: 0.1, label: '.1' },
  { value: 0.5, label: '.5' },
];

const AXIS_H = 24;
const LANE_H = 30;
const PAD_L = 14;
const PAD_R = 28;
const MAGNET_PX = 6;
const UNDO_LIMIT = 100;

const STEP_KEYS = ['target', 'state', 'enabled', 'setpoint', 'deadband',
  'maxOpenMs', 'minIntervalMs', 'message', 'vent', 'abort'];

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ }
}

/**
 * @param {object} ctx
 * @param {() => object} ctx.getDraft   the config being edited
 * @param {() => void}   ctx.markDirty
 * @param {() => boolean} ctx.isDirty
 * @param {() => void}   ctx.onListChange  sequence added/removed (tab label)
 */
export function createSequenceEditor(ctx) {
  const S = {
    seqId: ctx.getDraft().autosequences?.[0]?.id ?? null,
    selection: new Set(),
    extraLanes: new Map(),  // seqId -> lane keys added with no step yet
    tab: 'step',            // inspector tab
    snap: load('gc.seq.snap', 0.05),
    zoom: 'fit',
    pps: 100,               // px per second when zoom is manual
    cursorT: null,          // under the mouse
    pinT: null,             // last clicked empty time: where "+ Step" inserts
    preview: null,          // { t0, raf, t }
    liveT: null,            // the stand is running THIS sequence
    drag: null,
    marquee: null,
    undo: [],
    redo: [],
    sim: null,
    lanes: [],
    geom: null,
    hits: [],
  };
  let root = null;
  let resizeObs = null;
  let lastWidth = 0;

  const cfg = () => ctx.getDraft();
  const cur = () => (cfg().autosequences || []).find((s) => s.id === S.seqId) || null;
  const q = (sel) => root?.querySelector(sel);
  const ripple = (seq) => seq.timeMode === 'relative';
  const valveById = (id) => (cfg().valves || []).find((v) => v.id === id);
  const ctrlById = (id) => (cfg().bangbang || []).find((c) => c.id === id);

  // ============================================================== mount ===

  function mount(host) {
    ensureSelection();
    root = el('div.sq', {},
      el('aside.sq-picker'),
      el('section.sq-main', {},
        el('header.sq-head'),
        el('div.sq-toolbar'),
        el('div.sq-tl', {},
          el('div.sq-gutter'),
          el('div.sq-scroll', {}, el('div.sq-plot'))
        ),
        el('div.sq-lower', {},
          el('div.sq-script'),
          el('div.sq-inspector')
        )
      )
    );
    host.append(root);
    wirePlot();
    resizeObs?.disconnect();
    if (window.ResizeObserver) {
      resizeObs = new ResizeObserver(() => {
        const w = q('.sq-scroll')?.clientWidth || 0;
        if (Math.abs(w - lastWidth) > 1 && S.zoom === 'fit') renderTimeline();
      });
      resizeObs.observe(q('.sq-scroll'));
    }
    renderAll();
  }

  function mounted() { return Boolean(root && root.isConnected); }

  /** The draft was replaced (revert, JSON tab): keep the selection if it still exists. */
  function reset() {
    S.selection.clear();
    S.undo = [];
    S.redo = [];
    stopPreview();
    ensureSelection();
  }

  function ensureSelection() {
    const list = cfg().autosequences || [];
    if (!list.some((s) => s.id === S.seqId)) S.seqId = list[0]?.id ?? null;
  }

  function selectSequence(id) {
    if (id === S.seqId) return;
    stopPreview();
    S.seqId = id;
    S.selection.clear();
    S.pinT = null;
    S.zoom = 'fit';
    renderAll();
  }

  function renderAll() {
    if (!mounted()) return;
    const seq = cur();
    root.classList.toggle('empty', !seq);
    renderPicker();
    if (!seq) {
      for (const sel of ['.sq-head', '.sq-toolbar', '.sq-gutter', '.sq-plot', '.sq-script', '.sq-inspector']) clear(q(sel));
      q('.sq-head').append(el('div.sq-empty', {},
        el('div', { text: 'No sequence selected.' }),
        el('button.btn.sm', { text: '+ New sequence', onclick: newSequence })));
      return;
    }
    // Drop selected steps that no longer exist (undo, delete).
    const alive = new Set(seq.steps || []);
    for (const s of [...S.selection]) if (!alive.has(s)) S.selection.delete(s);
    renderHead();
    renderToolbar();
    renderTimeline();
    renderScript();
    renderInspector();
  }

  // ============================================================= edits ====

  function snapshot(seq = cur()) {
    return { id: seq.id, json: JSON.stringify(seq), sel: selectionIndices(seq) };
  }
  function selectionIndices(seq) {
    return (seq.steps || []).flatMap((s, i) => (S.selection.has(s) ? [i] : []));
  }
  function pushUndo(snap = snapshot()) {
    S.undo.push(snap);
    if (S.undo.length > UNDO_LIMIT) S.undo.shift();
    S.redo = [];
  }
  function restore(from, to) {
    const snap = from.pop();
    if (!snap) return;
    const list = cfg().autosequences || [];
    const i = list.findIndex((s) => s.id === snap.id);
    if (i < 0) return;
    to.push(snapshot(list[i]));
    list[i] = JSON.parse(snap.json);
    S.seqId = snap.id;
    S.selection = new Set(snap.sel.map((k) => list[i].steps[k]).filter(Boolean));
    ctx.markDirty();
    renderAll();
  }
  const undo = () => restore(S.undo, S.redo);
  const redo = () => restore(S.redo, S.undo);

  /** Record an undo point, run `fn`, re-sort, mark dirty, redraw. */
  function edit(fn, { render = true } = {}) {
    const seq = cur();
    if (!seq) return;
    pushUndo();
    fn(seq);
    M.sortSteps(seq);
    ctx.markDirty();
    if (render) renderAll();
  }

  function selectOnly(steps) {
    S.selection = new Set(steps);
    if (steps.length) S.tab = 'step';
  }

  function addStep(step) {
    edit((seq) => {
      seq.steps ??= [];
      seq.steps.push(step);
      selectOnly([step]);
    });
    if (step.action === 'log' || step.action === 'abort') {
      requestAnimationFrame(() => q('.sq-inspector input[data-focus="message"]')?.focus());
    }
  }

  function insertTime() {
    const seq = cur();
    if (S.pinT !== null) return S.pinT;
    const sel = [...S.selection];
    if (sel.length) return Math.max(...sel.map(M.stepT));
    return M.round3(M.duration(seq) + (seq.steps?.length ? (S.snap || 0.5) : 0));
  }

  function newStepOfKind(action, t) {
    const step = { t: M.round3(t), action };
    if (action === 'valve') { step.target = cfg().valves?.[0]?.id; step.state = 'open'; }
    if (action === 'bangbang') { step.target = cfg().bangbang?.[0]?.id ?? '*'; step.enabled = true; }
    if (action === 'log' || action === 'abort') step.message = '';
    return step;
  }

  /** Double-click on a lane: the obvious step for that lane at that time. */
  function addStepOnLane(laneKey, t) {
    const [kind, id] = laneKey.split(':');
    if (kind === 'valve') {
      const now = S.sim && M.stateAt(S.sim, laneKey, t)?.state;
      const safe = valveById(id)?.safeState || 'closed';
      const state = now ? (now === 'open' ? 'closed' : 'open') : (safe === 'open' ? 'closed' : 'open');
      addStep({ t, action: 'valve', target: id, state });
    } else if (kind === 'bb') {
      const now = S.sim && M.stateAt(S.sim, laneKey, t)?.state?.enabled;
      addStep({ t, action: 'bangbang', target: id, enabled: !now });
    } else {
      addStep({ t, action: 'log', message: '' });
    }
  }

  function deleteSelection() {
    if (!S.selection.size) return;
    const n = S.selection.size;
    edit((seq) => {
      seq.steps = seq.steps.filter((s) => !S.selection.has(s));
      S.selection.clear();
    });
    toast(`Deleted ${n} step${n === 1 ? '' : 's'} (Ctrl+Z to undo)`, 'info', 2500);
  }

  function duplicateSelection() {
    if (!S.selection.size) return;
    const gap = S.snap || 0.1;
    edit((seq) => {
      const clones = [...S.selection].map((s) => ({ ...structuredClone(s), t: M.round3(M.stepT(s) + gap) }));
      seq.steps.push(...clones);
      selectOnly(clones);
    });
  }

  function nudge(delta) {
    if (!S.selection.size) return;
    edit((seq) => {
      const orig = new Map(seq.steps.map((s) => [s, M.stepT(s)]));
      M.shiftSteps(seq.steps, orig, [...S.selection], delta, ripple(seq));
    });
  }

  // ========================================================== sequences ===

  function newSequence() {
    const draft = cfg();
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
    ctx.markDirty();
    ctx.onListChange();
    selectSequence(id);
    S.tab = 'sequence';
    renderAll();
    toast(`Created "${id}". Save & Apply to keep it.`, 'ok');
  }

  function duplicateSequence(seq) {
    const draft = cfg();
    let n = 2;
    let id = `${seq.id}-copy`;
    while (draft.autosequences.some((s) => s.id === id)) id = `${seq.id}-copy${n++}`;
    const copy = structuredClone(seq);
    copy.id = id;
    copy.name = `${seq.name} (copy)`;
    delete copy.duration;
    draft.autosequences.push(copy);
    ctx.markDirty();
    ctx.onListChange();
    selectSequence(id);
  }

  async function deleteSequence(seq) {
    const draft = cfg();
    const isAbortSeq = draft.safety?.abortSequenceId === seq.id;
    const ok = await confirmAction({
      title: `Delete "${seq.name}"?`,
      message: isAbortSeq
        ? 'This is the configured ABORT sequence. Deleting it means ABORT will fall back to driving every valve straight to its abort state.'
        : 'The sequence and all of its steps will be removed.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    draft.autosequences = draft.autosequences.filter((s) => s.id !== seq.id);
    if (isAbortSeq) delete draft.safety.abortSequenceId;
    S.seqId = draft.autosequences[0]?.id ?? null;
    S.selection.clear();
    ctx.markDirty();
    ctx.onListChange();
    renderAll();
  }

  // ============================================================= picker ===

  function renderPicker() {
    const host = q('.sq-picker');
    clear(host);
    const draft = cfg();
    host.append(el('div.sq-picker-head', {},
      el('span.eyebrow', { text: 'Sequences' }),
      el('button.icon-sq', { title: 'New sequence', text: '+', onclick: newSequence })
    ));
    const list = el('div.sq-pick-list');
    for (const seq of draft.autosequences || []) {
      const isAbort = draft.safety?.abortSequenceId === seq.id;
      list.append(el('button.sq-pick', {
        class: seq.id === S.seqId ? 'active' : '',
        dataset: { style: seq.style || 'normal' },
        title: seq.description || seq.name,
        onclick: () => selectSequence(seq.id),
      },
        el('span.sq-dot'),
        el('span.sq-pick-name', { text: seq.name || seq.id }),
        isAbort ? el('span.sq-badge.bad', { text: 'ABORT' }) : null,
        seq.hidden ? el('span.sq-badge', { text: 'HIDDEN' }) : null,
        el('span.sq-pick-dur', { text: `${M.duration(seq).toFixed(1)}s` })
      ));
    }
    host.append(list);
  }

  // =============================================================== head ===

  function renderHead() {
    const host = q('.sq-head');
    clear(host);
    const seq = cur();
    const draft = cfg();
    const isAbortSeq = draft.safety?.abortSequenceId === seq.id;
    const lanes = M.buildLanes(seq, draft).filter((l) => l.kind !== 'events').length;
    const end = M.stopTime(seq);

    const meta = [
      [`${(seq.steps || []).length}`, ' steps'],
      [`${M.duration(seq).toFixed(2)}`, ' s'],
      [`${lanes}`, lanes === 1 ? ' actuator' : ' actuators'],
    ];
    const flags = [
      seq.requiresArm !== false ? 'REQUIRES ARM' : 'NO ARM',
      seq.confirm !== false ? 'CONFIRM' : null,
      seq.usePandaAutosequencer ? 'PANDA' : null,
      seq.hidden ? 'HIDDEN' : null,
      end !== null ? `STOPS ${M.fmtT(end)}` : null,
    ].filter(Boolean);

    host.append(
      el('div.sq-head-main', {},
        el('span.sq-dot.lg', { dataset: { style: seq.style || 'normal' } }),
        el('input.sq-name', {
          value: seq.name || '',
          spellcheck: 'false',
          title: 'Sequence name (click to edit)',
          'aria-label': 'Sequence name',
          oninput: (e) => { seq.name = e.target.value; ctx.markDirty(); renderPicker(); },
        }),
        el('span.sq-pencil', { text: '✎' }),
        el('span.sq-id', { text: seq.id }),
        el('div.sq-head-actions', {},
          el('button.btn.sm', { text: 'Duplicate', onclick: () => duplicateSequence(seq) }),
          el('button.btn.sm.danger', { text: 'Delete', onclick: () => deleteSequence(seq) })
        )
      ),
      el('div.sq-meta', {},
        meta.map(([n, unit]) => el('span.sq-meta-item', {}, el('b', { text: n }), unit)),
        flags.map((f) => el('span.sq-flag', { text: f })),
        isAbortSeq ? el('span.sq-flag.bad', { html: `${icon('warning', 11)} RUNS ON ABORT` }) : null
      )
    );
  }

  // ============================================================ toolbar ===

  function renderToolbar() {
    const host = q('.sq-toolbar');
    clear(host);
    const seq = cur();

    const seg = (items, active, onPick, title) => el('div.seg', { title },
      items.map((it) => el('button', {
        class: it.value === active ? 'active' : '',
        text: it.label,
        title: it.title,
        onclick: () => onPick(it.value),
      })));

    const addMenu = el('select.sq-add', {
      title: 'Add a step at the pinned time (click an empty spot on the timeline to pin one)',
      onchange: (e) => {
        const action = e.target.value;
        e.target.value = '';
        if (action) addStep(newStepOfKind(action, insertTime()));
      },
    },
      el('option', { value: '', text: '+ Step', selected: '' }),
      M.STEP_ACTIONS.map((a) => el('option', { value: a.value, text: a.label }))
    );

    const previewing = Boolean(S.preview);
    host.append(
      el('div.sq-tool', {}, el('span.eyebrow', { text: 'Snap' }),
        seg(SNAPS.map((s) => ({ ...s, title: s.value ? `Snap to ${s.value} s (hold Alt to drag freely)` : 'No grid; steps still line up with each other' })),
          S.snap, (v) => { S.snap = v; store('gc.seq.snap', v); renderToolbar(); })),
      el('div.sq-tool', {}, el('span.eyebrow', { text: 'Move' }),
        seg([
          { value: 'absolute', label: 'ONE', title: 'Moving a step moves only that step (and anything selected with it)' },
          { value: 'relative', label: 'RIPPLE', title: 'Moving a step carries every later step with it, keeping the gaps' },
        ], ripple(seq) ? 'relative' : 'absolute', (v) => {
          seq.timeMode = v; ctx.markDirty(); renderToolbar();
        })),
      el('div.sq-tool', {}, el('span.eyebrow', { text: 'Zoom' }),
        el('div.seg', {},
          el('button', { text: '−', title: 'Zoom out (Ctrl+wheel)', onclick: () => zoomBy(1 / 1.5) }),
          el('button', { class: S.zoom === 'fit' ? 'active' : '', text: 'FIT', title: 'Fit the whole sequence', onclick: () => { S.zoom = 'fit'; renderTimeline(); renderToolbar(); } }),
          el('button', { text: '+', title: 'Zoom in (Ctrl+wheel)', onclick: () => zoomBy(1.5) })
        )),
      el('div.sq-tool', {},
        el('button.icon-sq', { title: 'Undo (Ctrl+Z)', disabled: S.undo.length ? null : '', text: '↶', onclick: undo }),
        el('button.icon-sq', { title: 'Redo (Ctrl+Y)', disabled: S.redo.length ? null : '', text: '↷', onclick: redo })
      ),
      el('div.sq-tool', {}, addMenu),
      el('div.sq-tool.right', {},
        el('button.icon-sq.play', {
          class: previewing ? 'on' : '',
          title: previewing ? 'Stop the preview' : 'Preview: sweep a playhead through the sequence in real time. Nothing is sent to the stand.',
          html: icon(previewing ? 'stop' : 'play', 12),
          onclick: () => (previewing ? stopPreview() : startPreview()),
        }),
        el('span.eyebrow', { text: previewing ? 'Previewing' : 'Preview' })
      )
    );
  }

  function zoomBy(factor, anchorClientX = null) {
    const scroll = q('.sq-scroll');
    const g = S.geom;
    if (!scroll || !g) return;
    const rect = scroll.getBoundingClientRect();
    const ax = anchorClientX === null ? rect.width / 2 : anchorClientX - rect.left;
    const tAnchor = (scroll.scrollLeft + ax - PAD_L) / g.pps;
    S.pps = Math.min(4000, Math.max(g.fitPps, g.pps * factor));
    S.zoom = S.pps <= g.fitPps + 1e-6 ? 'fit' : 'manual';
    renderTimeline();
    scroll.scrollLeft = Math.max(0, PAD_L + tAnchor * S.geom.pps - ax);
    renderToolbar();
  }

  // =========================================================== timeline ===

  function eventLabel(step) {
    switch (step.action) {
      case 'log': return step.message || '(empty milestone)';
      case 'safeAll': return 'SAFE ALL';
      case 'abortStates': return 'ABORT STATES';
      case 'abort': return step.message ? `ABORT: ${step.message}` : 'ABORT';
      case 'end': return 'END';
      default: return step.action;
    }
  }

  /** Greedy label rows for the milestone lane: a label never covers another. */
  function layoutEvents(events, x, W) {
    const rows = [];
    const placed = [];
    for (const step of events) {
      const px = x(M.stepT(step));
      const text = eventLabel(step);
      const w = text.length * 6.1 + 16;
      // Near the right edge the label goes on the marker's left instead.
      const flip = px + w > W - 4;
      const left = flip ? px - w : px;
      let row = rows.findIndex((right) => right < left - 2);
      if (row < 0 && rows.length < 3) { rows.push(-Infinity); row = rows.length - 1; }
      if (row < 0) { placed.push({ step, px, row: -1, text }); continue; }
      rows[row] = flip ? px + 8 : px + w;
      placed.push({ step, px, row, text, w, flip });
    }
    return { placed, rows: Math.max(1, rows.length) };
  }

  function renderTimeline() {
    if (!mounted()) return;
    const seq = cur();
    const gutter = q('.sq-gutter');
    const scroll = q('.sq-scroll');
    const plot = q('.sq-plot');
    if (!seq) return;
    const draft = cfg();
    const keepScroll = scroll.scrollLeft;

    const lanes = M.buildLanes(seq, draft, S.extraLanes.get(seq.id) || []);
    const sim = M.simulate(seq, draft);
    const warnings = M.lint(seq, draft);
    S.sim = sim;
    S.lanes = lanes;

    // ---- geometry. Frozen while dragging so the scale does not move under the mouse.
    const dur = M.duration(seq);
    const width = scroll.clientWidth || 800;
    lastWidth = width;
    let span = Math.max(dur, 1) * 1.04 + 0.25;
    let fitPps = (width - PAD_L - PAD_R) / span;
    if (S.drag?.geom) {
      span = Math.max(S.drag.geom.span, dur * 1.02 + 0.25);
      fitPps = S.drag.geom.fitPps;
    }
    const pps = S.drag?.geom ? S.drag.geom.pps : (S.zoom === 'fit' ? fitPps : Math.max(S.pps, fitPps));
    const W = Math.max(width, PAD_L + span * pps + PAD_R);
    const tMax = (W - PAD_L - PAD_R) / pps;
    const x = (t) => PAD_L + t * pps;
    S.geom = { span, pps, fitPps, W, x, tMax };

    // ---- lane heights
    const events = M.ordered(seq).filter((s) => M.EVENT_ACTIONS.has(s.action));
    const evLayout = layoutEvents(events, x, W);
    const evH = Math.max(LANE_H, 10 + evLayout.rows * 17);
    let top = AXIS_H;
    for (const lane of lanes) {
      lane.top = top;
      lane.h = lane.kind === 'events' ? evH : LANE_H;
      top += lane.h;
    }
    const addRowTop = top;
    const H = top + LANE_H;

    // ---- gutter
    clear(gutter);
    gutter.style.height = `${H}px`;
    gutter.append(el('div.gut-axis', { style: { height: `${AXIS_H}px` } },
      el('span.eyebrow', { text: 'Actuator' }),
      el('span.eyebrow.gut-at#gut-at', { text: '' })));
    S.chips = new Map();
    for (const lane of lanes) {
      const row = el('div.gut-lane', { dataset: { kind: lane.kind }, style: { height: `${lane.h}px` } });
      if (lane.kind === 'events') {
        row.append(el('span.gut-name', { text: 'Milestones' }));
      } else {
        const obj = lane.kind === 'valve' ? lane.valve : lane.ctrl;
        const group = lane.kind === 'valve' ? (draft.valveGroups || []).find((g) => g.id === lane.valve?.group) : null;
        row.style.setProperty('--tick', group?.color || (lane.kind === 'bb' ? 'var(--info)' : 'var(--border-strong)'));
        row.append(
          el('span.gut-tick'),
          el('span.gut-text', {},
            el('span.gut-name', { text: obj?.name || lane.id, title: obj?.name || lane.id }),
            el('span.gut-tag', { text: lane.kind === 'bb' ? `${lane.id} · BANG-BANG` : lane.id })
          )
        );
        const chip = el('span.gut-chip');
        S.chips.set(lane.key, chip);
        row.append(chip);
      }
      gutter.append(row);
    }
    gutter.append(el('div.gut-lane.gut-add', { style: { height: `${LANE_H}px` } }, addLaneSelect(seq, lanes)));

    // ---- plot
    clear(plot);
    plot.style.width = `${W}px`;
    plot.style.height = `${H}px`;
    S.hits = [];

    // axis + grid
    const major = M.niceStep(tMax, Math.max(3, Math.floor(W / 110)));
    const minor = major / (String(major).startsWith('2') ? 4 : 5);
    const decimals = major < 0.1 ? 2 : major < 1 ? 1 : 0;
    const axis = el('div.tl-axis', { style: { height: `${AXIS_H}px` } });
    for (let t = 0; t <= tMax + 1e-9; t = M.round3(t + minor)) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      axis.append(el('i.tl-tick', { class: isMajor ? 'major' : '', style: { left: `${x(t)}px` } }));
      if (isMajor) {
        axis.append(el('span.tl-tick-l', { style: { left: `${x(t)}px` }, text: t === 0 ? 'T+0' : `${t.toFixed(decimals)}s` }));
        plot.append(el('i.tl-grid', { style: { left: `${x(t)}px`, top: `${AXIS_H}px` } }));
      }
    }
    plot.append(axis);
    // end of sequence
    plot.append(el('i.tl-endline', { style: { left: `${x(dur)}px`, top: `${AXIS_H}px` }, title: `Last step at ${M.fmtT(dur)}` }));

    // lanes
    for (const lane of lanes) {
      const row = el('div.tl-lane', { dataset: { lane: lane.key, kind: lane.kind }, style: { top: `${lane.top}px`, height: `${lane.h}px` } });
      plot.append(row);
      if (lane.kind === 'valve') drawValveLane(row, lane, sim, x, tMax);
      if (lane.kind === 'bb') drawBbLane(row, lane, sim, x, tMax);
    }
    plot.append(el('div.tl-lane.tl-add-row', { style: { top: `${addRowTop}px`, height: `${LANE_H}px` } },
      el('span.tl-hint', { text: 'Drag a step to move it · double-click a lane to add one · drag across empty space to select several' })));

    // milestone guides + labels
    const evLane = lanes[0];
    for (const p of evLayout.placed) {
      const cls = p.step.action;
      const guide = el('i.tl-guide', { dataset: { action: cls }, style: { left: `${p.px}px`, top: `${evLane.top + evLane.h}px` } });
      plot.append(guide);
    }

    // stop zone: nothing after END/ABORT runs
    if (sim.end !== null) {
      plot.append(el('div.tl-dead', {
        style: { left: `${x(sim.end)}px`, top: `${AXIS_H}px`, width: `${Math.max(0, W - x(sim.end))}px` },
        title: 'Steps here never run: the sequence has already stopped',
      }));
    }

    // step handles
    for (const [i, step] of (seq.steps || []).entries()) {
      for (const key of M.laneKeysFor(step, draft)) {
        const lane = lanes.find((l) => l.key === key);
        if (!lane) continue;
        const px = x(M.stepT(step));
        let cy = lane.top + lane.h / 2;
        let label = null;
        if (lane.kind === 'events') {
          const p = evLayout.placed.find((e) => e.step === step);
          cy = lane.top + 13 + Math.max(0, p?.row ?? 0) * 17;
          if (p && p.row >= 0) label = el('span.tl-ev-label', { class: p.flip ? 'flip' : '', text: p.text });
        }
        const handle = el('div.tl-step', {
          class: [
            S.selection.has(step) ? 'sel' : '',
            warnings.has(step) ? 'warn' : '',
            M.isUnreachable(seq, step) ? 'dead' : '',
          ].join(' '),
          dataset: {
            i: String(i),
            action: step.action,
            state: step.action === 'valve' ? step.state : step.action === 'bangbang' ? (step.enabled === undefined ? 'same' : step.enabled ? 'open' : 'closed') : '',
            lane: lane.kind,
          },
          style: { left: `${px}px`, top: `${cy}px` },
          title: `${M.fmtT(M.stepT(step))}  ${M.describe(step, draft)}${warnings.has(step) ? `\n⚠ ${warnings.get(step).join('\n⚠ ')}` : ''}`,
        }, label);
        plot.append(handle);
        S.hits.push({ step, x: px, y: cy });
      }
    }

    // overlays: cursor, pin, playhead, live, marquee, readout
    plot.append(...[
      el('i.tl-cursor.hidden'),
      el('span.tl-cursor-t.hidden'),
      S.pinT !== null ? el('i.tl-pin', { style: { left: `${x(S.pinT)}px` }, title: `Insert point ${M.fmtT(S.pinT)}` }) : null,
      el('i.tl-play', { class: S.preview ? '' : 'hidden' }),
      el('i.tl-live', { class: S.liveT === null ? 'hidden' : '' }),
      el('div.tl-marquee.hidden'),
      S.drag?.readout ? el('span.tl-readout', { style: { left: `${S.drag.readout.x}px` }, text: S.drag.readout.text }) : null,
    ].filter(Boolean));

    scroll.scrollLeft = keepScroll;
    if (S.preview) placePlayhead(S.preview.t);
    if (S.liveT !== null) placeLive(S.liveT);
    updateChips();
  }

  function drawValveLane(row, lane, sim, x, tMax) {
    const valve = lane.valve;
    const segs = sim.valves.get(lane.id) || [];
    const hazard = M.isHazard(valve);
    if (!segs.length) {
      row.append(el('i.tl-line.unknown', { style: { left: `${x(0)}px`, width: `${x(tMax) - x(0)}px` } }));
      return;
    }
    if (segs[0].from > 0) {
      row.append(el('i.tl-line.unknown', {
        style: { left: `${x(0)}px`, width: `${x(segs[0].from) - x(0)}px` },
        title: 'Before its first step this valve is wherever it was left',
      }));
    }
    segs.forEach((seg, k) => {
      const last = k === segs.length - 1;
      const from = x(seg.from);
      const to = x(seg.to);
      const cls = seg.state === 'open' ? (hazard ? 'bar open hazard' : 'bar open') : 'line';
      const node = el(`i.tl-${cls.split(' ')[0]}`, {
        class: cls.split(' ').slice(1).join(' '),
        style: { left: `${from}px`, width: `${Math.max(0, to - from)}px` },
        title: `${M.valveStateLabel(valve, seg.state)} ${M.fmtT(seg.from)} → ${M.fmtT(seg.to)} (${(seg.to - seg.from).toFixed(2)} s)${seg.implicit ? `\nset by ${seg.cause === 'pulse' ? 'the end of the momentary pulse' : seg.cause === 'safeAll' ? 'SAFE ALL' : 'ABORT STATES'}` : ''}`,
      });
      row.append(node);
      if (seg.state === 'open' && to - from > 46) {
        row.append(el('span.tl-dur', { style: { left: `${to}px` }, text: `${(seg.to - seg.from).toFixed(2)}s` }));
      }
      // After the last change the valve simply STAYS there: draw it faintly to
      // the edge, which makes "the sequence ends with this valve open" obvious.
      if (last) {
        const holdTo = x(tMax);
        if (holdTo > to) {
          row.append(el(`i.tl-${seg.state === 'open' ? 'bar' : 'line'}`, {
            class: `hold ${seg.state === 'open' ? 'open' : ''} ${hazard ? 'hazard' : ''}`,
            style: { left: `${to}px`, width: `${holdTo - to}px` },
            title: seg.state === 'open' ? `${lane.id} is still ${M.valveStateLabel(valve, 'open')} when the sequence ends` : '',
          }));
        }
      }
      if (seg.implicit) {
        row.append(el('i.tl-imp', { dataset: { cause: seg.cause }, style: { left: `${from}px` } }));
      }
      // State label right after each explicit change, if there is room before the next.
      if (!seg.implicit) {
        const next = segs[k + 1] ? x(segs[k + 1].from) : x(tMax);
        const text = M.valveStateLabel(valve, seg.state);
        if (next - from > text.length * 6 + 18) {
          row.append(el('span.tl-state', { class: seg.state === 'open' ? 'open' : '', style: { left: `${from + 9}px` }, text }));
        }
      }
    });
  }

  function drawBbLane(row, lane, sim, x, tMax) {
    const segs = sim.ctrls.get(lane.id) || [];
    if (!segs.length) {
      row.append(el('i.tl-line.unknown', { style: { left: `${x(0)}px`, width: `${x(tMax) - x(0)}px` } }));
      return;
    }
    if (segs[0].from > 0) row.append(el('i.tl-line.unknown', { style: { left: `${x(0)}px`, width: `${x(segs[0].from) - x(0)}px` } }));
    segs.forEach((seg, k) => {
      const last = k === segs.length - 1;
      const from = x(seg.from);
      const to = last ? x(tMax) : x(seg.to);
      const on = seg.state.enabled;
      row.append(el(on ? 'i.tl-bar' : 'i.tl-line', {
        class: `${on ? 'reg' : on === undefined ? 'unknown' : ''} ${last && seg.to < tMax ? 'hold-tail' : ''}`,
        style: { left: `${from}px`, width: `${Math.max(0, to - from)}px` },
        title: `${on ? 'Regulating' : on === false ? 'Off' : 'Unchanged'}${seg.state.setpoint !== undefined ? ` · SP ${seg.state.setpoint}` : ''}${seg.state.deadband !== undefined ? ` ±${seg.state.deadband}` : ''}`,
      }));
      const next = segs[k + 1] ? x(segs[k + 1].from) : x(tMax);
      const text = M.bbTokens(seg.step).join(' · ');
      if (text && next - from > text.length * 6 + 18) {
        row.append(el('span.tl-state', { class: on ? 'reg' : '', style: { left: `${from + 9}px` }, text }));
      }
    });
  }

  function addLaneSelect(seq, lanes) {
    const have = new Set(lanes.map((l) => l.key));
    const valves = (cfg().valves || []).filter((v) => !have.has(`valve:${v.id}`));
    const ctrls = (cfg().bangbang || []).filter((c) => !have.has(`bb:${c.id}`));
    return el('select.sq-add-lane', {
      title: 'Add a lane for another actuator, then double-click on it to add steps',
      onchange: (e) => {
        const key = e.target.value;
        if (!key) return;
        const list = S.extraLanes.get(seq.id) || [];
        list.push(key);
        S.extraLanes.set(seq.id, list);
        renderTimeline();
      },
    },
      el('option', { value: '', text: '+ Actuator lane', selected: '' }),
      valves.length ? el('optgroup', { label: 'Valves' }, valves.map((v) => el('option', { value: `valve:${v.id}`, text: `${v.id} · ${v.name}` }))) : null,
      ctrls.length ? el('optgroup', { label: 'Bang-bang' }, ctrls.map((c) => el('option', { value: `bb:${c.id}`, text: `${c.id} · ${c.name}` }))) : null
    );
  }

  // ---- the gutter chips: every lane's state at one moment.

  function focusTime() {
    if (S.preview) return S.preview.t;
    if (S.liveT !== null) return S.liveT;
    if (S.cursorT !== null) return S.cursorT;
    if (S.drag?.primary) return M.stepT(S.drag.primary);
    if (S.selection.size) return Math.max(...[...S.selection].map(M.stepT));
    return S.pinT;
  }

  function updateChips() {
    const t = focusTime();
    const at = q('#gut-at');
    if (at) at.textContent = t === null || t === undefined ? '' : `at ${M.fmtT(t)}`;
    for (const lane of S.lanes) {
      const chip = S.chips?.get(lane.key);
      if (!chip) continue;
      if (t === null || t === undefined) { chip.textContent = ''; chip.className = 'gut-chip'; continue; }
      const seg = M.stateAt(S.sim, lane.key, t);
      let text = '—';
      let cls = '';
      if (seg && lane.kind === 'valve') {
        text = M.valveStateLabel(lane.valve, seg.state);
        cls = seg.state === 'open' ? (M.isHazard(lane.valve) ? 'hazard' : 'open') : 'closed';
      } else if (seg && lane.kind === 'bb') {
        text = seg.state.enabled ? 'ON' : seg.state.enabled === false ? 'OFF' : '—';
        cls = seg.state.enabled ? 'reg' : 'closed';
      }
      chip.textContent = text;
      chip.className = `gut-chip ${cls}`;
    }
  }

  // ---- plot interaction

  function plotX(e) {
    return e.clientX - q('.sq-plot').getBoundingClientRect().left;
  }
  function plotY(e) {
    return e.clientY - q('.sq-plot').getBoundingClientRect().top;
  }
  function timeAtX(px) {
    return Math.max(0, (px - PAD_L) / S.geom.pps);
  }
  function snapped(t, exclude = new Set(), free = false) {
    const seq = cur();
    const magnets = free ? [] : [0, ...(seq.steps || []).filter((s) => !exclude.has(s)).map(M.stepT)];
    return M.snapTime(t, { grid: free ? 0 : S.snap, magnets, magnet: MAGNET_PX / S.geom.pps });
  }

  function wirePlot() {
    const plot = q('.sq-plot');
    const scroll = q('.sq-scroll');

    plot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const handle = e.target.closest('.tl-step');
      if (handle) {
        e.preventDefault();
        beginDrag(e, cur().steps[Number(handle.dataset.i)]);
        return;
      }
      if (!e.target.closest('select, input, button')) {
        e.preventDefault();
        beginMarquee(e);
      }
    });

    plot.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tl-step')) return;
      const lane = S.lanes.find((l) => { const y = plotY(e); return y >= l.top && y < l.top + l.h; });
      if (!lane) return;
      addStepOnLane(lane.key, snapped(timeAtX(plotX(e)), new Set(), e.altKey));
    });

    plot.addEventListener('mousemove', (e) => {
      if (!S.geom) return;
      const px = plotX(e);
      S.cursorT = snapped(timeAtX(px), new Set(), true);
      const line = q('.tl-cursor');
      const label = q('.tl-cursor-t');
      if (line && label) {
        line.classList.remove('hidden');
        label.classList.remove('hidden');
        line.style.left = `${px}px`;
        label.style.left = `${px}px`;
        label.textContent = M.fmtT(S.cursorT);
      }
      updateChips();
    });
    plot.addEventListener('mouseleave', () => {
      S.cursorT = null;
      q('.tl-cursor')?.classList.add('hidden');
      q('.tl-cursor-t')?.classList.add('hidden');
      updateChips();
    });

    scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, e.clientX);
    }, { passive: false });
  }

  function beginDrag(e, step) {
    const seq = cur();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (S.selection.has(step)) S.selection.delete(step);
      else S.selection.add(step);
      S.tab = 'step';
      renderTimeline();
      renderScript();
      renderInspector();
      return;
    }
    if (!S.selection.has(step)) selectOnly([step]);
    const before = snapshot(seq);
    const drag = {
      startX: e.clientX,
      primary: step,
      moving: new Set(S.selection),
      orig: new Map(seq.steps.map((s) => [s, M.stepT(s)])),
      geom: { ...S.geom },
      moved: false,
      readout: null,
    };
    S.drag = drag;
    renderTimeline();
    renderScript();
    renderInspector();

    const onMove = (ev) => {
      const dx = ev.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 3) return;
      drag.moved = true;
      document.body.classList.add('sq-dragging');
      const raw = drag.orig.get(step) + dx / drag.geom.pps;
      const exclude = ripple(seq)
        ? new Set(seq.steps.filter((s) => drag.moving.has(s) || drag.orig.get(s) > Math.min(...[...drag.moving].map((m) => drag.orig.get(m)))))
        : drag.moving;
      const target = snapped(raw, exclude, ev.altKey);
      const applied = M.shiftSteps(seq.steps, drag.orig, [...drag.moving], target - drag.orig.get(step), ripple(seq));
      const t = M.round3(drag.orig.get(step) + applied);
      drag.readout = {
        x: drag.geom.x(t),
        text: `${M.fmtT(t)}  ${M.fmtDelta(applied)}${ripple(seq) ? '  RIPPLE' : ''}${drag.moving.size > 1 ? `  ×${drag.moving.size}` : ''}`,
      };
      renderTimeline();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('sq-dragging');
      S.drag = null;
      const changed = drag.moved && seq.steps.some((s) => M.stepT(s) !== drag.orig.get(s));
      if (changed) {
        pushUndo(before);
        M.sortSteps(seq);
        ctx.markDirty();
      }
      renderAll();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function beginMarquee(e) {
    const x0 = plotX(e);
    const y0 = plotY(e);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Set(S.selection) : new Set();
    let moved = false;
    const box = q('.tl-marquee');

    const onMove = (ev) => {
      const x1 = plotX(ev);
      const y1 = plotY(ev);
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return;
      moved = true;
      const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
      Object.assign(box.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` });
      box.classList.remove('hidden');
      const inside = new Set(base);
      for (const h of S.hits) if (h.x >= l && h.x <= r && h.y >= t - 8 && h.y <= b + 8) inside.add(h.step);
      S.selection = inside;
      for (const node of q('.sq-plot').querySelectorAll('.tl-step')) {
        node.classList.toggle('sel', inside.has(cur().steps[Number(node.dataset.i)]));
      }
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      box?.classList.add('hidden');
      if (!moved) {
        // A click on empty space: clear the selection and pin an insert time.
        // The plot is updated in place, not rebuilt, so that the second click
        // of a double-click still lands on the lane it was aimed at.
        if (!additive) S.selection.clear();
        S.pinT = snapped(timeAtX(plotX(ev)), new Set(), ev.altKey);
        refreshPlotMarks();
      } else {
        if (S.selection.size) S.tab = 'step';
        renderTimeline();
      }
      renderScript();
      renderInspector();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Selection and insert-point marks, without rebuilding the plot. */
  function refreshPlotMarks() {
    const plot = q('.sq-plot');
    const seq = cur();
    for (const node of plot.querySelectorAll('.tl-step')) {
      node.classList.toggle('sel', S.selection.has(seq.steps[Number(node.dataset.i)]));
    }
    let pin = plot.querySelector('.tl-pin');
    if (S.pinT === null) { pin?.remove(); return; }
    if (!pin) { pin = el('i.tl-pin'); plot.append(pin); }
    pin.style.left = `${S.geom.x(S.pinT)}px`;
    pin.title = `Insert point ${M.fmtT(S.pinT)}`;
    updateChips();
  }

  // ---- playheads

  function placePlayhead(t) {
    const line = q('.tl-play');
    if (!line || !S.geom) return;
    line.classList.remove('hidden');
    line.style.left = `${S.geom.x(t)}px`;
    // Keep it on screen when zoomed in.
    const scroll = q('.sq-scroll');
    const px = S.geom.x(t);
    if (px > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = px - 80;
  }
  function placeLive(t) {
    const line = q('.tl-live');
    if (!line || !S.geom) return;
    line.classList.remove('hidden');
    line.style.left = `${S.geom.x(t)}px`;
  }

  function startPreview() {
    const seq = cur();
    if (!seq) return;
    stopPreview();
    const stop = M.stopTime(seq);
    const until = (stop ?? M.duration(seq)) + 0.4;
    S.preview = { t0: performance.now(), t: 0, raf: 0 };
    const frame = () => {
      if (!S.preview || !mounted()) return;
      const t = (performance.now() - S.preview.t0) / 1000;
      S.preview.t = t;
      placePlayhead(t);
      updateChips();
      markScriptPassed(t);
      if (t >= until) { stopPreview(); return; }
      S.preview.raf = requestAnimationFrame(frame);
    };
    S.preview.raf = requestAnimationFrame(frame);
    renderToolbar();
  }
  function stopPreview() {
    if (!S.preview) return;
    cancelAnimationFrame(S.preview.raf);
    S.preview = null;
    if (!mounted()) return;
    q('.tl-play')?.classList.add('hidden');
    markScriptPassed(null);
    updateChips();
    renderToolbar();
  }

  function onState(state) {
    if (!mounted()) return;
    const s = state?.sequence;
    const live = s?.running && s.id === S.seqId ? s.t : null;
    if (live === S.liveT) return;
    S.liveT = live;
    const line = q('.tl-live');
    if (live === null) { line?.classList.add('hidden'); markScriptPassed(null); }
    else { placeLive(live); markScriptPassed(live); }
    updateChips();
  }
  bus.on('state', onState);

  // ============================================================= script ===

  function renderScript() {
    const host = q('.sq-script');
    clear(host);
    const seq = cur();
    const draft = cfg();
    const warnings = M.lint(seq, draft);
    const steps = M.ordered(seq);

    host.append(el('div.panel-head', {},
      el('span.eyebrow', { text: 'Script' }),
      el('span.panel-sub', { text: 'what runs, in order' })
    ));

    if (!steps.length) {
      host.append(el('div.sq-note', { text: 'No steps yet. Double-click a lane on the timeline, or use + Step.' }));
      return;
    }

    const list = el('div.sc-list');
    let prevGroupT = null;
    for (let i = 0; i < steps.length;) {
      const t = M.stepT(steps[i]);
      const group = [];
      while (i < steps.length && M.stepT(steps[i]) === t) group.push(steps[i++]);
      const first = prevGroupT === null;
      const gap = first ? t : t - prevGroupT;
      prevGroupT = t;

      const allSel = group.every((s) => S.selection.has(s));
      list.append(el('button.sc-time', {
        class: allSel ? 'sel' : '',
        dataset: { t: String(t) },
        title: 'Select every step at this time',
        onclick: (e) => {
          if (e.shiftKey || e.ctrlKey) group.forEach((s) => S.selection.add(s));
          else selectOnly(group);
          S.tab = 'step';
          renderTimeline(); renderScript(); renderInspector();
          revealTime(t);
        },
      },
        el('span.sc-t', { text: M.fmtT(t) }),
        el('span.sc-gap', { text: first ? '' : M.fmtDelta(gap) })
      ));
      for (const step of group) {
        const valve = step.action === 'valve' ? valveById(step.target) : null;
        const w = warnings.get(step);
        list.append(el('div.sc-row', {
          class: [S.selection.has(step) ? 'sel' : '', M.isUnreachable(seq, step) ? 'dead' : ''].join(' '),
          dataset: { t: String(t), action: step.action, state: step.state || '' },
          onclick: (e) => {
            if (e.shiftKey || e.ctrlKey) {
              if (S.selection.has(step)) S.selection.delete(step); else S.selection.add(step);
            } else selectOnly([step]);
            S.tab = 'step';
            renderTimeline(); renderScript(); renderInspector();
            revealTime(t);
          },
        },
          el('span.sc-kind', { text: kindLabel(step) }),
          el('span.sc-what', {}, ...scriptText(step, valve)),
          w ? el('span.sc-warn', { title: w.join('\n'), html: icon('warning', 12) }) : null
        ));
      }
    }
    host.append(list);
    if (S.preview) markScriptPassed(S.preview.t);
    else if (S.liveT !== null) markScriptPassed(S.liveT);
  }

  function kindLabel(step) {
    return {
      valve: 'VALVE', bangbang: 'BB', log: 'NOTE', safeAll: 'SAFE', abortStates: 'ABORT',
      abort: 'ABORT', end: 'END',
    }[step.action] || step.action;
  }

  function scriptText(step, valve) {
    switch (step.action) {
      case 'valve':
        return [
          el('span.sc-target', { text: step.target }),
          el('span.sc-name', { text: valve?.name || '' }),
          el('span.sc-state', { class: step.state === 'open' ? (M.isHazard(valve) ? 'hazard' : 'open') : '', text: M.valveStateLabel(valve, step.state) }),
        ];
      case 'bangbang':
        return [
          el('span.sc-target', { text: step.target === '*' ? 'ALL' : step.target }),
          el('span.sc-name', { text: step.target === '*' ? 'every controller' : ctrlById(step.target)?.name || '' }),
          el('span.sc-state', { class: step.enabled ? 'reg' : '', text: M.bbTokens(step).join(' · ') || 'NO CHANGE' }),
        ];
      case 'log':
        return [el('span.sc-msg', { text: step.message || '(empty)' })];
      case 'abort':
        return [el('span.sc-state.bad', { text: 'TRIGGER ABORT' }), el('span.sc-msg', { text: step.message || '' })];
      case 'safeAll':
        return [el('span.sc-state', { text: 'SAFE ALL' }), el('span.sc-name', { text: 'every valve to its safe state' })];
      case 'abortStates':
        return [el('span.sc-state.bad', { text: 'ABORT STATES' }), el('span.sc-name', { text: 'every valve to its abort state' })];
      case 'end':
        return [el('span.sc-state', { text: 'END' }), el('span.sc-name', { text: 'sequence stops here' })];
      default:
        return [el('span', { text: step.action })];
    }
  }

  function markScriptPassed(t) {
    const host = q('.sq-script');
    if (!host) return;
    for (const node of host.querySelectorAll('[data-t]')) {
      const passed = t !== null && Number(node.dataset.t) <= t;
      node.classList.toggle('passed', passed);
    }
  }

  function revealTime(t) {
    const scroll = q('.sq-scroll');
    if (!scroll || !S.geom) return;
    const px = S.geom.x(t);
    if (px < scroll.scrollLeft + 20 || px > scroll.scrollLeft + scroll.clientWidth - 20) {
      scroll.scrollTo({ left: px - scroll.clientWidth / 2, behavior: 'smooth' });
    }
  }

  // ========================================================== inspector ===

  function renderInspector() {
    const host = q('.sq-inspector');
    clear(host);
    const seq = cur();
    const nConds = (seq.abortConditions || []).length;
    const tabs = [
      ['step', S.selection.size > 1 ? `${S.selection.size} steps` : 'Step'],
      ['sequence', 'Sequence'],
      ['aborts', `Abort conditions${nConds ? ` (${nConds})` : ''}`],
    ];
    host.append(el('div.sq-tabs', {}, tabs.map(([id, label]) => el('button', {
      class: S.tab === id ? 'active' : '',
      text: label,
      onclick: () => { S.tab = id; renderInspector(); },
    }))));
    const body = el('div.sq-insp-body');
    host.append(body);
    if (S.tab === 'sequence') body.append(...sequenceForm(seq));
    else if (S.tab === 'aborts') body.append(...abortForm(seq));
    else if (S.selection.size === 1) body.append(...stepForm(seq, [...S.selection][0]));
    else if (S.selection.size > 1) body.append(...multiForm(seq));
    else body.append(...helpPane());
  }

  function field(label, control, extra = null) {
    return el('label.sq-field', {}, el('span.eyebrow', { text: label }), el('div.sq-field-ctl', {}, control, extra));
  }

  function numInput(value, onCommit, { step = 0.01, min, max, placeholder = '', width, allowBlank = false, integer = false } = {}) {
    return el('input.cell-input.mono', {
      type: 'number', step, min, max, placeholder,
      value: value ?? '',
      style: width ? { width } : null,
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      onchange: (e) => {
        const raw = e.target.value.trim();
        if (raw === '' && allowBlank) { onCommit(undefined); return; }
        const v = Number(raw);
        const ok = raw !== '' && Number.isFinite(v)
          && (min === undefined || v >= min) && (max === undefined || v <= max)
          && (!integer || Number.isInteger(v));
        if (!ok) { e.target.value = value ?? ''; return; }
        onCommit(v);
      },
    });
  }

  /** A text input that records ONE undo point per focus, not one per key. */
  function textInput(value, onInput, attrs = {}) {
    let recorded = false;
    return el('input.cell-input', {
      type: 'text', value: value ?? '', ...attrs,
      onfocus: () => { recorded = false; },
      oninput: (e) => {
        if (!recorded) { pushUndo(); recorded = true; }
        onInput(e.target.value);
        ctx.markDirty();
      },
      onchange: () => { renderTimeline(); renderScript(); },
    });
  }

  function segCtl(items, active, onPick) {
    return el('div.seg.sq-seg', {}, items.map((it) => el('button', {
      type: 'button',
      class: `${it.value === active ? 'active' : ''} ${it.cls || ''}`,
      text: it.label,
      title: it.title,
      onclick: () => onPick(it.value),
    })));
  }

  function stepForm(seq, step) {
    const draft = cfg();
    const order = M.ordered(seq);
    const idx = order.indexOf(step);
    const prev = order[idx - 1];
    const prevT = prev ? M.stepT(prev) : 0;
    const warnings = M.lint(seq, draft).get(step);

    const setTime = (t) => edit((s) => {
      const orig = new Map(s.steps.map((x) => [x, M.stepT(x)]));
      M.shiftSteps(s.steps, orig, [step], M.round3(t) - M.stepT(step), ripple(s));
    });

    const out = [];
    out.push(el('div.sq-insp-title', {},
      el('span.eyebrow', { text: `Step ${idx + 1} of ${order.length}` }),
      el('span.sq-insp-desc', { text: M.describe(step, draft) })
    ));

    out.push(el('div.sq-row2', {},
      field('Time', numInput(M.stepT(step), (v) => setTime(v), { min: 0, step: S.snap || 0.01 }), el('span.unit', { text: 's' })),
      field(prev ? 'After previous' : 'After start', numInput(M.round3(M.stepT(step) - prevT), (v) => setTime(prevT + v), { min: 0, step: S.snap || 0.01 }),
        el('span.unit', { text: 's' }))
    ));
    if (ripple(seq)) out.push(el('div.sq-note', { text: 'RIPPLE is on: changing this time moves every later step by the same amount.' }));

    out.push(field('Action', el('select.cell-input', {
      onchange: (e) => edit(() => {
        for (const k of STEP_KEYS) delete step[k];
        Object.assign(step, newStepOfKind(e.target.value, M.stepT(step)));
      }),
    }, M.STEP_ACTIONS.map((a) => el('option', { value: a.value, selected: a.value === step.action ? '' : null, text: a.label })))));

    if (step.action === 'valve') {
      const valve = valveById(step.target);
      out.push(field('Valve', el('select.cell-input', {
        onchange: (e) => edit(() => { step.target = e.target.value; }),
      }, (draft.valves || []).map((v) => el('option', { value: v.id, selected: v.id === step.target ? '' : null, text: `${v.id} · ${v.name}` })))));
      out.push(field('Command', segCtl([
        { value: 'open', label: valve?.openLabel || 'OPEN', cls: M.isHazard(valve) ? 'hazard' : 'open' },
        { value: 'closed', label: valve?.closedLabel || 'CLOSED' },
      ], step.state, (v) => edit(() => { step.state = v; })),
      valve?.requiresArm ? el('span.sq-badge.bad', { title: 'This valve needs the stand ARMED', text: 'ARM' }) : null));
      if (valve?.momentary) {
        out.push(el('div.sq-note', { text: `Momentary: ${valve.id} closes itself ${(valve.momentaryMs || 1000) / 1000} s after it opens.` }));
      }
    }

    if (step.action === 'bangbang') {
      const ctrl = ctrlById(step.target);
      const units = ctrl ? (draft.sensors || []).find((s) => s.id === ctrl.sensor)?.units || ctrl.boardSensor?.units || '' : '';
      out.push(field('Controller', el('select.cell-input', {
        onchange: (e) => edit(() => { step.target = e.target.value; }),
      },
        el('option', { value: '*', selected: step.target === '*' ? '' : null, text: 'All controllers' }),
        (draft.bangbang || []).map((c) => el('option', { value: c.id, selected: c.id === step.target ? '' : null, text: `${c.id} · ${c.name}` }))
      )));
      out.push(field('Regulator', segCtl([
        { value: undefined, label: 'NO CHANGE' },
        { value: true, label: 'ON', cls: 'reg' },
        { value: false, label: 'OFF' },
      ], step.enabled, (v) => edit(() => { if (v === undefined) delete step.enabled; else step.enabled = v; }))));
      const opt = (key, label, unit, o = {}) => field(label,
        numInput(step[key], (v) => edit(() => { if (v === undefined) delete step[key]; else step[key] = v; }),
          { allowBlank: true, placeholder: 'no change', step: o.step ?? 1, min: o.min, max: o.max, integer: o.integer }),
        unit ? el('span.unit', { text: unit }) : null);
      out.push(el('div.sq-row2', {},
        opt('setpoint', 'Setpoint', units),
        opt('deadband', 'Deadband ±', units)));
      out.push(el('div.sq-row2', {},
        opt('maxOpenMs', 'Max open', 'ms', { min: 0, max: 120000, integer: true }),
        opt('minIntervalMs', 'Dwell', 'ms', { min: 0, max: 120000, integer: true })));
      out.push(el('div.sq-note', { text: 'Blank leaves a setting as it is. 0 ms = no limit.' }));
    }

    if (step.action === 'log' || step.action === 'abort') {
      out.push(field(step.action === 'abort' ? 'Abort reason' : 'Message',
        textInput(step.message, (v) => { step.message = v; }, {
          placeholder: step.action === 'abort' ? 'Shown in the log' : 'Written to the event log and the CSV',
          'data-focus': 'message',
        })));
    }

    if (['safeAll', 'abortStates', 'end'].includes(step.action)) {
      out.push(el('div.sq-note', { text: M.STEP_ACTIONS.find((a) => a.value === step.action)?.hint }));
    }

    if (warnings) {
      out.push(el('div.sq-warnings', {}, warnings.map((w) => el('div', { html: `${icon('warning', 12)} ` }, w))));
    }

    out.push(el('div.sq-insp-actions', {},
      el('button.btn.sm', { text: 'Duplicate', title: 'Ctrl+D', onclick: duplicateSelection }),
      el('button.btn.sm.danger', { text: 'Delete', title: 'Delete key', onclick: deleteSelection })
    ));
    return out;
  }

  function multiForm(seq) {
    const sel = M.ordered(seq).filter((s) => S.selection.has(s));
    const t0 = M.stepT(sel[0]);
    const t1 = M.stepT(sel[sel.length - 1]);
    let delta = 0;
    return [
      el('div.sq-insp-title', {},
        el('span.eyebrow', { text: `${sel.length} steps selected` }),
        el('span.sq-insp-desc', { text: t0 === t1 ? `all at ${M.fmtT(t0)}` : `${M.fmtT(t0)} to ${M.fmtT(t1)}` })),
      el('div.sq-mini-list', {}, sel.map((s) => el('div', {},
        el('span.sc-t', { text: M.fmtT(M.stepT(s)) }), ' ', M.describe(s, cfg())))),
      el('div.sq-row2', {},
        field('Move to', numInput(t0, (v) => edit((q2) => {
          const orig = new Map(q2.steps.map((x) => [x, M.stepT(x)]));
          M.shiftSteps(q2.steps, orig, sel, v - t0, ripple(q2));
        }), { min: 0, step: S.snap || 0.01 }), el('span.unit', { text: 's' })),
        field('Shift by', el('div.sq-inline', {},
          numInput('', (v) => { delta = v; }, { step: S.snap || 0.01, placeholder: '±0.00' }),
          el('button.btn.sm', {
            text: 'Apply',
            onclick: () => {
              if (!delta) return;
              edit((q2) => {
                const orig = new Map(q2.steps.map((x) => [x, M.stepT(x)]));
                M.shiftSteps(q2.steps, orig, sel, delta, ripple(q2));
              });
            },
          })))),
      el('div.sq-note', { text: 'Drag any selected step to move them together. Arrow keys nudge by the snap step, with Shift ×10.' }),
      el('div.sq-insp-actions', {},
        el('button.btn.sm', { text: 'Duplicate', onclick: duplicateSelection }),
        el('button.btn.sm.danger', { text: `Delete ${sel.length}`, onclick: deleteSelection }))
    ];
  }

  function helpPane() {
    const k = (keys, what) => el('div.sq-key', {}, el('span', {}, keys.map((x) => el('kbd', { text: x }))), el('span', { text: what }));
    return [
      el('div.sq-insp-title', {}, el('span.eyebrow', { text: 'Nothing selected' }),
        el('span.sq-insp-desc', { text: 'Click a step on the timeline or in the script to edit it.' })),
      el('div.sq-keys', {},
        k(['Drag'], 'move a step; Alt to ignore the snap'),
        k(['Double-click'], 'add a step on that lane'),
        k(['Drag', 'empty'], 'box-select several steps'),
        k(['Shift', 'Click'], 'add to the selection'),
        k(['←', '→'], 'nudge by the snap step (Shift ×10)'),
        k(['Del'], 'delete the selection'),
        k(['Ctrl', 'D'], 'duplicate the selection'),
        k(['Ctrl', 'Z'], 'undo; Ctrl+Y redoes'),
        k(['Ctrl', 'Wheel'], 'zoom the timeline'),
        k(['Space'], 'play / stop the preview'),
        k(['Click', 'empty'], 'clear the selection and pin an insert time')
      ),
    ];
  }

  function sequenceForm(seq) {
    const draft = cfg();
    const toggle = (label, value, onChange, hint) => el('label.toggle', { title: hint || '' },
      el('input', { type: 'checkbox', checked: value ? '' : null, onchange: (e) => onChange(e.target.checked) }),
      el('span.track'),
      el('span', { text: label }));

    const out = [
      el('div.sq-row2', {},
        field('Name', textInput(seq.name, (v) => { seq.name = v; renderPicker(); const n = q('.sq-name'); if (n) n.value = v; })),
        field('Short label', textInput(seq.abbrev, (v) => { seq.abbrev = v; }, { title: 'Shown on the RUN button in the confirm dialog' }))
      ),
      field('Button style', el('div.sq-styles', {}, STYLES.map((s) => el('button', {
        type: 'button',
        class: (seq.style || 'normal') === s.value ? 'active' : '',
        dataset: { style: s.value },
        onclick: () => { seq.style = s.value; ctx.markDirty(); renderPicker(); renderHead(); renderInspector(); },
      }, el('span.sq-dot'), s.label)))),
      field('Description', el('textarea.cell-input', {
        rows: 3,
        value: seq.description || '',
        placeholder: 'Shown on hover and in the confirm dialog',
        oninput: (e) => { seq.description = e.target.value; ctx.markDirty(); },
      })),
      el('div.sq-toggles', {},
        toggle('Requires ARM', seq.requiresArm !== false, (v) => { seq.requiresArm = v; ctx.markDirty(); renderAll(); }),
        toggle('Confirm before running', seq.confirm !== false, (v) => { seq.confirm = v; ctx.markDirty(); renderHead(); }),
        toggle('Hide from sidebar', seq.hidden === true, (v) => { seq.hidden = v; ctx.markDirty(); renderPicker(); renderHead(); }),
        toggle('Use Panda Autosequencer', seq.usePandaAutosequencer === true, (v) => {
          seq.usePandaAutosequencer = v; ctx.markDirty(); renderAll();
        })
      ),
    ];
    if (draft.safety?.abortSequenceId === seq.id) {
      out.push(el('div.inline-note', {}, el('span', { html: icon('warning', 13) }), 'This is the abort sequence (safety.abortSequenceId). It runs automatically on ABORT.'));
    }
    if (seq.usePandaAutosequencer) {
      out.push(el('div.sq-panda', {},
        el('button.btn', {
          text: 'Send autosequence config to Panda',
          onclick: async (e) => {
            if (ctx.isDirty()) { toast('Save & Apply your changes before sending the config to Panda', 'warn'); return; }
            const button = e.currentTarget;
            button.disabled = true;
            button.textContent = 'Waiting for Panda…';
            try {
              const result = await bus.post('/api/sequence/panda/config', { id: seq.id });
              if (result.ok) toast(`Panda confirmed the config for ${seq.name}`, 'ok');
            } finally {
              button.disabled = false;
              button.textContent = 'Send autosequence config to Panda';
            }
          },
        }),
        el('p', { text: 'Save & Apply, then send before running. Panda stores one sequence at a time and runs valve steps only; momentary actuators use the GC sequencer. Run requires ARM. Stop disarms and safes the stand. GC still checks the abort conditions.' })
      ));
    }
    return out;
  }

  function abortForm(seq) {
    const draft = cfg();
    seq.abortConditions ??= [];
    const out = [el('div.sq-note', { text: 'Checked every control tick while this sequence runs. Any trip aborts the stand at once.' })];
    seq.abortConditions.forEach((cond, i) => {
      const sensor = (draft.sensors || []).find((s) => s.id === cond.sensor);
      const change = (fn) => { pushUndo(); fn(); ctx.markDirty(); renderInspector(); };
      out.push(el('div.sq-cond', {},
        el('div.sq-cond-row', {},
          el('select.cell-input', {
            onchange: (e) => change(() => { cond.sensor = e.target.value; }),
          }, (draft.sensors || []).map((s) => el('option', { value: s.id, selected: s.id === cond.sensor ? '' : null, text: `${s.id} · ${s.name}` }))),
          el('select.cell-input.mono.sq-op', {
            onchange: (e) => change(() => { cond.op = e.target.value; }),
          }, ['>', '<', '>=', '<='].map((op) => el('option', { value: op, selected: op === cond.op ? '' : null, text: op }))),
          numInput(cond.value ?? 0, (v) => change(() => { cond.value = v; }), { step: 'any', width: '84px' }),
          el('span.unit', { text: sensor?.units || '' }),
          el('button.mini-btn.danger', { title: 'Delete condition', text: '✕', onclick: () => change(() => seq.abortConditions.splice(i, 1)) })
        ),
        textInput(cond.message, (v) => { cond.message = v; }, { placeholder: 'Message in the log when it trips' })
      ));
    });
    if (!seq.abortConditions.length) {
      out.push(el('div.sq-note.dim', { text: 'None. The sequence runs to completion whatever the sensors read.' }));
    }
    out.push(el('button.btn.sm', {
      text: '+ Add condition',
      onclick: () => {
        pushUndo();
        const first = draft.sensors?.[0];
        seq.abortConditions.push({ sensor: first?.id, op: '>', value: first?.dangerHigh ?? first?.max ?? 0, message: '' });
        ctx.markDirty();
        renderInspector();
      },
    }));
    return out;
  }

  // =========================================================== keyboard ===
  // Escape is deliberately NOT bound here: it is the station-wide ABORT key
  // (chrome.js), on every page, including this one. An editor that taught
  // "press Esc to deselect" would be teaching operators to abort the stand.

  document.addEventListener('keydown', (e) => {
    if (!mounted() || !cur()) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectOnly([...cur().steps]);
      renderTimeline(); renderScript(); renderInspector();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (S.selection.size) { e.preventDefault(); deleteSelection(); } return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.selection.size) {
      e.preventDefault();
      const unit = (S.snap || 0.01) * (e.shiftKey ? 10 : 1);
      nudge(e.key === 'ArrowLeft' ? -unit : unit);
    }
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      if (S.preview) stopPreview(); else startPreview();
    }
  });

  return { mount, reset };
}
