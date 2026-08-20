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

  setInterval(() => { $('#header-clock').textContent = fmtClock(Date.now()); }, 250);

  bus.on('state', updateHeaderStatus);
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

function updateHeaderStatus() {
  const host = $('#header-status');
  if (!host || !bus.state) return;
  const s = bus.state;
  clear(host);

  const chips = [];

  if (!bus.connected) {
    chips.push(chip('LINK LOST', 'danger', true));
  } else if (!s.driver.connected) {
    chips.push(chip(`${s.driver.name.toUpperCase()} NO LINK`, 'danger', true));
  } else {
    chips.push(chip(s.driver.name.toUpperCase(), 'info'));
  }

  if (s.abort.active) chips.push(chip('ABORT', 'danger', true));
  else if (s.armed) chips.push(chip('ARMED', 'danger', true));
  else chips.push(chip('SAFE', 'ok'));

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
      el('span.bb-sub', { text: `${c.sensor} → ${c.valve}` })
    ),
    el('div.bb-readout', {},
      // Reserved width keeps the units label and the FILLING/HOLD badge from
      // shifting as the pressure reading swings.
      el('span.now', {
        id: `bb-now-${c.id}`,
        style: { minWidth: `${sensor ? valueWidthCh(sensor) : 6}ch` },
        text: '––––',
      }),
      el('span.tgt', { text: sensor?.units || '' }),
      el('span.out', { id: `bb-out-${c.id}`, text: 'HOLD', dataset: { on: 'false' } })
    ),
    el('div.bb-track', {},
      el('i.band', { id: `bb-band-${c.id}` }),
      el('i.needle', { id: `bb-needle-${c.id}` })
    ),
    el('div.bb-inputs', {},
      el('div', {}, el('label.field', { for: `bb-sp-${c.id}`, text: `Setpoint (${sensor?.units || ''})` }), setpointInput),
      el('div', {}, el('label.field', { for: `bb-db-${c.id}`, text: 'Deadband ±' }), deadbandInput)
    ),
    el('label.toggle', {}, enableToggle, el('span.track'), el('span', { text: 'Enable control' })),
    el('div.bb-fault.hidden', { id: `bb-fault-${c.id}` })
  );
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
  const sequences = bus.config.autosequences.filter((s) => !s.hidden);

  return el('div.sidebar-section', {},
    el('div.section-title', {}, 'Autosequences'),
    el('div#seq-running'),
    el('div.seq-list', {}, sequences.map((seq) =>
      el('button.seq-btn', {
        dataset: { style: seq.style, seqId: seq.id },
        title: seq.description || seq.name,
        onclick: () => runSequence(seq),
      },
        el('span.seq-dot'),
        el('span', { text: seq.name }),
        el('span.seq-meta', { text: seq.duration ? `${seq.duration.toFixed(0)}s` : '' })
      )
    )),
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

    const now = $(`#bb-now-${c.id}`);
    if (now) now.textContent = fmtValue(value, sensor?.decimals ?? 1);

    const out = $(`#bb-out-${c.id}`);
    if (out) {
      out.dataset.on = String(rt.output);
      out.textContent = rt.output ? 'FILLING' : 'HOLD';
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
    const needle = $(`#bb-needle-${c.id}`);
    if (needle && Number.isFinite(value)) {
      needle.style.left = `${Math.max(0, Math.min(100, ((value - lo) / span) * 100))}%`;
    }

    const sp = $(`#bb-sp-${c.id}`);
    if (sp && document.activeElement !== sp) sp.value = rt.setpoint;
    const db = $(`#bb-db-${c.id}`);
    if (db && document.activeElement !== db) db.value = rt.deadband;

    const en = $(`#bb-en-${c.id}`);
    if (en) {
      en.checked = rt.enabled;
      en.disabled = s.abort.active || (c.requiresArm && !s.armed && !rt.enabled);
    }

    const fault = $(`#bb-fault-${c.id}`);
    if (fault) {
      fault.classList.toggle('hidden', !rt.fault);
      fault.textContent = rt.fault ? `⚠ ${rt.fault}` : '';
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
