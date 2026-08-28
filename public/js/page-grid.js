/* page-grid.js — Control Grid: every actuator as a button, grouped by system. */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { $, el, clear, icon, fmtValue, fmtRate, fmtCurrent, shiftGate, valueWidthCh } from './util.js';

const content = await bootPage('grid');

const showReadouts = loadPref('gc4-grid-readouts', true);

/** Same window the Data page fits its rates over — one number, one meaning. */
const RATE_SECONDS = 3;

// ------------------------------------------------------------------ build --

content.append(
  el('div.page-head', {},
    el('h1', { text: 'Control Grid' }),
    el('span.sub', { text: `${bus.config.valves.length} actuators · ${bus.config.meta.subtitle || ''}` }),
    el('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      el('label.toggle', {},
        el('input', {
          type: 'checkbox',
          id: 'toggle-readouts',
          checked: showReadouts,
          onchange: (e) => {
            $('#readout-strip').classList.toggle('hidden', !e.target.checked);
            savePref('gc4-grid-readouts', e.target.checked);
          },
        }),
        el('span.track'),
        el('span', { text: 'Readouts' })
      )
    )
  ),
  el(`div#readout-strip${showReadouts ? '' : '.hidden'}`),
  el('div#valve-groups')
);

buildReadoutStrip();
buildValveGrid();

bus.on('state', () => { updateValves(); updateReadouts(); });
updateValves();
updateReadouts();

// ------------------------------------------------------- compact readouts --

/**
 * Ordered by sensor group, not by config order, so the LOX channels sit
 * together under one colour and the fuel channels under another. Reading a
 * strip of twenty-two tags is much easier when the eye can start from the
 * colour band rather than from the tag text.
 */
function buildReadoutStrip() {
  const host = $('#readout-strip');
  const strip = el('div.sensor-grid', {
    style: { '--scols': String(Math.min(8, Math.max(4, Math.ceil(bus.config.sensors.length / 2)))), marginBottom: '18px' },
  });

  for (const group of bus.sensorGroups()) {
    for (const sensor of group.sensors) {
      strip.append(el('div.sensor-card', {
        id: `rs-${sensor.id}`,
        dataset: { status: 'stale' },
        title: `${sensor.id} — ${sensor.name} · ${group.label}`,
        style: { padding: '7px 9px', '--group-color': group.color || '#64748b' },
      },
        el('div.s-top', {},
          el('span.s-id', { text: sensor.id }),
          el('span.s-status')
        ),
        el('div.s-value', { style: { fontSize: '18px', minHeight: '21px' } },
          el('span.s-num', {
            id: `rs-v-${sensor.id}`,
            style: { minWidth: `${valueWidthCh(sensor)}ch` },
            text: '––––',
          }),
          el('span.s-units', { text: sensor.units })
        ),
        // Its own line. Inline with the reading would be tidier, but a strip
        // card is barely a hundred pixels wide and the rate would be clipped
        // on every channel — a number you cannot finish reading is worse than
        // one more short row.
        el('span.s-rate', { id: `rs-r-${sensor.id}`, dataset: { dir: 'flat' }, text: '' })
      ));
    }
  }
  host.append(strip);
}

function updateReadouts() {
  for (const sensor of bus.config.sensors) {
    const card = $(`#rs-${sensor.id}`);
    if (!card) continue;
    card.dataset.status = bus.sensorStatus(sensor.id);
    const v = $(`#rs-v-${sensor.id}`);
    if (v) v.textContent = fmtValue(bus.reading(sensor.id), sensor.decimals);

    const r = $(`#rs-r-${sensor.id}`);
    if (r) {
      const rate = fmtRate(bus.rate(sensor.id, RATE_SECONDS), sensor, { compact: true });
      r.textContent = rate.text;
      r.dataset.dir = rate.dir;
    }
  }
}

// -------------------------------------------------------------- valve grid --

function buildValveGrid() {
  const host = $('#valve-groups');
  clear(host);

  const groups = [...bus.config.valveGroups];
  // Any valve pointing at an undefined group still gets rendered.
  for (const v of bus.config.valves) {
    if (!groups.some((g) => g.id === v.group)) {
      groups.push({ id: v.group, label: v.group || 'Ungrouped', color: '#64748b' });
    }
  }

  for (const group of groups) {
    const valves = bus.config.valves.filter((v) => v.group === group.id);
    if (!valves.length) continue;

    host.append(
      el('div.group-head', {},
        el('span.group-swatch', { style: { background: group.color } }),
        group.label,
        el('span.faint', { style: { textTransform: 'none', letterSpacing: 0 }, text: `${valves.length}` })
      ),
      el('div.valve-grid', { style: { '--cols': String(bus.config.ui.gridColumns) } },
        valves.map((v) => valveButton(v, group))
      )
    );
  }
}

function valveButton(valve, group) {
  const hazard = valve.type === 'igniter' || valve.momentary;

  return el('button.valve-btn', {
    id: `vb-${valve.id}`,
    dataset: { state: 'closed', valveId: valve.id, hazard: String(hazard) },
    style: { '--group-color': group.color },
    title: `${valve.id} — ${valve.name}\nchannel ${valve.channel} · ${valve.normallyOpen ? 'normally open' : 'normally closed'}\nsafe state: ${valve.safeState}`,
    onclick: (e) => onValveClick(valve, e),
  },
    // The NAME leads, on a line of its own, and the tag sits under it beside
    // the type chip. An operator scanning a wall of eleven cards is looking
    // for "LOx Tank BB", not for SV-LOXBB; the tag is what they confirm once
    // they have found it, and what they say on comms.
    //
    // The name gets its own full-width line rather than sharing one with the
    // chip: "SOLENOID" is 60px of a 120px row on a narrow card, which folds
    // every name of more than about twelve characters.
    el('div.v-name', { text: valve.name }),
    el('div.v-top', {},
      el('span.v-id', { text: valve.id }),
      el('span.v-type', { text: valve.type })
    ),
    el('div.v-state', {},
      el('span.led'),
      el('span', { id: `vs-${valve.id}`, text: '––' })
    ),
    // Current sense, when the board measures this channel. Hidden until a
    // reading arrives so valves without a DC channel keep their layout.
    el('div.v-dc.hidden', { id: `vd-${valve.id}` }),
    el('span.v-lock.hidden', { id: `vl-${valve.id}`, html: icon('lock', 12) })
  );
}

/**
 * Valve commands fire immediately — no confirmation dialog, deliberately.
 * ARM is the gate that makes actuators live; once the stand is armed the
 * operator is working the valves, and a modal between the click and the coil
 * costs time exactly when it is most expensive. The interlocks in bus and on
 * the server are what actually keep an unsafe command from landing.
 *
 * What a command away from the safe state does cost is a held SHIFT. That is
 * not a confirmation — there is nothing to read and nothing to dismiss, and
 * the click still lands in one motion — it is a guard against the mis-click,
 * which on a wall of eleven identical buttons is the failure that actually
 * happens. Driving a valve TOWARD its safe state never needs it.
 */
function onValveClick(valve, event) {
  const current = bus.valveState(valve.id);
  const next = current === 'open' ? 'closed' : 'open';

  const gate = bus.canCommand(valve.id, next);
  if (!gate.ok) return;

  if (next !== valve.safeState && !shiftGate(event, `${next === 'open' ? 'open' : 'close'} ${valve.name}`)) return;

  bus.commandValve(valve.id, next);
}

function updateValves() {
  if (!bus.state) return;

  for (const valve of bus.config.valves) {
    const btn = $(`#vb-${valve.id}`);
    if (!btn) continue;

    const state = bus.valveState(valve.id);
    btn.dataset.state = state;
    $(`#vs-${valve.id}`).textContent = state === 'open' ? valve.openLabel : valve.closedLabel;

    // Current sense: what the coil is actually drawing, versus what we
    // commanded. A disagreement is the interesting case, so flag it.
    const dc = bus.state.valves?.[valve.id]?.dc;
    const dcEl = $(`#vd-${valve.id}`);
    if (dcEl) {
      dcEl.classList.toggle('hidden', !dc);
      if (dc) {
        dcEl.textContent = `${dc.id} · ${fmtCurrent(dc.amps)}`;
        // A normally-open valve is energized to CLOSE, so current while
        // closed is correct. Compare against the expected COIL state, not
        // the flow state, or every NO vent reads as a permanent fault.
        const shouldEnergize = valve.normallyOpen ? state === 'closed' : state === 'open';
        dcEl.dataset.mismatch = String(dc.energized !== shouldEnergize);
      }
    }

    // A valve is only "locked" if it cannot be moved in EITHER direction.
    const toOpen = bus.canCommand(valve.id, 'open');
    const toClosed = bus.canCommand(valve.id, 'closed');
    const locked = !toOpen.ok && !toClosed.ok;
    const next = state === 'open' ? 'closed' : 'open';
    const nextGate = bus.canCommand(valve.id, next);

    btn.disabled = !nextGate.ok;
    // Whether the NEXT click needs SHIFT held. Set here rather than at build
    // time because it flips with the valve: the click that opens a vent needs
    // the modifier, the one that closes it does not.
    btn.dataset.needsShift = String(nextGate.ok && next !== valve.safeState);
    const lock = $(`#vl-${valve.id}`);
    lock.classList.toggle('hidden', nextGate.ok);
    if (!nextGate.ok) btn.title = `${valve.name}\n🔒 ${nextGate.reason}`;
    else if (next !== valve.safeState) {
      btn.title = `${valve.name}\nchannel ${valve.channel} · safe state: ${valve.safeState}\n`
                + `Hold SHIFT and click to ${next === 'open' ? 'OPEN' : 'CLOSE'}.`;
    } else {
      btn.title = `${valve.name}\nchannel ${valve.channel} · safe state: ${valve.safeState}`;
    }
    void locked;
  }
}

// ------------------------------------------------------------------ prefs --

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}
