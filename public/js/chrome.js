/* chrome.js — shared header and control sidebar.
 *
 * Both actuation pages (Control Grid and P&ID) mount the identical sidebar, so
 * an operator never has to re-learn a layout when switching views. The whole
 * thing is generated from config: valve groups, controllers, sequences and
 * recording options all come from stand.json.
 */
import { bus } from './bus.js';
import { $, el, clear, icon, fmtDuration, fmtBytes, fmtValue, fmtClock, confirmAction, promptAction, shiftGate, setShiftRequired, toast, valueWidthCh } from './util.js';
import { currentTheme, toggleTheme, applyConfigDefault } from './theme.js';

// ============================================================== HEADER =====

export function mountHeader(activePage) {
  const cfg = bus.config;
  const spectator = bus.spectator;
  const header = el('header.app-header');

  // Nulls filtered rather than passed through: `Node.append` stringifies them
  // into a literal "null" in the header, unlike el()'s own child handling.
  header.append(...[
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
    // Recording opens and closes the team's data files, so it belongs to the
    // operator. Spectators get a badge in its place saying what this window
    // is — the absence of every control is otherwise indistinguishable from a
    // page that failed to finish loading.
    spectator
      ? el('span.spectator-badge', {
          html: `${icon('eye', 13)}<span>SPECTATOR · VIEW ONLY</span>`,
          title: 'This window is served by the read-only spectator port.\n'
               + 'It shows live telemetry and cannot command the stand.',
        })
      : recordingControl(),
    el('div.header-spacer'),
    el('div.header-status#header-status'),
    // Hangs below the header when a hardware link is down. Positioned out of
    // flow and click-through, so it never moves or covers a control.
    el('div.link-alert#link-alert', { role: 'status', 'aria-live': 'assertive' }),
    el('span.clock#header-clock', { text: '--:--:--' }),
    el('button.icon-btn#theme-toggle', {
      title: 'Toggle light / dark theme (T)',
      'aria-label': 'Toggle theme',
      onclick: () => { toggleTheme(); syncThemeIcon(); },
    }),
    // Lock the station: end this browser's session and go back to the PIN
    // prompt. Only where there is a PIN to come back through — a lock that
    // reopens on the next click is a lie.
    bus.auth?.required
      ? el('button.icon-btn#lock-btn', {
          title: 'Lock this station — the PIN will be needed to return (other stations stay unlocked)',
          'aria-label': 'Lock this station',
          html: icon('lock'),
          onclick: () => bus.lock(),
        })
      : null,
    // Nothing to toggle when there is no sidebar to toggle.
    spectator ? null : el('button.icon-btn#sidebar-toggle', {
      title: 'Show / hide control sidebar (\\)',
      'aria-label': 'Toggle sidebar',
      html: icon('panel'),
      onclick: toggleSidebar,
    })
  ].filter(Boolean));

  document.body.prepend(header);
  syncThemeIcon();

  // The link indicators show an age, which has to keep counting between
  // telemetry frames — and especially after they stop arriving, which is
  // exactly when an operator is reading them.
  setInterval(() => {
    $('#header-clock').textContent = fmtClock(Date.now());
    updateHeaderStatus();
  }, 250);

  bus.on('state', () => { lastStateAt = Date.now(); updateHeaderStatus(); updateRecordingControl(); });
  bus.on('connection', updateHeaderStatus);
  updateHeaderStatus();
  updateRecordingControl();

  // Every hotkey below either commands the stand or moves furniture that a
  // spectator does not have, and ABORT in particular must not be bound on a
  // window that cannot abort: a viewer who hits Escape expecting the stand to
  // safe, and is told it did nothing only by a toast, is worse off than one
  // who never believed the key was theirs. Theme stays — it is local.
  if (spectator) {
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;
      if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey) { toggleTheme(); syncThemeIcon(); }
    });
    return;
  }

  document.addEventListener('keydown', (e) => {
    // ABORT, first and unconditionally — including from inside a text field.
    // A panic key that only works when focus happens to be in the right place
    // is not a panic key. The one exception is an open dialog, which owns
    // Escape as its cancel; that path stops the event before it reaches here.
    if (e.key === 'Escape') {
      if (document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      bus.abort('Operator abort (Esc)');
      return;
    }
    // `instanceof Element` because a key event can be targeted at the document
    // itself, which has no `matches` — and an exception thrown here takes the
    // rest of the hotkeys down with it.
    if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;
    if (e.key === '\\') { toggleSidebar(); }
    if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey) { toggleTheme(); syncThemeIcon(); }
  });

  trackShiftKey();
}

/**
 * Mirror the SHIFT key onto the body, so every control that needs it held can
 * light up while it is.
 *
 * Without this the guard is invisible: an operator clicks a valve, nothing
 * happens, and the only feedback is a toast. With it, holding SHIFT shows
 * exactly which buttons just became live before anything is clicked.
 *
 * Reset on blur as well as keyup — alt-tabbing away with SHIFT down otherwise
 * leaves the page believing it is still held.
 */
function trackShiftKey() {
  const set = (on) => document.body.classList.toggle('shift-armed', on);
  document.addEventListener('keydown', (e) => { if (e.key === 'Shift') set(true); });
  document.addEventListener('keyup', (e) => { if (e.key === 'Shift') set(false); });
  window.addEventListener('blur', () => set(false));
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
    node.title = `Zero offsets are applied to: ${tared.join(', ')}\n`
      + (bus.spectator ? 'The operator manages them from the Data page.' : 'Manage them on the Data page.');
    chips.push(node);
  }

  if (s.sequence.running) {
    chips.push(chip(`${s.sequence.name}  T+${s.sequence.t.toFixed(1)}`, 'warn', true));
  }
  // No REC chip: the log control a few inches to the left says the same thing
  // with the file name attached, and two indicators for one fact is how a
  // header runs out of room for the ones that have no duplicate.

  host.append(...chips);
  updateLinkAlert(s);
}

/**
 * The disconnected-device warning strip under the header.
 *
 * The chip alone is a small change in a busy row, and a DAQ that stops
 * delivering leaves every gauge frozen at a plausible value — the most
 * dangerous kind of wrong. So a loss also gets a strip across the top of the
 * page, in the operator's line of sight. It is pointer-events: none and
 * positioned out of flow: it cannot swallow a click on a valve, shift the
 * layout, or need dismissing before ARM or ABORT can be reached.
 *
 * Not shown while the browser itself has lost the server — LINK LOST already
 * says so, and every device state in the snapshot is stale then anyway.
 */
function updateLinkAlert(s) {
  const host = $('#link-alert');
  if (!host) return;
  const down = bus.connected ? (s.driver.devices || []).filter((d) => !d.connected) : [];
  host.hidden = down.length === 0;

  // Rows are rebuilt only when the set of down devices changes; the header
  // refreshes every 250 ms and rebuilding would restart the pulse each time.
  const sig = down.map((d) => `${d.key || d.name}:${d.required}`).join('|');
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    clear(host);
    for (const dev of down) {
      host.append(el(`div.link-alert-row.${dev.required ? 'danger' : 'warn'}`, {},
        el('span.dot'),
        el('strong', { text: `${(dev.key || dev.name || 'device').toUpperCase()} DISCONNECTED` }),
        el('span.link-alert-why')
      ));
    }
  }

  down.forEach((dev, i) => {
    const age = deviceAgeMs(dev, s);
    const wait = waitingMs(dev, s);
    const parts = [dev.lostReason || (age === null ? 'no data received since startup' : 'no data')];
    if (age !== null) parts.push(`last data ${fmtAge(age)} ago`);
    else if (wait !== null) parts.push(`waiting ${fmtAge(wait)}`);
    // Readings are held at their last value rather than blanked, so say so —
    // a steady gauge is exactly what a frozen one looks like.
    // (Only once something has arrived — there is nothing to freeze before.)
    if (age !== null && dev.name === 'nidaq') parts.push('sensor readings are frozen');
    else if (age !== null && dev.name === 'panda') parts.push('valve states and board readings are frozen');
    const why = host.children[i]?.querySelector('.link-alert-why');
    if (why) why.textContent = parts.join(' · ');
  });
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
  // A device that has never delivered but knows when it started counts up
  // from there: "waiting 14 s" separates a DAQ still configuring its cards
  // from one that has been dead since boot.
  const wait = age === null ? waitingMs(dev, snapshot) : null;

  let text, kind;
  if (dev.connected) {
    text = `${label} LIVE`;
    kind = 'ok';
  } else if (wait !== null) {
    text = `${label} ${fmtAge(wait)}`;
    kind = dev.required ? 'danger' : 'warn';
  } else if (age === null) {
    text = `${label} NO LINK`;                 // never said anything
    kind = dev.required ? 'danger' : 'warn';
  } else {
    text = `${label} ${fmtAge(age)}`;
    kind = dev.required ? 'danger' : 'warn';
  }

  const node = chip(text, kind, !dev.connected);

  // The measured rate rides inside the same chip rather than beside it: "is
  // the link up" and "is it keeping up" are one question, and an operator
  // scanning the header should not have to correlate two indicators to answer
  // it. Only while connected — a rate printed next to an age would be a
  // number from before the link dropped.
  const rate = dev.connected && Number.isFinite(dev.rxSampleHz) ? dev.rxSampleHz : null;
  // The DAQ also carries its data age while LIVE. LIVE only means "within
  // the 2 s timeout", and a stream arriving in half-second lumps looks
  // exactly like a healthy one until the age is on screen.
  const liveAge = dev.connected && dev.name === 'nidaq' && age !== null ? fmtAge(age) : null;
  const extra = [rate !== null ? fmtHz(rate) : null, liveAge].filter(Boolean);
  if (extra.length) node.append(el('span.chip-rate', { text: extra.join(' · ') }));

  node.title = [
    dev.detail || label,
    dev.required ? 'required device' : 'optional device',
    age !== null ? `last data ${fmtAge(age)} ago`
      : wait !== null ? `no data yet — waiting ${fmtAge(wait)} since acquisition started`
      : 'no data received since startup',
    ...rateTitle(dev, rate),
  ].join('\n');
  return node;
}

/**
 * The receive-rate lines of a link chip's tooltip.
 *
 * Both numbers are here because they answer different questions. The sample
 * rate is what the stand is actually logging and controlling on, and is the
 * one comparable to the configured sample clock. The frame rate is what the
 * link itself is doing — a sidecar sending ten samples per frame at 10
 * frames/s and one sending twenty at 5 both deliver 100 Hz, and only the
 * frame rate distinguishes them.
 *
 * The configured clock is labelled as configured, never printed bare. A
 * shortfall is worth seeing, but only if it stays obvious which of the two
 * numbers is the measurement.
 */
function rateTitle(dev, rate) {
  if (rate === null) return [];
  const lines = [`updating at ${fmtHz(rate)} — measured here, not reported by the device`];
  // Cards run on unrelated clocks, so each gets its own line; the headline
  // is the slowest clocked one.
  for (const c of dev.rxCards || []) {
    lines.push(`  ${c.card.toUpperCase()}: ${fmtHz(c.hz)}`
      + (Number.isFinite(c.clockHz) ? ` of ${fmtHz(c.clockHz)}` : ''));
  }
  if (Number.isFinite(dev.rxFrameHz)) lines.push(`${dev.rxFrameHz.toFixed(2)} frames/s`);
  if (Number.isFinite(dev.sampleClockHz)) {
    const short = dev.sampleClockHz - rate;
    lines.push(`configured for ${fmtHz(dev.sampleClockHz)}`
      + (short > dev.sampleClockHz * 0.05 ? ` — running ${fmtHz(short)} short` : ''));
  }
  return lines;
}

function fmtHz(hz) {
  if (!Number.isFinite(hz)) return '–– Hz';
  if (Math.abs(hz) >= 10000) return `${(hz / 1000).toFixed(1)} kHz`;
  return `${hz.toFixed(1)} Hz`;
}

/** Age of a device's last frame in ms, or null if it has never sent one. */
function deviceAgeMs(dev, snapshot) {
  return sinceServerMs(dev.lastRxAt, snapshot);
}

/** How long a device that has never delivered has been waiting, or null. */
function waitingMs(dev, snapshot) {
  return dev.lastRxAt ? null : sinceServerMs(dev.waitingSince, snapshot);
}

/** Time since a server-clock timestamp, extended locally between snapshots. */
function sinceServerMs(t, snapshot) {
  if (!t) return null;
  const atSnapshot = Math.max(0, snapshot.t - t);
  const sinceSnapshot = lastStateAt ? Math.max(0, Date.now() - lastStateAt) : 0;
  return atSnapshot + sinceSnapshot;
}

// =========================================================== RECORDING =====

/**
 * Log-file control, in the header, on every page.
 *
 * It lives here rather than in the sidebar for two reasons. It is the same
 * decision from every screen — the Data page has no sidebar and used to have
 * no way to start a recording at all — and it belongs beside the ARMED and
 * link chips, because "are we getting this on tape" is a status question of
 * exactly that kind.
 *
 * NOTHING ELSE STARTS OR STOPS A FILE. Not a sequence, not a countdown, not
 * an abort. A file that opens and closes on its own is a file that ended
 * while the tanks were still up.
 */
function recordingControl() {
  return el('div.rec-control', {},
    el('button.btn.rec-new#rec-new', {
      html: `${icon('record', 13)}<span>Start New Log File</span>`,
      title: 'Open a new CSV. If one is already open it is closed first, so a\n'
           + 'second attempt lands in its own file rather than at the end of the first.',
      onclick: startNewLog,
    }),
    // Only while something is open — a stop button that is never available is
    // clutter, and one that is always available invites a click that does
    // nothing.
    el('button.btn.rec-halt.hidden#rec-halt', {
      html: icon('stop', 13),
      title: 'Close the current log file',
      'aria-label': 'Stop logging',
      onclick: () => bus.stopRecording(),
    }),
    el('button.rec-indicator#rec-indicator', {
      dataset: { active: 'false' },
      title: 'Recording status — click for the recorded files on this machine',
      onclick: toggleFilePopover,
    },
      el('span.rec-dot'),
      el('span.rec-name#rec-name', { text: 'Not Currently Logging' }),
      el('span.rec-meta#rec-meta', { text: '' })
    )
  );
}

const LOG_NAME_KEY = 'gc4-log-name';

/**
 * Close whatever is open and start a fresh file.
 *
 * The name is asked for rather than generated. Every one of these files is
 * read back weeks later, and `Draco_20260827_223832_waterflow.csv` is
 * findable in a way that `..._test.csv` is not. Prefilled with the last name
 * used and submitted on Enter, so a repeat attempt costs one keystroke.
 */
async function startNewLog() {
  const fallback = bus.config.recording.defaultTestName;
  let last = fallback;
  try { last = localStorage.getItem(LOG_NAME_KEY) || fallback; } catch { /* ignore */ }

  const name = await promptAction({
    title: bus.state?.recording?.active ? 'Start a new log file?' : 'Start a log file',
    message: bus.state?.recording?.active
      ? 'The file now open will be closed and a new one started.'
      : 'Everything from this point lands in a new CSV in the recordings folder.',
    label: 'Test name',
    value: last,
    placeholder: fallback,
    confirmLabel: 'START LOGGING',
  });
  if (!name) return;

  try { localStorage.setItem(LOG_NAME_KEY, name); } catch { /* ignore */ }

  // Rolling over is stop-then-start. The server refuses a start while a file
  // is open, deliberately — it is not going to guess that two overlapping
  // recordings were meant to be one.
  if (bus.state?.recording?.active) await bus.stopRecording();
  const res = await bus.startRecording(name);
  if (res.ok) setTimeout(refreshFileList, 400);
}

/** Previous frame's recording flag, so a file closing can refresh the list. */
let lastRecordingActive = null;

function updateRecordingControl() {
  const rec = bus.state?.recording;
  const indicator = $('#rec-indicator');
  if (!rec || !indicator) return;

  indicator.dataset.active = String(rec.active);
  $('#rec-name').textContent = rec.active ? rec.file : 'Not Currently Logging';
  // Rows and size beside the name: the one failure this control can hide is a
  // file that is open but not filling.
  const stats = `${fmtDuration(rec.elapsed)} · ${rec.rows.toLocaleString()} rows · ${fmtBytes(rec.bytes)}`;
  $('#rec-meta').textContent = rec.active ? stats : '';
  // Both the untruncated name and the stats live here, because the header
  // drops one and clips the other when the window is narrow.
  indicator.title = rec.active
    ? `Logging to ${rec.file}\n${stats} @ ${rec.rateHz} Hz\nClick for the recorded files on this machine`
    : 'Nothing is being recorded.\nClick for the recorded files on this machine';
  $('#rec-halt').classList.toggle('hidden', !rec.active);

  if (lastRecordingActive === true && rec.active === false) refreshFileList();
  lastRecordingActive = rec.active;
}

/**
 * The recorded-file list, as a popover off the indicator.
 *
 * It was a permanent panel in the sidebar, which meant the Data page could
 * not reach it and the actuation pages gave it height they needed for the
 * event log. Downloading yesterday's trace is not something anyone does
 * mid-test, so it does not deserve standing screen space.
 */
let closeFilePopover = null;

function toggleFilePopover() {
  if (closeFilePopover) { closeFilePopover(); return; }

  const panel = el('div.rec-files#rec-files', {},
    el('div.section-title', {}, 'Recorded Files',
      el('button.btn.sm.ghost', { html: icon('refresh', 13), title: 'Refresh', onclick: refreshFileList })
    ),
    el('div.file-list#file-list', {}, el('div.empty-note', { text: 'Loading…' }))
  );
  $('#rec-indicator').after(panel);
  refreshFileList();

  // Dismiss on a click anywhere outside. One teardown path for both ways of
  // closing it, so the document listener always goes with the panel rather
  // than outliving it.
  const onDown = (e) => {
    if (panel.contains(e.target) || $('#rec-indicator')?.contains(e.target)) return;
    closeFilePopover();
  };
  closeFilePopover = () => {
    document.removeEventListener('mousedown', onDown);
    panel.remove();
    closeFilePopover = null;
  };
  // Next tick, or the click that opened it closes it again immediately.
  setTimeout(() => { if (closeFilePopover) document.addEventListener('mousedown', onDown); }, 0);
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

/** Compact age: 0.4s, 12s, 3m 05s, 2h 14m. */
function fmtAge(ms) {
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${String(Math.floor(secs % 60)).padStart(2, '0')}s`;
  return `${Math.floor(secs / 3600)}h ${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m`;
}

// ============================================================= SIDEBAR =====

/**
 * Two columns, not one.
 *
 * Stacked, ARM + two bang-bang cards + the sequences + the log came to about
 * 1520px of sidebar against the ~850px an operator station has, so on every
 * screen in the shop the sequence buttons and the event log started below the
 * fold. Running a sequence or reading back what just happened began with a
 * scroll, which is a poor thing to ask of the person working the valves.
 *
 * So the bang-bang cards get a column of their own on the right, and the left
 * column carries the three things an operator reaches for -- ARM/ABORT, the
 * sequences, the log -- top to bottom in the order they are used. Neither
 * column is over the fold on its own.
 */
export function mountSidebar(container) {
  const sidebar = el('aside.sidebar');

  const controllers = controllerSection();
  sidebar.append(
    el('div.sidebar-col.ops', {}, armSection(), sequenceSection(), logSection())
  );
  // A stand with no bang-bang controllers has no second column; the sidebar
  // narrows to the first rather than reserving space for an empty one.
  if (controllers) sidebar.append(el('div.sidebar-col.regulators', {}, controllers));
  else sidebar.classList.add('solo');

  container.append(sidebar);

  bus.on('state', updateSidebar);
  bus.on('log', appendLogLine);
  bus.on('config', renderSequenceList);
  renderSequenceList();
  updateSidebar();
  renderLog();
  return sidebar;
}

// ------------------------------------------------------------ ARM / ABORT --

/**
 * Pinned to the top of the left column — it does not scroll with the rest.
 *
 * ARM, DISARM and ABORT are the three controls whose whole value is being
 * reachable without looking for them. Under a stand with two bang-bang cards
 * and a list of sequences they scrolled off the top, which made the ABORT
 * button's position depend on where someone had last left the scrollbar.
 *
 * The sidebar — not the column — is the scroll container, so the sticky still
 * holds on a screen too short for even one column.
 */
function armSection() {
  return el('div.sidebar-section.pinned', {},
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

/** The bang-bang column's contents, or null when this stand has no controllers. */
function controllerSection() {
  const cfg = bus.config;
  if (!cfg.bangbang.length) return null;

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

  // The tank's colour, taken from the DAQ channel this controller is compared
  // against — LOX blue, fuel red, the same stripe every other card for that
  // group already carries on the Data page, the readout strip and the P&ID
  // bubbles. Two near-identical panels stacked in one column are easy to act
  // on in the wrong order, and the colour separates them before the name has
  // been read. A controller whose sensor is unknown falls back to the plain
  // border rather than picking a colour that means nothing.
  const group = bus.sensorGroup(c.sensor);

  const setpointInput = el('input', {
    type: 'number',
    id: `bb-sp-${c.id}`,
    value: c.setpoint,
    min: c.setpointMin,
    max: c.setpointMax,
    step: c.setpointStep,
    dataset: { configKey: 'setpoint' },
    oninput: (e) => stageControllerInput(c, e.target),
  });

  const deadbandInput = el('input', {
    type: 'number',
    id: `bb-db-${c.id}`,
    value: c.deadband,
    min: c.deadbandMin,
    max: c.deadbandMax,
    step: 1,
    dataset: { configKey: 'deadband' },
    oninput: (e) => stageControllerInput(c, e.target),
  });

  // Gated on `click`, not `change`: a change event carries no modifier keys,
  // and the SHIFT guard has to be able to refuse the toggle before the
  // checkbox has flipped. Disabling stays a bare click — see shiftGate().
  const enableToggle = el('input', {
    type: 'checkbox',
    id: `bb-en-${c.id}`,
    onclick: (e) => {
      const turningOn = e.target.checked;
      if (turningOn && !shiftGate(e, `enable ${c.name}`)) { e.preventDefault(); return; }
      bus.setController(c.id, { enabled: turningOn });
    },
  });

  return el(`div.bb-card#bb-card-${c.id}`, {
    style: group?.color ? { '--group-color': group.color } : {},
  },
    el('div.bb-head', {},
      el('span.bb-name', { text: c.name, title: c.name }),
      el('span.bb-sub', {
        id: `bb-src-${c.id}`,
        title: 'The board regulates on its OWN transducer. The DAQ channel below it is a\n'
             + 'second sensor on the same tank, and the two can legitimately disagree.',
        text: `board PT → ${c.valve}`,
      }),
      el('button.tare-chip.bb-push', {
        id: `bb-push-${c.id}`, text: 'PUSH\nCONFIG', disabled: true,
        'aria-label': 'Push config to Panda',
        title: 'Push config to Panda — send the pending settings for this controller together.',
        onclick: () => pushControllerConfig(c),
      }),
      // Which board bus this is. The letter is the one that goes on the wire,
      // so an operator reading a raw command log can match them up.
      el('span.bb-side', {
        text: c.side ? `BUS ${c.side}` : 'NO BUS',
        title: c.side
          ? `The board's ${c.side === 'L' ? 'LOX' : 'Fuel'} bus. Commands go out as B${c.side}/b${c.side}/x${c.side}.`
          : 'No board side configured — this controller cannot be pushed to the board.',
      }),
      el('div.bb-config-tools', {},
        // This tare zeros the board's own transducer, which the regulator uses.
        el('button.tare-chip#bb-tare-' + c.id, {
          text: 'TARE',
          onclick: () => bus.setController(c.id, { ptTare: true }),
        }),
        el('button.tare-chip.clear.hidden#bb-untare-' + c.id, {
          text: '✕',
          title: "Clear this side's offset. The other side is left alone.",
          onclick: () => bus.setController(c.id, { ptTareClear: true }),
        })
      )
    ),
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
    el('div.bb-config-actions', {},
      el('span.bb-config-status', {
        id: `bb-config-status-${c.id}`, text: 'No pending changes', role: 'status',
      })
    ),
    // The single most consequential control on the card — it hands a tank to
    // a regulator — and it used to be the smallest thing on it, a 34px switch
    // indistinguishable from the auto-vent checkbox two rows up. Full width,
    // and it says what a click will do rather than naming the setting.
    el('label.toggle.lg.bb-enable', { id: `bb-enrow-${c.id}` },
      enableToggle,
      el('span.track'),
      el('span.bb-enable-text', { id: `bb-entext-${c.id}`, text: 'ENABLE BOARD CONTROL' })
    ),
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
 * Start expanded so every setting is available on the control screen.
 * Operators can still collapse the limits, with live values on the summary.
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
      // The summary still reports `abort`, which no longer has a box below it.
      // That is the point: the threshold is a live trip and an operator has to
      // be able to read what it is set to, but it is not something to retune
      // from the actuation screen -- see LIMIT_FIELDS.
      el('span.bb-lim-sum', {
        id: `bb-limsum-${c.id}`,
        text: '',
        title: 'The abort threshold is set in stand.json, not here.',
      })
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
            dataset: { configKey: f.key, nullable: String(Boolean(f.nullable)) },
            oninput: (e) => stageControllerInput(c, e.target),
          })
        );
      })
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
        dataset: { configKey: 'ventAuto' },
        onchange: (e) => stageControllerInput(c, e.target),
      }),
      el('span', { text: 'Board may auto-vent' })
    ),
    // A switch rather than a checkbox, matching the enable control below it:
    // this changes how the board runs the loop, where everything above it in
    // this panel only sets a number the loop uses.
    el('label.toggle.bb-lim-toggle', { id: `bb-predrow-${c.id}` },
      el('input', {
        type: 'checkbox',
        id: `bb-predictive-${c.id}`,
        dataset: { configKey: 'predictive' },
        onchange: (e) => stageControllerInput(c, e.target),
      }),
      el('span.track'),
      el('span', { text: 'Predictive valve shutoff' })
    )
  );
  return details;
}

// Drafts stay in this card, separate from runtime telemetry. Only edited fields
// are sent, so a sequence or another operator can still update untouched values.
function controllerConfigInputs(c) {
  return [...$(`#bb-card-${c.id}`).querySelectorAll('[data-config-key]')];
}

function stageControllerInput(c, input) {
  input.dataset.dirty = 'true';
  updateControllerDraft(c);
}

function updateControllerDraft(c) {
  const card = $(`#bb-card-${c.id}`);
  if (!card) return;
  const pending = controllerConfigInputs(c).some((input) => input.dataset.dirty === 'true');
  const pushing = card.dataset.pushing === 'true';
  const button = $(`#bb-push-${c.id}`);
  button.disabled = !pending || pushing || !bus.state?.controllers?.[c.id]?.side;
  button.textContent = pushing ? 'PUSHING…' : 'PUSH\nCONFIG';
  const status = $(`#bb-config-status-${c.id}`);
  status.textContent = pushing ? 'Sending settings…' : pending ? 'Pending changes — not pushed' : 'No pending changes';
  status.dataset.pending = String(pending);
}

async function pushControllerConfig(c) {
  const card = $(`#bb-card-${c.id}`);
  if (card.dataset.pushing === 'true') return;
  const inputs = controllerConfigInputs(c);
  const edited = inputs.filter((input) => input.dataset.dirty === 'true');
  if (!edited.length) return;
  const patch = {};
  for (const input of edited) {
    const key = input.dataset.configKey;
    if (input.type === 'checkbox') {
      patch[key] = input.checked;
    } else if (input.dataset.nullable === 'true' && input.value === '' && !input.validity.badInput) {
      patch[key] = null;
    } else {
      // Keep invalid drafts visible and send nothing until the whole batch is
      // valid. Cross-field checks (pulse/trip, auto-vent) remain on the server.
      if (input.value.trim() === '' || !Number.isFinite(input.valueAsNumber) ||
          input.validity.rangeUnderflow || input.validity.rangeOverflow || input.validity.badInput) {
        toast(`Enter a valid ${key} within the field's limits`, 'error');
        input.focus();
        return;
      }
      patch[key] = input.valueAsNumber;
    }
  }
  card.dataset.pushing = 'true';
  updateSidebar();
  try {
    const res = await bus.setController(c.id, patch);
    if (res.ok) {
      for (const input of edited) delete input.dataset.dirty;
      toast(`${c.name}: config sent to Panda`, 'success');
    }
    // A refusal keeps the draft intact so the operator can correct and retry.
  } finally {
    delete card.dataset.pushing;
    updateSidebar();
  }
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
    rt.predictive ? 'predictive ON' : null,
  ].filter(Boolean).join(' · ');
}

const LIMITS_OPEN_KEY = 'gc4-bb-limits-open';
function limitsOpen() {
  try { return localStorage.getItem(LIMITS_OPEN_KEY) !== 'false'; } catch { return true; }
}
function saveLimitsOpen(open) {
  try { localStorage.setItem(LIMITS_OPEN_KEY, String(open)); } catch { /* ignore */ }
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
      // Every sequence needs SHIFT: even the ones that only ever safe the
      // stand run a timeline, and starting one by mis-clicking a list is how
      // a purge fires during a fill.
      dataset: { style: seq.style, seqId: seq.id, needsShift: 'true' },
      title: `${seq.description || seq.name}\n${seq.usePandaAutosequencer ? 'Runs on Panda. Stop disarms and safes the stand.\n' : ''}Hold SHIFT and click to run.`,
      onclick: (e) => runSequence(seq, e),
    },
      el('span.seq-dot'),
      el('span', { text: seq.name }),
      el('span.seq-meta', { text: seq.duration ? `${seq.duration.toFixed(0)}s` : '' })
    ));
  }
  updateSidebar();   // apply the current interlocks to the fresh buttons
}

async function runSequence(seq, event) {
  if (!shiftGate(event, `start "${seq.name}"`)) return;
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

// ------------------------------------------------------------ STATE SYNC --

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

    // Board PT tare. Disabled exactly when the server would refuse it, so the
    // control says "not now" by being unavailable rather than by accepting a
    // click and toasting a rejection.
    const tareBtn = $(`#bb-tare-${c.id}`);
    if (tareBtn) {
      const live = rt.enabled || (board && !board.stale && board.state !== 'OFF');
      tareBtn.disabled = Boolean(live) || s.sequence.running;
      const tared = Number.isFinite(rt.ptOffset) && rt.ptOffset !== 0;
      tareBtn.classList.toggle('on', tared);
      // The offset on the face of the button, for the same reason the DAQ
      // tares carry theirs: a zeroed transducer reading 0 psi looks exactly
      // like an untared one sitting at ambient.
      const shown = tared
        ? `${rt.ptOffset > 0 ? '−' : '+'}${Math.abs(rt.ptOffset).toFixed(1)}`
        : 'TARE';
      if (tareBtn.textContent !== shown) tareBtn.textContent = shown;
      tareBtn.title = live
        ? `Cannot zero side ${rt.side} while it is regulating — the loop would read the\n`
          + 'tank as empty and press on top of what is already in it. Disable it first.'
        : s.sequence.running
          ? 'Cannot zero a board transducer while a sequence is running.'
          : tared
            ? `${Math.abs(rt.ptOffset).toFixed(1)} psi is being ${rt.ptOffset > 0 ? 'subtracted from' : 'added to'} `
              + `the board's own transducer.\nClick to re-zero at the current reading.`
            : `Zero the board's own transducer on side ${rt.side} against what it reads now.\n`
              + 'This is the pressure the REGULATOR runs on, and it is saved to the board.';
      $(`#bb-untare-${c.id}`)?.classList.toggle('hidden', !tared || tareBtn.disabled);
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

    // Preserve edited fields across every telemetry frame, including after
    // focus moves to another setting. Untouched fields continue to track live
    // settings. Freeze the config inputs only while their request is in flight.
    const card = $(`#bb-card-${c.id}`);
    const pushing = card?.dataset.pushing === 'true';
    if (card) for (const input of controllerConfigInputs(c)) {
      input.disabled = pushing;
      if (input.dataset.dirty === 'true' || document.activeElement === input) continue;
      const value = rt[input.dataset.configKey];
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = value ?? '';
    }
    updateControllerDraft(c);

    const pred = $(`#bb-predictive-${c.id}`);
    if (pred && document.activeElement !== pred) {
      // The board refuses `e<side>1` while disarmed, so the control mirrors
      // that: unavailable when it could only be turned ON, always available
      // when it could be turned OFF. Same shape as the enable toggle above.
      pred.disabled = pushing || !rt.side || (!s.armed && !pred.checked);
      const row = $(`#bb-predrow-${c.id}`);
      if (row) {
        row.title = rt.predictive
          ? `The board is closing ${c.valve} on predicted overshoot rather than at the band edge.\n`
            + 'Uncheck and push config to return it to plain hysteresis.'
          : s.armed
            ? 'Check and push config to let the board close the press valve early, on where the pressure is headed,\n'
              + 'so the rise after it shuts lands inside the band instead of above it.'
            : 'The board only accepts this while the stand is ARMED.';
      }
    }

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

      const row = $(`#bb-enrow-${c.id}`);
      if (row) {
        // Only turning it ON needs the modifier, so the highlight and the
        // label follow the direction the next click would go.
        row.dataset.needsShift = String(!rt.enabled && !en.disabled);
        row.title = rt.enabled
          ? 'Click to hand the tank back to manual and stop the board regulating.'
          : 'Hold SHIFT and click to let the board regulate this tank.';
      }
      const text = $(`#bb-entext-${c.id}`);
      if (text) text.textContent = rt.enabled ? 'BOARD CONTROL ON' : 'ENABLE BOARD CONTROL';
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

  // Recording lives in the header now, on every page — see recordingControl().
}

// ------------------------------------------------------------- PAGE SETUP --

/** Standard page boot: config, theme, header, layout shell. */
export async function bootPage(pageId, { sidebar = true } = {}) {
  await bus.init();
  applyConfigDefault(bus.config);
  setShiftRequired(bus.config.ui?.requireShiftToActuate !== false);
  document.title = `${bus.config.ui.brand} · ${pageLabel(pageId)}`;

  // Named on <body> so the stylesheet can lay a spectator page out
  // differently — a one-link nav is not worth a row on a phone.
  document.body.classList.toggle('spectator', bus.spectator);
  mountHeader(pageId);

  const body = el('div.app-body');
  const content = el('main.content');
  body.append(content);
  document.body.append(body);
  // The sidebar is the actuation surface — ARM, controllers, sequences. A
  // spectator page never mounts it, whatever the caller asked for.
  if (sidebar && !bus.spectator) mountSidebar(body);

  requestAnimationFrame(() => document.body.classList.add('theme-ready'));
  return content;
}

function pageLabel(id) {
  return bus.config.ui.pages.find((p) => p.id === id)?.label || id;
}
