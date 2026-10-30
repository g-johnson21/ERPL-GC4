/* channel-editor.js — the Config page's Channels tab.
 *
 * Every instrument and actuator on the stand, laid out the way the screens
 * that show them lay them out: one column per group, in order. Sensors are the
 * Data page's columns; valves are the Control Grid's sections. Dragging a card
 * moves it on that screen — up and down within its group, or across into
 * another — and dragging a column header moves the whole group.
 *
 * Clicking a card opens it in the inspector on the right: its name, which tab
 * it sits in, its range, and the hardware channel it is wired to. Wiring edits
 * land in the hardware file (config/hardware*.json) through wiring-model.js,
 * and go out with the same Save & Apply as everything else on this page.
 *
 * Nothing here is saved by itself. It edits the page's draft and its wiring
 * draft; the server validates both together and refuses a rewire while armed.
 */
import { el, clear, icon, toast, confirmAction } from './util.js';
import {
  inventory, sourceOf, sourceLabel, sensorOn, setSensorSource, setValveChannel,
  renameInWiring, removeFromWiring, freeSensorChannel, syncNiSpan, niSpan, hasNiSpan,
  inputsFor, suits, tcType, setTcType, KIND_DEFAULTS, TC_TYPES, DC_CHANNELS,
} from './wiring-model.js';

const SENSOR_KINDS = ['pressure', 'temperature', 'force', 'flow', 'level', 'voltage', 'other'];
const VALVE_TYPES = ['solenoid', 'ball', 'butterfly', 'needle', 'igniter', 'motor'];
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** `icon()` returns markup; as an `el` child it would be text. */
const glyph = (name, size) => el('span.ch-glyph', { html: icon(name, size) });

/**
 * @param getDraft    () => the stand config draft
 * @param getWiring   () => { available, live, file, hardware } (hardware is the draft)
 * @param markDirty   () => void
 */
export function createChannelEditor({ getDraft, getWiring, markDirty }) {
  let view = 'sensors';           // 'sensors' | 'valves'
  let selected = null;            // id of the card in the inspector
  /** Ids added since the last save: only these may be renamed. */
  const fresh = new Set();
  let host = null;
  let drag = null;                // { kind: 'item'|'group', id }

  // ------------------------------------------------------------- model --

  const items = () => (view === 'sensors' ? getDraft().sensors : getDraft().valves);
  const groupsKey = () => (view === 'sensors' ? 'sensorGroups' : 'valveGroups');
  const hw = () => getWiring()?.hardware ?? null;

  /**
   * The columns, in screen order: every defined group, then any group an item
   * names but the config never defined — the Data page and the Control Grid
   * both show those as a column of their own, so this does too.
   */
  function columns() {
    const draft = getDraft();
    const defined = (draft[groupsKey()] ??= []);
    const cols = defined.map((g) => ({ ...g, defined: true, items: [] }));
    const byId = new Map(cols.map((c) => [c.id, c]));
    for (const item of items()) {
      let col = byId.get(item.group);
      if (!col) {
        col = { id: item.group, label: item.group || 'Other', color: '#64748b', defined: false, items: [] };
        byId.set(col.id, col);
        cols.push(col);
      }
      col.items.push(item);
    }
    return cols;
  }

  function changed() {
    markDirty();
    render();
  }

  /** Move an item into `groupId`, just before `beforeId` (or to the group's end). */
  function moveItem(id, groupId, beforeId) {
    const list = items();
    const from = list.findIndex((x) => x.id === id);
    if (from < 0 || id === beforeId) return;
    const [item] = list.splice(from, 1);
    item.group = groupId;
    let to = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
    if (to < 0) {
      // End of its group: after the group's last member, so array order and
      // screen order agree even before anything else is reordered.
      const last = list.map((x) => x.group).lastIndexOf(groupId);
      to = last < 0 ? list.length : last + 1;
    }
    list.splice(to, 0, item);
    changed();
  }

  /** Reorder columns. An undefined group gets defined on the way, so it can hold a place. */
  function moveGroup(id, beforeId) {
    const draft = getDraft();
    const groups = draft[groupsKey()];
    if (!groups.some((g) => g.id === id)) groups.push({ id, label: id, color: '#64748b' });
    const from = groups.findIndex((g) => g.id === id);
    const [g] = groups.splice(from, 1);
    let to = beforeId ? groups.findIndex((x) => x.id === beforeId) : -1;
    if (to < 0) to = groups.length;
    groups.splice(to, 0, g);
    changed();
  }

  /** Every id in use, board transducers included: they share the sensor namespace on screen. */
  function takenIds() {
    const draft = getDraft();
    return new Set([
      ...draft.sensors.map((x) => x.id),
      ...draft.valves.map((x) => x.id),
      ...(draft.bangbang || []).map((b) => b.boardSensor?.id).filter(Boolean),
    ]);
  }

  function uniqueId(prefix) {
    const taken = takenIds();
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  function addItem(groupId) {
    const draft = getDraft();
    let item;
    if (view === 'sensors') {
      // The column's own kind: "Add sensor" under Thermocouples makes a
      // thermocouple, not a PT to be converted by hand.
      const kind = commonKind(draft.sensors.filter((x) => x.group === groupId));
      const d = KIND_DEFAULTS[kind];
      const id = uniqueId(d.prefix);
      item = {
        id, name: 'New sensor', abbrev: id, kind, group: groupId, units: d.units,
        channel: freeSensorChannel(draft, id, 900), decimals: d.decimals, min: d.min, max: d.max,
        calibration: { slope: 1, offset: 0 },
      };
      draft.sensors.push(item);
    } else {
      const id = uniqueId('V');
      const used = new Set(draft.valves.map((v) => v.channel));
      let ch = 1;
      while (used.has(ch)) ch++;
      item = {
        id, name: 'New valve', abbrev: 'New valve', group: groupId, type: 'solenoid', channel: ch,
        normallyOpen: false, requiresArm: true, momentary: false, momentaryMs: 1000,
        openLabel: 'OPEN', closedLabel: 'CLOSED', safeState: 'closed', abortState: 'closed',
      };
      draft.valves.push(item);
      // Tie its current sense to the channel it landed on.
      if (ch <= DC_CHANNELS && hw()) setValveChannel(draft, hw(), id, ch);
    }
    // Appended at the end of the array; move it to the end of its column.
    moveItem(item.id, groupId, null);
    fresh.add(item.id);
    selected = item.id;
    render();
    host?.querySelector('.ch-inspector input')?.select();
  }

  /** The most common kind among some sensors; pressure for none. */
  function commonKind(list) {
    const counts = new Map();
    for (const x of list) counts.set(x.kind, (counts.get(x.kind) || 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return KIND_DEFAULTS[best] ? best : 'pressure';
  }

  /**
   * Change what a sensor measures, and carry everything that depends on it.
   *
   * Units and range follow the kind when they are still the old kind's
   * defaults (a value someone typed is theirs and stays). The wiring follows
   * too: an input that cannot carry the new kind is swapped for the first
   * free one that can, on the same device if it has one.
   */
  function changeKind(s, kind) {
    const draft = getDraft();
    const before = KIND_DEFAULTS[s.kind] ?? KIND_DEFAULTS.other;
    const after = KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.other;
    const isNew = fresh.has(s.id);
    if (isNew || !s.units || s.units === before.units) s.units = after.units;
    if (isNew || (s.min === before.min && s.max === before.max)) { s.min = after.min; s.max = after.max; }
    if (isNew) s.decimals = after.decimals;
    s.kind = kind;

    // A new sensor still named by its old kind's prefix takes the new one.
    if (isNew && s.id.startsWith(before.prefix) && /^\d+$/.test(s.id.slice(before.prefix.length))) {
      const next = uniqueId(after.prefix);
      if (hw()) renameInWiring(hw(), s.id, next);
      if (s.abbrev === s.id) s.abbrev = next;
      fresh.delete(s.id);
      fresh.add(next);
      if (selected === s.id) selected = next;
      s.id = next;
    }

    const src = hw() && sourceOf(hw(), s.id);
    if (src && !suits(src.key, kind)) {
      const options = inputsFor(inventory(hw()), kind);
      const order = [...options.filter((d) => d.device === src.device), ...options.filter((d) => d.device !== src.device)];
      let free = null;
      for (const d of order) {
        const i = d.inputs.find((x) => !sensorOn(hw(), d.device, x.key));
        if (i) { free = { device: d.device, key: i.key }; break; }
      }
      setSensorSource(draft, hw(), s.id, free);
      toast(free
        ? `${s.id} moved to ${sourceLabel(free)} — ${sourceLabel(src)} cannot carry a ${kind} sensor`
        : `${s.id} unwired — no free input can carry a ${kind} sensor`, free ? 'info' : 'warn', 6000);
    }
    commit();
  }

  async function deleteItem(item) {
    const draft = getDraft();
    // Where else the id appears. The validator would refuse the save anyway;
    // this says so before the click rather than after it.
    const others = Object.entries(draft)
      .filter(([k]) => k !== 'sensors' && k !== 'valves' && k !== 'sensorGroups' && k !== 'valveGroups')
      .filter(([, v]) => JSON.stringify(v ?? null).includes(`"${item.id}"`))
      .map(([k]) => k);
    const ok = await confirmAction({
      title: `Delete ${item.id}?`,
      message: others.length
        ? `${item.name} is still referenced in: ${others.join(', ')}. Those references will need fixing before the configuration will save.`
        : `${item.name} is removed from the ${view === 'sensors' ? 'Data page' : 'Control Grid'} and its wiring is cleared.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const list = items();
    list.splice(list.indexOf(item), 1);
    if (hw()) removeFromWiring(hw(), item.id);
    fresh.delete(item.id);
    selected = null;
    changed();
  }

  function addGroup() {
    const groups = getDraft()[groupsKey()];
    const taken = new Set(groups.map((g) => g.id));
    let n = 1;
    while (taken.has(`group${n}`)) n++;
    groups.push({ id: `group${n}`, label: `New group ${n}`, color: '#64748b' });
    changed();
    const inputs = host?.querySelectorAll('.ch-col-label');
    inputs?.[inputs.length - 1]?.select();
  }

  // -------------------------------------------------------------- view --

  function mount(target) {
    host = target;
    render();
  }

  function render() {
    if (!host) return;
    clear(host);
    const wiring = getWiring();
    const cols = columns();
    if (selected && !items().some((x) => x.id === selected)) selected = null;

    host.append(el('div.ch-editor', {},
      el('div.ch-toolbar', {},
        el('div.seg', {},
          el('button', { type: 'button', class: view === 'sensors' ? 'active' : '', text: `Sensors · Data page (${getDraft().sensors.length})`, onclick: () => { view = 'sensors'; selected = null; render(); } }),
          el('button', { type: 'button', class: view === 'valves' ? 'active' : '', text: `Valves · Control Grid (${getDraft().valves.length})`, onclick: () => { view = 'valves'; selected = null; render(); } })
        ),
        el('span.ch-hint', {
          text: 'Drag cards to reorder or move them between groups; drag a group\'s header to move the column.',
        }),
        el('span.ch-wiring', {
          title: wiring?.available
            ? (wiring.live
              ? 'Saving a wiring change restarts the NI-DAQ and PANDA links and puts every actuator in its safe state. Refused while ARMED.'
              : 'This server is not driving the real stand, so wiring changes are saved to the file and take effect when it is.')
            : 'No wiring file was found for this stand, so hardware channels cannot be set here.',
        },
          glyph('schematic', 13),
          el('span', { text: wiring?.available ? `${wiring.file}${wiring.live ? ' · live' : ''}` : 'no wiring file' }))
      ),
      el('div.ch-body', {},
        board(cols),
        inspector()
      )
    ));
  }

  function board(cols) {
    const wrap = el('div.ch-board');
    for (const col of cols) wrap.append(column(col));
    wrap.append(el('button.ch-add-group', { type: 'button', onclick: addGroup }, glyph('plus', 14), 'Group'));
    return wrap;
  }

  function column(col) {
    const groups = getDraft()[groupsKey()];
    const def = groups.find((g) => g.id === col.id);
    const ensure = () => {
      if (def) return def;
      const g = { id: col.id, label: col.label, color: col.color };
      groups.push(g);
      return g;
    };

    const list = el('div.ch-list', { dataset: { group: col.id } }, col.items.map(card));

    return el('section.ch-col', { dataset: { group: col.id }, style: { '--group-color': col.color || '#64748b' } },
      el('header.ch-col-head', {
        title: 'Drag to move this group',
        onpointerdown: (e) => pressDrag(e, 'group', col.id),
      },
        el('span.ch-grip', { text: '⋮⋮' }),
        el('input.ch-col-color', {
          type: 'color', value: col.color || '#64748b', title: 'Group colour',
          onchange: (e) => { ensure().color = e.target.value; changed(); },
        }),
        el('input.ch-col-label', {
          type: 'text', value: col.label, 'aria-label': 'Group name',
          onchange: (e) => { ensure().label = e.target.value.trim() || col.id; changed(); },
        }),
        el('span.ch-col-count', { text: String(col.items.length) }),
        col.items.length || !def ? null : el('button.ch-x', {
          type: 'button', text: '✕', title: 'Delete this empty group',
          onclick: () => { groups.splice(groups.indexOf(def), 1); changed(); },
        })
      ),
      list,
      el('button.ch-add', { type: 'button', onclick: () => addItem(col.id) },
        glyph('plus', 13), view === 'sensors' ? 'Add sensor' : 'Add valve')
    );
  }

  function card(item) {
    const wiring = view === 'sensors' ? sourceLabel(sourceOf(hw(), item.id)) : `DC${item.channel}`;
    const unwired = view === 'sensors' && getWiring()?.available && !sourceOf(hw(), item.id);
    return el('div.ch-card', {
      class: item.id === selected ? 'selected' : '',
      dataset: { id: item.id },
      onclick: () => { selected = item.id; render(); },
      onpointerdown: (e) => pressDrag(e, 'item', item.id),
    },
      el('div.ch-card-name', { text: item.name || item.id, title: item.name }),
      el('div.ch-card-sub', {},
        el('span.ch-card-id', { text: item.id }),
        el('span.ch-card-wire', { class: unwired ? 'unwired' : '', text: unwired ? 'not wired' : wiring }))
    );
  }

  // --------------------------------------------------------- drag & drop --
  //
  // Pointer events rather than HTML5 drag and drop: the native kind does
  // nothing on a touchscreen, and a pad laptop is often one. A press only
  // becomes a drag once it has moved a few pixels, so a tap is still a click.

  function pressDrag(e, kind, id) {
    if (e.button !== 0 || e.target.closest('input, select, button')) return;
    const node = e.currentTarget.closest(kind === 'item' ? '.ch-card' : '.ch-col');
    drag = { kind, id, node, x0: e.clientX, y0: e.clientY, active: false, ghost: null };
    window.addEventListener('pointermove', moveDrag);
    window.addEventListener('pointerup', dropDrag, { once: true });
    window.addEventListener('pointercancel', cancelDrag, { once: true });
  }

  function moveDrag(e) {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      drag.active = true;
      // A copy follows the pointer; the original stays, dimmed, so it is
      // clear what is being moved and where it came from.
      const r = drag.node.getBoundingClientRect();
      drag.dx = drag.x0 - r.left;
      drag.dy = drag.y0 - r.top;
      drag.ghost = drag.node.cloneNode(true);
      drag.ghost.classList.add('ch-ghost');
      drag.ghost.style.width = `${r.width}px`;
      drag.ghost.style.setProperty('--group-color', getComputedStyle(drag.node).getPropertyValue('--group-color'));
      if (drag.kind === 'group') drag.ghost.style.maxHeight = '220px';
      document.body.append(drag.ghost);
      drag.node.classList.add('dragging');
      document.body.classList.add('ch-dragging');
    }
    e.preventDefault();
    drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;

    const board = host.querySelector('.ch-board');
    autoScroll(board, e.clientX);
    if (drag.kind === 'item') {
      const list = listAt(e.clientX);
      if (list) showItemMarker(list, e.clientY);
    } else {
      showGroupMarker(board, e.clientX);
    }
  }

  function dropDrag() {
    const d = drag;
    if (!d?.active) { cancelDrag(); return; }
    const marker = host.querySelector('.ch-marker, .ch-col-marker');
    const list = marker?.closest('.ch-list');
    const before = marker?.nextElementSibling;
    cancelDrag();
    // The click that follows this pointerup would otherwise select whatever
    // card the drop landed on.
    window.addEventListener('click', swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
    if (!marker) return;
    if (d.kind === 'item' && list) moveItem(d.id, list.dataset.group, before?.dataset?.id ?? null);
    else if (d.kind === 'group') moveGroup(d.id, before?.dataset?.group ?? null);
  }

  function swallowClick(e) { e.stopPropagation(); e.preventDefault(); }

  function cancelDrag() {
    window.removeEventListener('pointermove', moveDrag);
    drag?.ghost?.remove();
    drag = null;
    document.body.classList.remove('ch-dragging');
    host?.querySelectorAll('.ch-marker, .ch-col-marker').forEach((m) => m.remove());
    host?.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  }

  /** The column list under the pointer, or the nearest one within a short reach of it. */
  function listAt(x) {
    let best = null, bestD = Infinity;
    for (const list of host.querySelectorAll('.ch-list')) {
      const r = list.closest('.ch-col').getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < bestD) { best = list; bestD = d; }
    }
    return bestD < 60 ? best : null;
  }

  /** Scroll the board sideways while dragging near its edges, so every column is reachable. */
  function autoScroll(board, x) {
    const r = board.getBoundingClientRect();
    if (x < r.left + 40) board.scrollLeft -= 12;
    else if (x > r.right - 40) board.scrollLeft += 12;
  }

  /** A line where the card will land: before the first card whose middle is below the pointer. */
  function showItemMarker(list, y) {
    host.querySelectorAll('.ch-marker').forEach((m) => { if (m.parentNode !== list) m.remove(); });
    const marker = list.querySelector('.ch-marker') || el('div.ch-marker');
    const cards = [...list.querySelectorAll('.ch-card:not(.dragging)')];
    const before = cards.find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (before) { if (marker.nextElementSibling !== before) list.insertBefore(marker, before); }
    else if (list.lastElementChild !== marker) list.append(marker);
  }

  function showGroupMarker(wrap, x) {
    const marker = wrap.querySelector('.ch-col-marker') || el('div.ch-col-marker');
    const cols = [...wrap.querySelectorAll('.ch-col:not(.dragging)')];
    const before = cols.find((c) => { const r = c.getBoundingClientRect(); return x < r.left + r.width / 2; });
    const anchor = before || wrap.querySelector('.ch-add-group');
    if (marker.nextElementSibling !== anchor) wrap.insertBefore(marker, anchor);
  }

  // ---------------------------------------------------------- inspector --

  function inspector() {
    const item = items().find((x) => x.id === selected);
    if (!item) {
      return el('aside.ch-inspector.empty', {},
        el('p', { text: `Select a ${view === 'sensors' ? 'sensor' : 'valve'} to edit its name, group, range and wiring.` }));
    }
    return el('aside.ch-inspector', {},
      el('div.ch-insp-head', {},
        el('span.ch-insp-id', { text: item.id }),
        el('span.ch-insp-name', { text: item.name }),
        el('button.btn.sm.danger', { type: 'button', style: { marginLeft: 'auto' }, onclick: () => deleteItem(item) }, 'Delete')
      ),
      view === 'sensors' ? sensorFields(item) : valveFields(item)
    );
  }

  /** One labelled row; `edit` runs on change and the inspector redraws. */
  function field(label, control, hint) {
    return el('label.ch-field', {},
      el('span.ch-field-label', { text: label }),
      control,
      hint ? el('span.ch-field-hint', { text: hint }) : null);
  }

  const commit = () => changed();

  function text(value, onChange, opts = {}) {
    return el('input', {
      type: 'text', value: value ?? '', class: opts.mono ? 'mono' : '', placeholder: opts.placeholder || '',
      onchange: (e) => onChange(e.target.value),
    });
  }

  function num(value, onChange, opts = {}) {
    return el('input.mono', {
      type: 'number', step: opts.step ?? 'any', value: Number.isFinite(value) ? String(value) : '',
      min: opts.min, max: opts.max,
      onchange: (e) => {
        const v = e.target.valueAsNumber;
        if (Number.isFinite(v)) onChange(v);
        else e.target.value = Number.isFinite(value) ? String(value) : '';
      },
    });
  }

  function select(options, value, onChange) {
    return el('select', { onchange: (e) => onChange(e.target.value) },
      options.map(([v, label]) => el('option', { value: v, text: label, selected: v === value })));
  }

  function check(value, onChange, label) {
    return el('span.ch-check', {},
      el('input', { type: 'checkbox', checked: Boolean(value), onchange: (e) => onChange(e.target.checked) }),
      el('span', { text: label }));
  }

  function groupSelect(item) {
    return select(columns().map((c) => [c.id, c.label]), item.group, (g) => moveItem(item.id, g, null));
  }

  /** The id: editable only while the item is new, because everything else names it by id. */
  function idField(item) {
    if (!fresh.has(item.id)) {
      return field('ID', el('input.mono', { type: 'text', value: item.id, disabled: true }),
        'Fixed once saved: sequences, alerts and the P&ID refer to it by this.');
    }
    return field('ID', text(item.id, (v) => {
      const next = v.trim();
      const taken = next !== item.id && takenIds().has(next);
      if (!ID_RE.test(next) || taken) {
        toast(taken ? `${next} is already in use` : 'Letters, digits, - and _ only', 'error');
        render();
        return;
      }
      if (hw()) renameInWiring(hw(), item.id, next);
      if (item.abbrev === item.id) item.abbrev = next;
      fresh.delete(item.id);
      fresh.add(next);
      if (selected === item.id) selected = next;
      item.id = next;
      commit();
    }, { mono: true }), 'Letters, digits, - and _. Can be changed until saved.');
  }

  /** Name and the short label that follows it unless someone set that one apart. */
  function nameField(item) {
    return field('Name', text(item.name, (v) => {
      const name = v.trim() || item.id;
      if (!item.abbrev || item.abbrev === item.name) item.abbrev = name;
      item.name = name;
      commit();
    }));
  }

  function sensorFields(s) {
    const draft = getDraft();
    const wiring = getWiring();
    const pt = s.kind === 'pressure';
    const src = sourceOf(hw(), s.id);
    const span = pt ? niSpan(hw(), s.id) : null;
    const rangeLabel = { pressure: 'PT range', temperature: 'Display range', force: 'Load range' }[s.kind] ?? 'Range';

    const rows = [
      nameField(s),
      idField(s),
      field('Group (Data page column)', groupSelect(s)),
      el('div.ch-row2', {},
        field('Kind', select(SENSOR_KINDS.map((k) => [k, k]), s.kind, (v) => changeKind(s, v))),
        field('Units', text(s.units, (v) => { s.units = v.trim(); commit(); }, { mono: true }))),
      el('div.ch-row2', {},
        field(`${rangeLabel} min`, num(s.min, (v) => { s.min = v; commit(); })),
        field(`${rangeLabel} max`, num(s.max, (v) => {
          s.max = v;
          if (hw()) syncNiSpan(hw(), s);
          commit();
        }))),
    ];
    if (span && Number.isFinite(span.maxPsi) && span.maxPsi !== s.max) {
      rows.push(el('div.ch-note.warn', {},
        `The NI channel's 4–20 mA span is ${span.maxPsi} psi, not ${s.max}. `,
        el('button.btn.sm', { type: 'button', text: `Use ${s.max}`, onclick: () => { syncNiSpan(hw(), s); commit(); } })));
    } else if (pt && hasNiSpan(src)) {
      rows.push(el('div.ch-note', { text: `PT range max is also the NI channel's 4–20 mA span (20 mA = ${s.max} psi).` }));
    } else if (s.kind === 'temperature') {
      rows.push(el('div.ch-note', { text: 'The thermocouple card reports temperature directly; the range only scales the trend and the bar.' }));
    }
    rows.push(field('Decimals', num(s.decimals, (v) => { s.decimals = Math.max(0, Math.min(6, Math.round(v))); commit(); }, { step: 1, min: 0, max: 6 })));

    if (wiring?.available) {
      // Only the inputs that can carry this kind: TC channels for a
      // thermocouple, the bridge card for a load cell.
      const all = inventory(hw());
      const devices = inputsFor(all, s.kind);
      const device = src?.device ?? '';
      const deviceOptions = devices.map((d) => [d.device, d.label]);
      // Wiring made before this rule (or by hand) is still shown, flagged,
      // rather than silently looking unwired.
      if (device && !deviceOptions.some(([d]) => d === device)) {
        deviceOptions.push([device, `${all.find((d) => d.device === device)?.label ?? device} (unsuitable)`]);
      }
      const deviceSel = select([['', 'Not wired'], ...deviceOptions], device, (d) => {
        if (!d) { setSensorSource(draft, hw(), s.id, null); commit(); return; }
        // Pick the first free input on that device rather than leaving the
        // sensor half-wired with no channel chosen.
        const free = devices.find((x) => x.device === d)?.inputs.find((i) => !sensorOn(hw(), d, i.key));
        if (!free) { toast(`No free ${s.kind} input on that device`, 'error'); render(); return; }
        setSensorSource(draft, hw(), s.id, { device: d, key: free.key });
        commit();
      });
      const inputs = [...(devices.find((d) => d.device === device)?.inputs ?? [])];
      if (src && !inputs.some((i) => i.key === src.key)) {
        inputs.unshift({ key: src.key, label: `${sourceLabel(src)} (cannot carry ${s.kind})` });
      }
      const inputSel = device
        ? select(inputs.map((i) => {
          const on = sensorOn(hw(), device, i.key);
          return [i.key, on && on !== s.id ? `${i.label} — ${on}` : i.label];
        }), src.key, (key) => {
          const displaced = setSensorSource(draft, hw(), s.id, { device, key });
          if (displaced) toast(`${displaced} is no longer wired — give it a new input`, 'warn', 6000);
          commit();
        })
        : null;
      rows.push(el('div.ch-row2', {}, field('Device', deviceSel), inputSel ? field('Input', inputSel) : el('span')));
      if (!devices.length) rows.push(el('div.ch-note.warn', { text: `This stand's wiring has no input that can carry a ${s.kind} sensor.` }));
      const tc = tcType(hw(), s.id);
      if (tc) {
        rows.push(field('Thermocouple type', select(TC_TYPES.map((t) => [t, `Type ${t}`]), tc, (t) => { setTcType(hw(), s.id, t); commit(); }),
          'Set on the NI 9211 channel; the wrong type reads plausible but wrong temperatures.'));
      }
      rows.push(el('div.ch-note', { text: `Shown as ch ${s.channel} on the Data page.` }));
    } else {
      rows.push(field('Channel number', num(s.channel, (v) => { s.channel = Math.max(0, Math.round(v)); commit(); }, { step: 1, min: 0 }),
        'No wiring file for this stand: this is the number the driver reads.'));
    }
    return el('div.ch-fields', {}, rows);
  }

  function valveFields(v) {
    const draft = getDraft();
    const owners = new Map(draft.valves.map((x) => [x.channel, x.id]));
    const channels = [];
    for (let ch = 1; ch <= DC_CHANNELS; ch++) {
      const on = owners.get(ch);
      channels.push([String(ch), on && on !== v.id ? `DC${ch} — ${on} (swap)` : `DC${ch}`]);
    }
    if (!Number.isInteger(v.channel) || v.channel < 1 || v.channel > DC_CHANNELS) {
      channels.unshift([String(v.channel), `ch ${v.channel} (outside the PANDA's DC1–16)`]);
    }

    return el('div.ch-fields', {},
      nameField(v),
      idField(v),
      field('Short label', text(v.abbrev, (x) => { v.abbrev = x.trim() || v.name; commit(); }),
        'Shown where space is tight — the P&ID and narrow grid cards.'),
      field('Group (Control Grid section)', groupSelect(v)),
      el('div.ch-row2', {},
        field('Type', select(VALVE_TYPES.map((t) => [t, t]), v.type, (x) => { v.type = x; commit(); })),
        field('PANDA channel', select(channels, String(v.channel), (x) => {
          const other = setValveChannel(draft, hw(), v.id, Number(x));
          if (other) toast(`${other} moved to DC${draft.valves.find((y) => y.id === other).channel}`, 'info', 5000);
          commit();
        }))),
      el('div.ch-row2', {},
        field('Safe state', select([['closed', 'Closed'], ['open', 'Open']], v.safeState, (x) => { v.safeState = x; commit(); })),
        field('Abort state', select([['closed', 'Closed'], ['open', 'Open']], v.abortState, (x) => { v.abortState = x; commit(); }))),
      el('div.ch-checks', {},
        check(v.normallyOpen, (x) => { v.normallyOpen = x; commit(); }, 'Normally open (energize to close)'),
        check(v.requiresArm, (x) => { v.requiresArm = x; commit(); }, 'Requires ARM to open')),
      el('div.ch-note', { text: 'Changing a channel or coil sense is refused while ARMED, and saving it puts every actuator in its safe state.' })
    );
  }

  return {
    mount,
    /** Forget which ids are new: after a save they are named by everything else. */
    saved() { fresh.clear(); },
    reset() { fresh.clear(); selected = null; },
  };
}
