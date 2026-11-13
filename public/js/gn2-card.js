/* gn2-card.js — the GN2 bang-bang card in the regulators column.
 *
 * The GN2 loop runs on the SERVER (server/gn2-press.js), not on the PANDA, so
 * this card is not the board cards' twin: there is no config echo to wait
 * on and no board state to mirror. What it has that they do not:
 *
 *   - a PT selector, live: picking a channel switches the loop and the
 *     overpressure close to it at once, ARMED or not,
 *   - the OVERPRESSURE CLOSE in place of the leak trip: the selected PT at or
 *     above it shuts both GN2 BANG-BANG PRESS and GROUND GN2 PRESS and turns
 *     the loop off. It is a second layer, separate from the setpoint.
 *
 * Numbers are drafted in the card and sent together with APPLY, as on the
 * board cards; the PT selector goes out on change, because quick is the point.
 */
import { bus } from './bus.js';
import { $, el, fmtValue, shiftGate, toast, valueWidthCh } from './util.js';

const FIELDS = [
  { key: 'setpoint', label: 'Setpoint (psi)', step: 'setpointStep' },
  { key: 'deadband', label: 'Deadband ±', step: 1 },
];
const LIMITS = [
  {
    key: 'maxOpenMs', label: 'Max pulse (ms)', min: 0, max: 60000, step: 50,
    title: 'Longest single opening of the bang-bang solenoid. A close on this cap,\n'
         + 'short of the top of the band, keeps pulsing after the dwell. 0 = no cap.',
  },
  {
    key: 'minIntervalMs', label: 'Dwell (ms)', min: 0, max: 60000, step: 50,
    title: 'Minimum closed time before the solenoid may open again. Never delays a close.',
  },
  {
    key: 'overpressure', label: 'Overpressure close (psi)', min: 0, max: 100000, step: 10,
    title: 'SECOND LAYER, separate from the setpoint.\n'
         + 'The selected PT at or above this closes GN2 BANG-BANG PRESS AND GROUND GN2 PRESS\n'
         + 'and turns the loop off — whether the loop is on or not. While the PT stays over it,\n'
         + 'neither valve can be opened by hand. Must be above setpoint + deadband.',
  },
];

function snap() { return bus.state?.gn2Press ?? null; }
function inputs() { return [...($('#gn2-card')?.querySelectorAll('[data-key]') ?? [])]; }

/** PTs the loop may regulate on: pressure channels the server reads every tick. */
function pressureSensors() {
  return bus.sensorGroups()
    .map((g) => ({ label: g.label, sensors: g.sensors.filter((s) => !s.board && (s.kind ?? 'pressure') === 'pressure') }))
    .filter((g) => g.sensors.length);
}

/** The card, or null on a stand without a GN2 loop. */
export function gn2Card() {
  const cfg = bus.config.gn2Press;
  if (!cfg) return null;
  const s = snap();

  const ptSelect = el('select#gn2-pt', {
    'aria-label': 'PT the GN2 loop regulates on',
    title: 'The PT the GN2 loop AND the overpressure close read. Changes at once, armed or not.',
    onchange: async (e) => {
      const res = await bus.post('/api/gn2-press', { sensor: e.target.value });
      if (res.ok) toast(`GN2 loop now reads ${e.target.value}`, 'success');
      e.target.dataset.sent = '';
      update();
    },
  }, pressureSensors().map((g) => el('optgroup', { label: g.label },
    g.sensors.map((x) => el('option', {
      value: x.id,
      text: `${x.pid?.tag?.replace(/\n/g, ' ') || x.id} — ${x.name}${x.id === cfg.sensor ? ' (default)' : ''}`,
    })))));

  const numberInput = (f, extra = {}) => el('input', {
    type: 'number', id: `gn2-${f.key}`, title: f.title ?? '',
    min: extra.min ?? f.min, max: extra.max ?? f.max,
    step: typeof f.step === 'string' ? (s?.limits?.[f.step] ?? 1) : f.step,
    dataset: { key: f.key },
    oninput: (e) => { e.target.dataset.dirty = 'true'; update(); },
  });

  const enable = el('input#gn2-en', {
    type: 'checkbox',
    onclick: (e) => {
      const on = e.target.checked;
      if (on && !shiftGate(e, `enable ${cfg.name || 'the GN2 loop'}`)) { e.preventDefault(); return; }
      bus.post('/api/gn2-press', { enabled: on });
    },
  });

  return el('div.bb-card#gn2-card', {},
    el('div.bb-head', {},
      el('span.bb-name', { text: cfg.name || 'GN2 Press', title: cfg.name || 'GN2 Press' }),
      el('span.bb-sub', {
        text: `software → ${cfg.valve}`,
        title: 'This loop runs in the ground station, not on the PANDA.\n'
             + 'It commands the solenoid on every edge, at the control-loop rate.',
      }),
      el('button.tare-chip.bb-push#gn2-apply', {
        text: 'APPLY', disabled: true,
        title: 'Send the edited settings together.',
        onclick: apply,
      })),
    el('div.bb-readout', {},
      el('span.now#gn2-now', { style: { minWidth: '6ch' }, text: '––––' }),
      el('span.tgt', { text: 'psi' }),
      el('span.out#gn2-out', { text: 'OFF', dataset: { tone: 'idle' } })),
    el('div.gn2-pt', {}, el('label.field', { for: 'gn2-pt', text: 'PT' }), ptSelect),
    el('div.bb-compare#gn2-cmp'),
    el('div.bb-track', {}, el('i.band#gn2-band'), el('i.needle#gn2-needle'), el('i.gn2-op#gn2-op')),
    el('div.bb-inputs', {},
      FIELDS.map((f) => el('div', {}, el('label.field', { for: `gn2-${f.key}`, text: f.label }),
        numberInput(f, f.key === 'setpoint'
          ? { min: s?.limits?.setpointMin, max: s?.limits?.setpointMax ?? undefined }
          : { min: s?.limits?.deadbandMin, max: s?.limits?.deadbandMax ?? undefined })))),
    el('div.bb-lim-grid.gn2-limits', {},
      LIMITS.map((f) => el('div', {}, el('label.field', { for: `gn2-${f.key}`, text: f.label, title: f.title }), numberInput(f)))),
    el('div.bb-config-actions', {}, el('span.bb-config-status#gn2-status', { text: 'No pending changes', role: 'status' })),
    el('label.toggle.lg.bb-enable#gn2-enrow', {},
      enable, el('span.track'), el('span.bb-enable-text#gn2-entext', { text: 'ENABLE GN2 LOOP' })),
    el('div.bb-fault.hidden#gn2-fault'));
}

async function apply() {
  const edited = inputs().filter((i) => i.dataset.dirty === 'true');
  if (!edited.length) return;
  const patch = {};
  for (const input of edited) {
    if (input.value.trim() === '' || !Number.isFinite(input.valueAsNumber) || !input.checkValidity()) {
      toast(`Enter a valid ${input.dataset.key} within the field's limits`, 'error');
      input.focus();
      return;
    }
    patch[input.dataset.key] = input.valueAsNumber;
  }
  const res = await bus.post('/api/gn2-press', patch);
  if (res.ok) {
    for (const input of edited) delete input.dataset.dirty;
    toast('GN2 loop settings applied', 'success');
  }
  update();
}

/** Every state frame. */
export function update() {
  const s = snap();
  if (!s?.available || !$('#gn2-card')) return;
  const sensor = bus.sensor(s.sensor);
  const p = bus.reading(s.sensor);
  const d = sensor?.decimals ?? 0;

  const now = $('#gn2-now');
  now.textContent = Number.isFinite(p) ? fmtValue(p, d) : '––––';
  if (sensor) now.style.minWidth = `${valueWidthCh(sensor)}ch`;

  const out = $('#gn2-out');
  const [text, tone, title] = !s.enabled ? ['OFF', s.trip && s.fault?.startsWith('GN2 OVERPRESSURE') ? 'danger' : 'idle', 'The loop is off. The solenoid is closed.']
    : s.open ? ['FILLING', 'ok', `${s.valve} is open.`]
    : s.dwellLeftMs > 0 ? ['DWELL', 'warn', `${(s.dwellLeftMs / 1000).toFixed(1)} s before it may reopen.`]
    : ['HOLDING', 'ok', `Regulating ${s.setpoint} ±${s.deadband} psi on ${s.sensor}.`];
  out.textContent = text; out.dataset.tone = tone; out.title = title;

  const select = $('#gn2-pt');
  if (document.activeElement !== select && select.value !== s.sensor) select.value = s.sensor;

  $('#gn2-cmp').textContent = [
    `${s.sensor}`,
    `band ${s.setpoint - s.deadband}–${s.setpoint + s.deadband}`,
    `close at ${s.overpressure}`,
    s.enabled ? `${s.cycles} pulses` : null,
  ].filter(Boolean).join('  ·  ');

  // Band, needle and the overpressure mark across the PT's full range.
  const lo = sensor?.min ?? 0, hi = sensor?.max ?? 5000;
  const span = hi - lo || 1;
  const pct = (v) => `${Math.max(0, Math.min(100, ((v - lo) / span) * 100))}%`;
  const band = $('#gn2-band');
  band.style.left = pct(s.setpoint - s.deadband);
  band.style.width = `${Math.max(0.8, ((s.deadband * 2) / span) * 100)}%`;
  $('#gn2-op').style.left = pct(s.overpressure);
  if (Number.isFinite(p)) $('#gn2-needle').style.left = pct(p);

  for (const input of inputs()) {
    if (input.dataset.dirty === 'true' || document.activeElement === input) continue;
    input.value = s[input.dataset.key] ?? '';
  }
  const pending = inputs().some((i) => i.dataset.dirty === 'true');
  $('#gn2-apply').disabled = !pending;
  const status = $('#gn2-status');
  status.textContent = pending ? 'Pending changes — not applied' : 'No pending changes';
  status.dataset.pending = String(pending);

  const st = bus.state;
  const en = $('#gn2-en');
  en.checked = s.enabled;
  en.disabled = !s.enabled && (st.abort.active || (s.requiresArm && !st.armed));
  $('#gn2-enrow').dataset.needsShift = String(!s.enabled && !en.disabled);
  $('#gn2-entext').textContent = s.enabled ? 'GN2 LOOP ON' : 'ENABLE GN2 LOOP';

  const fault = $('#gn2-fault');
  fault.classList.toggle('hidden', !s.fault);
  fault.textContent = s.fault ? `⚠ ${s.fault}` : '';
}

