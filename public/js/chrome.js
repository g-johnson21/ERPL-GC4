/* chrome.js — shared header and control sidebar.
 *
 * Both actuation pages (Control Grid and P&ID) mount the identical sidebar, so
 * an operator never has to re-learn a layout when switching views. The whole
 * thing is generated from config: valve groups, controllers, sequences and
 * recording options all come from stand.json.
 */
import { bus } from './bus.js';
import { $, el, clear, icon, fmtDuration, fmtBytes, fmtValue, fmtClock, confirmAction, toast, valueWidthCh } from './util.js';
import { currentTheme, toggleTheme, applyConfigDefault } from './theme.js';

// ============================================================== HEADER =====

export function mountHeader(activePage) {
  const cfg = bus.config;
  const header = el('header.app-header');

  header.append(
    el('div.brand', {},
      themedLogo(cfg.ui.logo, 'org-logo'),
      el('span.brand-mark', { text: cfg.ui.brand }),
      cfg.meta.standName
        ? el('span.brand-stand', {},
            themedLogo(cfg.meta.standLogo, 'stand-logo'),
            el('span', { text: cfg.meta.standName })
          )
        : null
    ),
    el('nav.nav', {}, cfg.ui.pages.map((page) =>
      el('a', {
        href: page.href,
        class: page.id === activePage ? 'active' : '',
        html: `${icon(page.icon || 'grid')}<span>${page.label}</span>`,
      })
    )),
    el('div.header-spacer'),
    el('div.header-status#header-status'),
    el('span.clock#header-clock', { text: '--:--:--' }),
    el('button.icon-btn#theme-toggle', {
      title: 'Toggle light / dark theme (T)',
      'aria-label': 'Toggle theme',
      onclick: () => { toggleTheme(); syncThemeIcon(); },
    }),
    el('button.icon-btn#sidebar-toggle', {
      title: 'Show / hide control sidebar (\\)',
      'aria-label': 'Toggle sidebar',
      html: icon('panel'),
      onclick: toggleSidebar,
    })
  );

  document.body.prepend(header);
  syncThemeIcon();

  // The link indicators show an age, which has to keep counting between
  // telemetry frames — and especially after they stop arriving, which is
  // exactly when an operator is reading them.
  setInterval(() => {
    $('#header-clock').textContent = fmtClock(Date.now());
    updateHeaderStatus();
  }, 250);

  bus.on('state', () => { lastStateAt = Date.now(); updateHeaderStatus(); });
  bus.on('connection', updateHeaderStatus);
  updateHeaderStatus();

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === '\\') { toggleSidebar(); }
    if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey) { toggleTheme(); syncThemeIcon(); }
  });
}

/**
 * An <img> that swaps source with the theme. Both logo variants are
 * silhouettes on transparency, so the wrong one is invisible rather than
 * merely ugly — the swap is not cosmetic.
 */
function themedLogo(spec, className) {
  if (!spec || (!spec.light && !spec.dark)) return null;
  const img = el(`img.${className}`, {
    alt: spec.alt || '',
    style: spec.height ? { height: `${spec.height}px` } : {},
  });
  const apply = () => {
    const dark = currentTheme() === 'dark';
    img.src = (dark ? spec.dark : spec.light) || spec.light || spec.dark;
  };
  apply();
  window.addEventListener('themechange', apply);
  return img;
}

function syncThemeIcon() {
  const btn = $('#theme-toggle');
  if (btn) btn.innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon');
}

function toggleSidebar() {
  $('.sidebar')?.classList.toggle('collapsed');
  window.dispatchEvent(new Event('resize'));
}

/**
 * When the browser last received a snapshot, by the LOCAL clock.
 *
 * Device ages are measured on the server's clock (`snapshot.t` minus the
 * device's last receive time) and then extended locally. Subtracting a server
 * timestamp from `Date.now()` directly would read whatever the two machines
 * disagree about — a second operator station whose clock is a minute off would
 * show a perfectly healthy DAQ as a minute stale.
 */
let lastStateAt = 0;

function updateHeaderStatus() {
  const host = $('#header-status');
  if (!host || !bus.state) return;
  const s = bus.state;
  clear(host);

  const chips = [];

  // Losing the browser's own link to the server is reported separately from
  // the hardware links: the device chips below are then a snapshot of what was
  // true when the stream died, not what is true now.
  if (!bus.connected) chips.push(chip('LINK LOST', 'danger', true));

  for (const dev of s.driver.devices || []) chips.push(linkChip(dev, s));

  if (s.abort.active) chips.push(chip('ABORT', 'danger', true));
  else if (s.armed) chips.push(chip('ARMED', 'danger', true));
  else chips.push(chip('SAFE', 'ok'));

  // Instrumentation is zeroed from the Data page, but a tare changes what the
  // readings mean on EVERY screen. One chip in the shared header says so
  // without putting a marker on every card, bubble and strip readout.
  const tared = Object.entries(s.sensors)
    .filter(([, r]) => Number.isFinite(r.tare) && r.tare !== 0)
    .map(([id]) => id);
  if (tared.length) {
    const node = chip(`TARE ${tared.length}`, 'warn');
    node.title = `Zero offsets are applied to: ${tared.join(', ')}\nManage them on the Data page.`;
    chips.push(node);
  }

  if (s.sequence.running) {
    chips.push(chip(`${s.sequence.name}  T+${s.sequence.t.toFixed(1)}`, 'warn', true));
  }
  if (s.recording.active) {
    chips.push(chip(`REC ${fmtDuration(s.recording.elapsed)}`, 'danger', true));
  }

  host.append(...chips);
}

function chip(text, kind = '', live = false) {
  return el(`span.chip.${kind}${live ? '.live' : ''}`, {}, el('span.dot'), text);
}

/**
 * One hardware link: NIDAQ, PANDA, or whichever single device a simpler
 * driver presents.
 *
 * Reads LIVE while data is arriving and switches to the time since the last
 * frame the moment it stops. An age is the useful number during a fault —
 * "NO LINK" cannot distinguish a cable knocked out two seconds ago from a
 * board that never came up, and those are different problems.
 */
function linkChip(dev, snapshot) {
  const label = (dev.key || dev.name || 'link').toUpperCase();
  const age = deviceAgeMs(dev, snapshot);

  let text, kind;
  if (dev.connected) {
    text = `${label} LIVE`;
    kind = 'ok';
  } else if (age === null) {
    text = `${label} NO LINK`;                 // never said anything
    kind = dev.required ? 'danger' : 'warn';
  } else {
    text = `${label} ${fmtAge(age)}`;
    kind = dev.required ? 'danger' : 'warn';
  }

  const node = chip(text, kind, !dev.connected);
  node.title = [
    dev.detail || label,
    dev.required ? 'required device' : 'optional device',
    age === null ? 'no data received since startup' : `last data ${fmtAge(age)} ago`,
  ].join('\n');
  return node;
}

/** Age of a device's last frame in ms, or null if it has never sent one. */
function deviceAgeMs(dev, snapshot) {
  if (!dev.lastRxAt) return null;
  const atSnapshot = Math.max(0, snapshot.t - dev.lastRxAt);
  const sinceSnapshot = lastStateAt ? Math.max(0, Date.now() - lastStateAt) : 0;
  return atSnapshot + sinceSnapshot;
}

/** Compact age: 0.4s, 12s, 3m 05s, 2h 14m. */
function fmtAge(ms) {
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${String(Math.floor(secs % 60)).padStart(2, '0')}s`;
  return `${Math.floor(secs / 3600)}h ${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m`;
}

// ============================================================= SIDEBAR =====

export function mountSidebar(container) {
  const sidebar = el('aside.sidebar');
  sidebar.append(
    armSection(),
    controllerSection(),
    sequenceSection(),
    logSection(),
    recordingSection()
  );
  container.append(sidebar);

  bus.on('state', updateSidebar);
  bus.on('log', appendLogLine);
  bus.on('config', renderSequenceList);
  renderSequenceList();
  updateSidebar();
  renderLog();
  refreshFileList();
  return sidebar;
}

// ------------------------------------------------------------ ARM / ABORT --

function armSection() {
  return el('div.sidebar-section', {},
    el('div.section-title', {}, 'Stand State'),
    el('div.arm-panel', {},
      el('div.btn-row', {},
        el('button.arm-btn.arm#btn-arm', {
          text: 'ARM',
          onclick: async () => {
            const ok = await confirmAction({
              title: 'ARM the stand?',
              message: 'Actuators become live. Confirm the area is clear and all personnel are at a safe distance.',
              confirmLabel: 'ARM',
              danger: true,
            });
            if (ok) bus.setArmed(true);
          },
        }),
        el('button.arm-btn.disarm#btn-disarm', {
          text: 'DISARM',
          onclick: () => bus.setArmed(false),
        })
      ),
      el('button.abort-btn#btn-abort', {
        text: 'ABORT',
        onclick: () => bus.abort('Operator abort'),
      }),
      el('div#abort-banner')
    )
  );
}

// -------------------------------------------------------- BANG-BANG BANK --

function controllerSection() {
  const cfg = bus.config;
  if (!cfg.bangbang.length) return el('div.hidden');

  const body = el('div#bb-list');
  for (const c of cfg.bangbang) body.append(controllerCard(c));

  return el('div.sidebar-section', {},
    el('div.section-title', {}, 'Bang-Bang Pressure Control',
      el('button.btn.sm.ghost', {
        text: 'ALL OFF',
        onclick: () => { for (const c of cfg.bangbang) bus.setController(c.id, { enabled: false }); },
      })
    ),
    body
  );
}

/**
 * The duty-cycle limits and trips an operator may retune from this panel.
 *
 * These used to be config-file-only, which meant changing a pulse width
 * between attempts required disarming the stand, editing JSON, and
 * hot-reloading every browser. They are runtime settings on the server now, so
 * every setting a bang-bang controller has lives on the actuation screen.
 */
const LIMIT_FIELDS = [
  {
    key: 'maxOpenMs', label: 'Max pulse', units: 'ms', min: 0, max: 120000, step: 50,
    title: 'BOARD — sent as max_open_ms.\n'
         + 'One actuation holds the press valve open at most this long, then closes.\n'
         + 'The loop keeps running and may reopen after the dwell.\n0 = no pulse limit.',
  },
  {
    key: 'minIntervalMs', label: 'Dwell', units: 'ms', min: 0, max: 120000, step: 50,
    title: 'BOARD — sent as wait_ms.\n'
         + 'The board\'s minimum dwell between valve state transitions.\n'
         + 'UNVERIFIED: GC-4\'s old limit never delayed a CLOSE. The board\'s wait_ms is\n'
         + 'documented as a dwell between any transitions and may delay one.\n0 = no dwell.',
  },
  {
    key: 'maxOpenSeconds', label: 'Leak trip', units: 's', min: 0, max: 3600, step: 1,
    title: 'GROUND STATION — no board equivalent.\n'
         + 'The board reporting its press valve open this long without reaching setpoint\n'
         + 'tells the board to stop and raises a fault (a leak, or a dead transducer).\n'
         + 'Needs the link: if the heartbeat stops, so does this trip.\n0 = no trip.',
  },
  {
    key: 'ventTrigger', label: 'Auto-vent at', units: '', min: 0, max: 100000, step: 5,
    nullable: true,
    title: 'BOARD — sent as the V command\'s trigger.\n'
         + 'Pressure at which the board enters AUTO-VENT and opens its vent solenoid.\n'
         + 'Only acts when auto-vent is armed. Empty = no vent config pushed.',
  },
];

/** The board's per-side state machine, as the heartbeat reports it. */
const BOARD_STATES = {
  OFF: { label: 'OFF', tone: 'idle', title: 'Loop inactive. The board has its valves closed.' },
  SUS: { label: 'SUSTAIN', tone: 'ok', title: 'The board is regulating against the deadband.' },
  AV: { label: 'AUTO-VENT', tone: 'warn', title: 'Vent trigger exceeded — the board is venting.' },
  ABT: { label: 'ABORT', tone: 'danger', title: 'Latched abort on the board. Nothing here clears it.' },
};

function controllerCard(c) {
  const sensor = bus.sensor(c.sensor);

  const setpointInput = el('input', {
    type: 'number',
    id: `bb-sp-${c.id}`,
    value: c.setpoint,
    min: c.setpointMin,
    max: c.setpointMax,
    step: c.setpointStep,
    onchange: (e) => commitNumber(e.target, c.setpointMin, c.setpointMax, (v) => bus.setController(c.id, { setpoint: v })),
  });

  const deadbandInput = el('input', {
    type: 'number',
    id: `bb-db-${c.id}`,
    value: c.deadband,
    min: c.deadbandMin,
    max: c.deadbandMax,
    step: 1,
    onchange: (e) => commitNumber(e.target, c.deadbandMin, c.deadbandMax, (v) => bus.setController(c.id, { deadband: v })),
  });

  const enableToggle = el('input', {
    type: 'checkbox',
    id: `bb-en-${c.id}`,
    onchange: (e) => bus.setController(c.id, { enabled: e.target.checked }),
  });

  return el(`div.bb-card#bb-card-${c.id}`, {},
    el('div.bb-head', {},
      el('span.bb-name', { text: c.name }),
      // Which board bus this is. The letter is the one that goes on the wire,
      // so an operator reading a raw command log can match them up.
      el('span.bb-side', {
        text: c.side ? `BUS ${c.side}` : 'NO BUS',
        title: c.side
          ? `The board's ${c.side === 'L' ? 'LOX' : 'Fuel'} bus. Commands go out as B${c.side}/b${c.side}/x${c.side}.`
          : 'No board side configured — this controller cannot be pushed to the board.',
      })
    ),
    el('div.bb-sub', {
      id: `bb-src-${c.id}`,
      title: 'The board regulates on its OWN transducer. The DAQ channel below it is a\n'
           + 'second sensor on the same tank, and the two can legitimately disagree.',
      text: `board PT → ${c.valve}`,
    }),
    el('div.bb-readout', {},
      // Reserved width keeps the units label and the state badge from
      // shifting as the pressure reading swings.
      el('span.now', {
        id: `bb-now-${c.id}`,
        style: { minWidth: `${sensor ? valueWidthCh(sensor) : 6}ch` },
        text: '––––',
      }),
      el('span.tgt', { text: sensor?.units || '' }),
      el('span.out', { id: `bb-out-${c.id}`, text: 'OFF', dataset: { tone: 'idle' } })
    ),
    // The ground station's own view of the same tank, and the gap between
    // them. A quiet disagreement between two transducers is the thing worth
    // seeing before it matters, not after.
    el('div.bb-compare', { id: `bb-cmp-${c.id}` }),
    el('div.bb-track', {},
      el('i.band', { id: `bb-band-${c.id}` }),
      el('i.needle', { id: `bb-needle-${c.id}` })
    ),
    el('div.bb-inputs', {},
      el('div', {}, el('label.field', { for: `bb-sp-${c.id}`, text: `Setpoint (${sensor?.units || ''})` }), setpointInput),
      el('div', {}, el('label.field', { for: `bb-db-${c.id}`, text: 'Deadband ±' }), deadbandInput)
    ),
    limitsPanel(c, sensor),
    el('label.toggle', {}, enableToggle, el('span.track'), el('span', { text: 'Enable board control' })),
    // Overrides. Both go straight out on the wire — neither waits on the
    // config handshake, because neither can make the stand less safe.
    el('div.bb-overrides', {},
      el('button.btn.sm#bb-vent-' + c.id, {
        text: 'VENT',
        title: 'Manual vent override (v<side>). Independent of auto-vent, and\n'
             + 'accepted by the board in any state, including abort.',
        onclick: (e) => {
          const open = e.currentTarget.dataset.on !== 'true';
          bus.setController(c.id, { vent: open });
        },
      }),
      el('button.btn.sm.danger', {
        text: 'ABORT SIDE',
        title: 'Per-side abort (x<side>). LATCHED on the board — nothing in the\n'
             + 'protocol clears it, so recovery needs a disarm/rearm or a power cycle.',
        onclick: () => {
          if (confirm(`Abort ${c.name} on the board?\n\nThis is LATCHED: it cannot be cleared from this screen.`)) {
            bus.setController(c.id, { abort: true });
          }
        },
      })
    ),
    el('div.bb-fault.hidden', { id: `bb-fault-${c.id}` })
  );
}

/**
 * Collapsed by default, with the live values summarised on the closed row —
 * the limits matter constantly but are changed rarely, so they must be
 * readable at a glance without four more input boxes competing with the
 * setpoint for attention.
 */
function limitsPanel(c, sensor) {
  const details = el('details.bb-limits', {
    id: `bb-lim-${c.id}`,
    open: limitsOpen(),
    ontoggle: (e) => saveLimitsOpen(e.target.open),
  });

  details.append(
    el('summary', {},
      el('span.bb-lim-title', { text: 'Limits & trips' }),
      el('span.bb-lim-sum', { id: `bb-limsum-${c.id}`, text: '' })
    ),
    el('div.bb-lim-grid', {},
      LIMIT_FIELDS.map((f) => {
        const units = f.units || sensor?.units || '';
        return el('div', {},
          el('label.field', {
            for: `bb-${f.key}-${c.id}`,
            title: f.title,
            text: units ? `${f.label} (${units})` : f.label,
          }),
          el('input', {
            type: 'number',
            id: `bb-${f.key}-${c.id}`,
            title: f.title,
            min: f.min,
            max: f.max,
            step: f.step,
            placeholder: f.nullable ? 'off' : undefined,
            onchange: (e) => commitControllerField(c, f.key, e.target, { nullable: f.nullable }),
          })
        );
      }),
      el('div', {},
        el('label.field', {
          for: `bb-abortAbove-${c.id}`,
          title: 'GROUND STATION — no board equivalent.\n'
               + 'Either transducer above this latches a stand-wide ABORT and aborts this side.\n'
               + 'Needs the link. Leave empty for no threshold.',
          text: `Abort above (${sensor?.units || ''})`,
        }),
        el('input', {
          type: 'number',
          id: `bb-abortAbove-${c.id}`,
          placeholder: 'off',
          step: 1,
          onchange: (e) => commitControllerField(c, 'abortAbove', e.target, { nullable: true }),
        })
      )
    ),
    // Arming auto-vent is a checkbox rather than a number, because it is a
    // yes/no decision about whether the board may vent a tank unprompted.
    el('label.bb-lim-check', {
      title: 'BOARD — the V command\'s auto flag.\n'
           + 'Lets the board open its vent solenoid on its own once the trigger is passed.\n'
           + 'Needs a trigger pressure above.',
    },
      el('input', {
        type: 'checkbox',
        id: `bb-ventAuto-${c.id}`,
        onchange: (e) => {
          bus.setController(c.id, { ventAuto: e.target.checked }).then((res) => {
            if (!res.ok) e.target.checked = !e.target.checked;
          });
        },
      }),
      el('span', { text: 'Board may auto-vent' })
    )
  );
  return details;
}

/**
 * Send one limit to the server and let the server's answer stand.
 *
 * The server owns the bounds and the cross-check between the pulse limit and
 * the leak trip, so a rejected edit is snapped back to the running value
 * rather than left on screen looking applied.
 */
function commitControllerField(c, key, input, { nullable = false } = {}) {
  const text = input.value.trim();
  let value;
  if (nullable && text === '') {
    value = null;
  } else {
    value = Number(text);
    if (!Number.isFinite(value)) {
      toast('Enter a number', 'error');
      input.value = runtimeField(c.id, key);
      return;
    }
  }
  bus.setController(c.id, { [key]: value }).then((res) => {
    if (!res.ok) input.value = runtimeField(c.id, key);
  });
}

function runtimeField(id, key) {
  const v = bus.state?.controllers?.[id]?.[key];
  return v === null || v === undefined ? '' : v;
}

/** One-line rendering of the limits, for the collapsed summary row. */
function limitSummary(rt, sensor) {
  const units = sensor?.units ? ` ${sensor.units}` : '';
  return [
    rt.maxOpenMs > 0 ? `pulse ${rt.maxOpenMs}ms` : 'pulse ∞',
    rt.minIntervalMs > 0 ? `dwell ${rt.minIntervalMs}ms` : 'dwell 0',
    rt.maxOpenSeconds > 0 ? `trip ${rt.maxOpenSeconds}s` : 'trip off',
    rt.ventTrigger != null ? `vent ${rt.ventTrigger}${rt.ventAuto ? ' auto' : ''}` : 'vent off',
    rt.abortAbove != null ? `abort ${rt.abortAbove}${units}` : 'abort off',
  ].join(' · ');
}

const LIMITS_OPEN_KEY = 'gc4-bb-limits-open';
function limitsOpen() {
  try { return localStorage.getItem(LIMITS_OPEN_KEY) === 'true'; } catch { return false; }
}
function saveLimitsOpen(open) {
  try { localStorage.setItem(LIMITS_OPEN_KEY, String(open)); } catch { /* ignore */ }
}

function commitNumber(input, min, max, apply) {
  const v = Number(input.value);
  if (!Number.isFinite(v)) { toast('Enter a number', 'error'); return; }
  const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  if (clamped !== v) input.value = clamped;
  apply(clamped);
}

// ------------------------------------------------------------- SEQUENCES --

function sequenceSection() {
  return el('div.sidebar-section', {},
    el('div.section-title', {}, 'Autosequences'),
    el('div#seq-running'),
    el('div.seq-list#seq-list'),
    el('button.btn.wide.sm.ghost', {
      style: { marginTop: '8px' },
      html: `${icon('warning', 14)} SAFE ALL ACTUATORS`,
      onclick: async () => {
        const ok = await confirmAction({
          title: 'Safe all actuators?',
          message: 'Every valve will be driven to its configured safe state immediately.',
          confirmLabel: 'SAFE ALL',
        });
        if (ok) bus.safeAll();
      },
    })
  );
}

/**
 * (Re)build the sequence buttons from config.
 *
 * Not built once at boot: autosequences may be edited while the stand is
 * ARMED, and a hot-reload then updates this list in place instead of
 * reloading the control screen out from under a live test.
 */
function renderSequenceList() {
  const host = $('#seq-list');
  if (!host) return;
  clear(host);

  for (const seq of bus.config.autosequences.filter((s) => !s.hidden)) {
    host.append(el('button.seq-btn', {
      dataset: { style: seq.style, seqId: seq.id },
      title: seq.description || seq.name,
      onclick: () => runSequence(seq),
    },
      el('span.seq-dot'),
      el('span', { text: seq.name }),
      el('span.seq-meta', { text: seq.duration ? `${seq.duration.toFixed(0)}s` : '' })
    ));
  }
  updateSidebar();   // apply the current interlocks to the fresh buttons
}

async function runSequence(seq) {
  if (seq.confirm) {
    const ok = await confirmAction({
      title: `Run "${seq.name}"?`,
      message: seq.description
        ? `${seq.description}\n\nDuration ~${seq.duration.toFixed(0)} s.`
        : `This sequence runs for about ${seq.duration.toFixed(0)} s.`,
      confirmLabel: `RUN ${seq.abbrev}`,
      danger: seq.style === 'danger',
    });
    if (!ok) return;
  }
  bus.startSequence(seq.id);
}

// ------------------------------------------------------------------- LOG --

function logSection() {
  return el('div.sidebar-section.grow', {},
    el('div.section-title', {}, 'Event Log',
      el('button.btn.sm.ghost', { text: 'CLEAR', onclick: () => { bus.events = []; renderLog(); } })
    ),
    el('div.log-panel', {}, el('div.log-list#log-list'))
  );
}

function renderLog() {
  const list = $('#log-list');
  if (!list) return;
  clear(list);
  for (const entry of bus.events.slice(-250)) list.append(logLine(entry));
  list.scrollTop = list.scrollHeight;
}

function logLine(entry) {
  return el('div.log-line', { dataset: { level: entry.level } },
    el('span.lt', { text: new Date(entry.t).toTimeString().slice(0, 8) }),
    el('span.lm', { text: entry.message })
  );
}

function appendLogLine(entry) {
  const list = $('#log-list');
  if (!list) return;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(logLine(entry));
  while (list.children.length > 250) list.firstChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ------------------------------------------------------------- RECORDING --

function recordingSection() {
  const cfg = bus.config.recording;

  return el('div.sidebar-section.footer', {},
    el('div.section-title', {}, 'Data Recording',
      el('span.faint', { text: `${cfg.rateHz} Hz → CSV` })
    ),
    el('div.rec-status', { id: 'rec-status', dataset: { active: 'false' } },
      el('span.rec-dot'),
      el('span.rec-file#rec-file', { text: 'Not recording' })
    ),
    el('label.field', { for: 'rec-name', text: 'Test name' }),
    el('input', {
      type: 'text',
      id: 'rec-name',
      value: cfg.defaultTestName,
      placeholder: 'e.g. hotfire-03',
      onkeydown: (e) => { if (e.key === 'Enter') startRecording(); },
    }),
    el('div.btn-row', { style: { marginTop: '7px' } },
      el('button.btn.danger#rec-start', { html: `${icon('record', 13)} START`, onclick: startRecording }),
      el('button.btn#rec-stop', { html: `${icon('stop', 13)} STOP`, onclick: () => bus.stopRecording(), disabled: true })
    ),
    el('div.rec-stats', {},
      el('span#rec-rows', { text: '0 rows' }),
      el('span#rec-size', { text: '0 B' }),
      el('span#rec-elapsed', { text: '0:00' })
    ),
    el('div.section-title', { style: { marginTop: '12px' } }, 'Recorded Files',
      el('button.btn.sm.ghost', { html: icon('refresh', 13), title: 'Refresh file list', onclick: refreshFileList })
    ),
    el('div.file-list#file-list', {}, el('div.empty-note', { text: 'No recordings yet' }))
  );
}

function startRecording() {
  const name = $('#rec-name')?.value?.trim() || bus.config.recording.defaultTestName;
  bus.startRecording(name).then((res) => {
    if (res.ok) setTimeout(refreshFileList, 400);
  });
}

async function refreshFileList() {
  const host = $('#file-list');
  if (!host) return;
  let files = [];
  try { files = await bus.listRecordings(); } catch { /* server may be down */ }

  clear(host);
  if (!files.length) {
    host.append(el('div.empty-note', { text: 'No recordings yet' }));
    return;
  }
  for (const f of files.slice(0, 40)) {
    host.append(el('div.file-row', {},
      el('a', {
        href: `/api/record/download/${encodeURIComponent(f.name)}`,
        text: f.name,
        title: `${f.name}\n${new Date(f.modified).toLocaleString()}`,
        download: '',
      }),
      el('span.fsize', { text: fmtBytes(f.size) })
    ));
  }
}

// ------------------------------------------------------------ STATE SYNC --

let lastRecordingActive = null;

function updateSidebar() {
  const s = bus.state;
  if (!s) return;

  // --- ARM / ABORT ---
  const armBtn = $('#btn-arm');
  const disarmBtn = $('#btn-disarm');
  if (armBtn) {
    armBtn.dataset.active = String(s.armed);
    armBtn.disabled = s.armed || s.abort.active;
    armBtn.textContent = s.armed ? 'ARMED' : 'ARM';
  }
  if (disarmBtn) {
    disarmBtn.dataset.active = String(!s.armed);
    disarmBtn.disabled = !s.armed;
  }

  const banner = $('#abort-banner');
  if (banner) {
    // Only rebuild when the abort state actually changes. Rebuilding every
    // telemetry frame (20 Hz) destroyed the CLEAR ABORT button between
    // mousedown and mouseup, so the click could never land on it.
    const sig = s.abort.active ? `on:${s.abort.at}:${s.abort.reason}` : 'off';
    if (banner.dataset.sig !== sig) {
      banner.dataset.sig = sig;
      clear(banner);
      if (s.abort.active) {
        banner.append(el('div.abort-banner', {},
          el('strong', { text: 'ABORT LATCHED' }),
          el('span', { text: s.abort.reason || 'Operator abort' }),
          el('button.btn.sm.wide', {
            style: { marginTop: '7px' },
            text: 'CLEAR ABORT',
            onclick: async () => {
              const ok = await confirmAction({
                title: 'Clear the abort?',
                message: 'Verify the cause has been resolved and the stand is in a known safe configuration. The stand stays DISARMED after clearing.',
                confirmLabel: 'CLEAR ABORT',
                danger: true,
              });
              if (ok) bus.clearAbort();
            },
          })
        ));
      }
    }
  }

  // --- controllers ---
  for (const c of bus.config.bangbang) {
    const rt = s.controllers[c.id];
    if (!rt) continue;
    const value = bus.reading(c.sensor);
    const sensor = bus.sensor(c.sensor);

    const board = rt.board;
    // The pressure the BOARD is regulating on. The DAQ channel is a second
    // sensor on the same tank and is shown beneath it, not in place of it —
    // reading the wrong one is how you conclude a loop is misbehaving when
    // it is doing exactly what its own transducer told it to.
    const boardValue = board && !board.stale ? board.pressure : null;

    const now = $(`#bb-now-${c.id}`);
    if (now) now.textContent = Number.isFinite(boardValue) ? fmtValue(boardValue, sensor?.decimals ?? 1) : '––––';

    const out = $(`#bb-out-${c.id}`);
    if (out) {
      const meta = BOARD_STATES[board?.state] || null;
      if (!board) {
        out.textContent = 'NO BOARD';
        out.dataset.tone = 'idle';
        out.title = 'This driver does not run board-side bang-bang.';
      } else if (board.stale) {
        // NOT the same as stopped. The board keeps regulating on its own; we
        // have merely stopped being told about it.
        out.textContent = 'NO LINK';
        out.dataset.tone = 'warn';
        out.title = 'No heartbeat from the board. It is probably still regulating —\n'
                  + 'the loop lives there — but nothing on this screen is current.';
      } else if (rt.awaiting === 'config') {
        out.textContent = 'CONFIRMING';
        out.dataset.tone = 'warn';
        out.title = 'Waiting for the board to echo the configuration before enabling it.\n'
                  + 'Enabling on an unconfirmed setpoint regulates to the wrong pressure.';
      } else if (rt.awaiting === 'enable') {
        out.textContent = 'STARTING';
        out.dataset.tone = 'warn';
        out.title = 'Config confirmed; waiting for the board to report SUSTAIN.';
      } else if (meta) {
        out.textContent = board.press ? 'FILLING' : meta.label;
        out.dataset.tone = board.press ? 'ok' : meta.tone;
        out.title = meta.title;
      } else {
        out.textContent = board.state || '?';
        out.dataset.tone = 'danger';
        out.title = `The board reported a state this client does not recognise: "${board.state}"`;
      }
    }

    const cmp = $(`#bb-cmp-${c.id}`);
    if (cmp) {
      const parts = [];
      if (Number.isFinite(value)) parts.push(`${c.sensor} ${fmtValue(value, sensor?.decimals ?? 1)}`);
      if (Number.isFinite(boardValue) && Number.isFinite(value)) {
        const delta = boardValue - value;
        parts.push(`Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);
      }
      if (board?.press) parts.push('press OPEN');
      if (board?.vent) parts.push('vent OPEN');
      cmp.textContent = parts.join('  ·  ');
      cmp.title = `Board PT vs ${c.sensor} (the DAQ). Two sensors on one tank —`
                + ` a persistent gap is a calibration difference worth chasing.`;
    }

    const ventBtn = $(`#bb-vent-${c.id}`);
    if (ventBtn) {
      ventBtn.dataset.on = String(Boolean(board?.vent));
      ventBtn.textContent = board?.vent ? 'VENTING' : 'VENT';
    }

    // Setpoint band + live needle drawn across the sensor's full range.
    const lo = sensor?.min ?? 0, hi = sensor?.max ?? 1000;
    const span = hi - lo || 1;
    const band = $(`#bb-band-${c.id}`);
    if (band) {
      const left = ((rt.setpoint - rt.deadband - lo) / span) * 100;
      const width = ((rt.deadband * 2) / span) * 100;
      band.style.left = `${Math.max(0, left)}%`;
      band.style.width = `${Math.max(0.8, Math.min(100, width))}%`;
    }
    // Drawn from the board's own reading, so the needle sits where the loop
    // thinks it is — the band it is being judged against belongs to the board.
    const needle = $(`#bb-needle-${c.id}`);
    const needleAt = Number.isFinite(boardValue) ? boardValue : value;
    if (needle && Number.isFinite(needleAt)) {
      needle.style.left = `${Math.max(0, Math.min(100, ((needleAt - lo) / span) * 100))}%`;
    }

    const sp = $(`#bb-sp-${c.id}`);
    if (sp && document.activeElement !== sp) sp.value = rt.setpoint;
    const db = $(`#bb-db-${c.id}`);
    if (db && document.activeElement !== db) db.value = rt.deadband;

    // Limits are mirrored the same way as the setpoint: never overwrite the
    // box someone is typing in, so a sequence step or a second operator
    // changing the value cannot yank a half-typed number away.
    for (const key of ['maxOpenMs', 'minIntervalMs', 'maxOpenSeconds', 'abortAbove', 'ventTrigger']) {
      const input = $(`#bb-${key}-${c.id}`);
      if (input && document.activeElement !== input) input.value = runtimeField(c.id, key);
    }
    const ventAuto = $(`#bb-ventAuto-${c.id}`);
    if (ventAuto && document.activeElement !== ventAuto) ventAuto.checked = Boolean(rt.ventAuto);

    const limSum = $(`#bb-limsum-${c.id}`);
    if (limSum) limSum.textContent = limitSummary(rt, sensor);

    const en = $(`#bb-en-${c.id}`);
    if (en) {
      en.checked = rt.enabled;
      // A side the board has latched into ABORT cannot be re-enabled from
      // here at all, so the control says so by being unavailable rather than
      // by accepting a click the server will refuse.
      en.disabled = s.abort.active || board?.state === 'ABT' || !rt.side ||
                    (c.requiresArm && !s.armed && !rt.enabled);
    }

    const fault = $(`#bb-fault-${c.id}`);
    if (fault) {
      // A rejection from the board is worth showing even when nothing tripped:
      // it is the only negative acknowledgement the protocol has.
      const message = rt.fault || (rt.lastError ? `Board rejected: ${rt.lastError}` : null);
      fault.classList.toggle('hidden', !message);
      fault.textContent = message ? `⚠ ${message}` : '';
    }
  }

  // --- sequences ---
  const running = $('#seq-running');
  if (running) {
    if (s.sequence.running) {
      const pct = s.sequence.duration ? Math.min(100, (s.sequence.t / s.sequence.duration) * 100) : 0;
      if (running.dataset.seq !== s.sequence.id) {
        running.dataset.seq = s.sequence.id;
        clear(running);
        running.append(el('div.seq-running', {},
          el('div.sr-head', {},
            el('span.sr-name', { text: s.sequence.name }),
            el('span.sr-t#sr-t', { text: 'T+0.0' })
          ),
          el('div.sr-bar', {}, el('i#sr-fill')),
          el('button.btn.wide.sm.danger', {
            html: `${icon('stop', 13)} STOP SEQUENCE`,
            onclick: () => bus.stopSequence(),
          })
        ));
      }
      const t = $('#sr-t');
      if (t) t.textContent = `T+${s.sequence.t.toFixed(1)}`;
      const fill = $('#sr-fill');
      if (fill) fill.style.width = `${pct}%`;
    } else if (running.dataset.seq) {
      running.dataset.seq = '';
      clear(running);
    }
  }

  for (const btn of document.querySelectorAll('.seq-btn')) {
    const seq = bus.config.autosequences.find((x) => x.id === btn.dataset.seqId);
    if (!seq) continue;
    btn.disabled = s.sequence.running || s.abort.active || (seq.requiresArm && !s.armed);
  }

  // --- recording ---
  const rec = s.recording;
  const status = $('#rec-status');
  if (status) {
    status.dataset.active = String(rec.active);
    $('#rec-file').textContent = rec.active ? rec.file : 'Not recording';
    $('#rec-rows').textContent = `${rec.rows.toLocaleString()} rows`;
    $('#rec-size').textContent = fmtBytes(rec.bytes);
    $('#rec-elapsed').textContent = fmtDuration(rec.elapsed);
    $('#rec-start').disabled = rec.active;
    $('#rec-stop').disabled = !rec.active;
    $('#rec-name').disabled = rec.active;
  }
  if (lastRecordingActive === true && rec.active === false) refreshFileList();
  lastRecordingActive = rec.active;
}

// ------------------------------------------------------------- PAGE SETUP --

/** Standard page boot: config, theme, header, layout shell. */
export async function bootPage(pageId, { sidebar = true } = {}) {
  await bus.init();
  applyConfigDefault(bus.config);
  document.title = `${bus.config.ui.brand} · ${pageLabel(pageId)}`;

  mountHeader(pageId);

  const body = el('div.app-body');
  const content = el('main.content');
  body.append(content);
  document.body.append(body);
  if (sidebar) mountSidebar(body);

  requestAnimationFrame(() => document.body.classList.add('theme-ready'));
  return content;
}

function pageLabel(id) {
  return bus.config.ui.pages.find((p) => p.id === id)?.label || id;
}
