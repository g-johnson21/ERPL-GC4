/* page-grid.js — Control Grid: every actuator as a button, grouped by system. */
import { bus } from './bus.js';
import { bootPage } from './chrome.js';
import { $, el, clear, icon, fmtValue, confirmAction, valueWidthCh } from './util.js';

const content = await bootPage('grid');

const showReadouts = loadPref('gc4-grid-readouts', true);

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

function buildReadoutStrip() {
  const host = $('#readout-strip');
  const strip = el('div.sensor-grid', {
    style: { '--scols': String(Math.min(8, Math.max(4, Math.ceil(bus.config.sensors.length / 2)))), marginBottom: '18px' },
  });

  for (const sensor of bus.config.sensors) {
    strip.append(el('div.sensor-card', { id: `rs-${sensor.id}`, dataset: { status: 'stale' }, style: { padding: '7px 9px' } },
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
      )
    ));
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
    title: `${valve.name}\nchannel ${valve.channel} · ${valve.normallyOpen ? 'normally open' : 'normally closed'}\nsafe state: ${valve.safeState}`,
    onclick: () => onValveClick(valve),
  },
    el('div.v-top', {},
      el('span.v-id', { text: valve.id }),
      el('span.v-type', { text: valve.type })
    ),
    el('div.v-name', { text: valve.name }),
    el('div.v-state', {},
      el('span.led'),
      el('span', { id: `vs-${valve.id}`, text: '––' })
    ),
    el('span.v-lock.hidden', { id: `vl-${valve.id}`, html: icon('lock', 12) })
  );
}

async function onValveClick(valve) {
  const current = bus.valveState(valve.id);
  const next = current === 'open' ? 'closed' : 'open';

  const gate = bus.canCommand(valve.id, next);
  if (!gate.ok) return;

  if (valve.confirm && next === 'open') {
    const ok = await confirmAction({
      title: `${valve.id} → ${valve.openLabel}`,
      message: valve.momentary
        ? `${valve.name} will fire for ${(valve.momentaryMs / 1000).toFixed(1)} s and then return to ${valve.safeState}.`
        : `Command ${valve.name} to ${next.toUpperCase()}?`,
      confirmLabel: valve.openLabel,
      danger: true,
    });
    if (!ok) return;
  }

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

    // A valve is only "locked" if it cannot be moved in EITHER direction.
    const toOpen = bus.canCommand(valve.id, 'open');
    const toClosed = bus.canCommand(valve.id, 'closed');
    const locked = !toOpen.ok && !toClosed.ok;
    const nextGate = bus.canCommand(valve.id, state === 'open' ? 'closed' : 'open');

    btn.disabled = !nextGate.ok;
    const lock = $(`#vl-${valve.id}`);
    lock.classList.toggle('hidden', nextGate.ok);
    if (!nextGate.ok) btn.title = `${valve.name}\n🔒 ${nextGate.reason}`;
    else btn.title = `${valve.name}\nchannel ${valve.channel} · safe state: ${valve.safeState}`;
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
