/**
 * gox-purge.js — Draco's GOX purge controller (G, in the browser).
 *
 * In the seconds before a hot fire, LOX sitting in the run line boils, and
 * the gas collects at the main valve. The Dragon thermocouple (TC3) reads it:
 * a pocket of GOX reads warm, liquid back at the valve reads cold. This loop
 * holds PB6 (SV-GOX-PURGE) on a temperature band to bleed that gas off:
 *
 *   Dragon ≥ openAt    PB6 OPEN    gas at the valve, bleed it
 *   Dragon ≤ closeAt   PB6 CLOSED  liquid is back
 *   in between         no change   the deadband
 *
 * PB6 never stays open longer than `maxOpenMs` at a stretch. Reaching that
 * closes it, and the controller stays ON.
 *
 * Every close the loop makes — on temperature or on max open time — is
 * followed by at least `dwellMs` closed before PB6 may open again. That is
 * what stops a max-open close from reopening on the very next tick while
 * Dragon is still warm, and it keeps a ball valve from being cycled faster
 * than it can travel. The first opening after the loop is turned on does
 * not wait.
 *
 * THE HOT-FIRE INTERLOCK
 *   Starting ANY autosequence turns this controller off and commands PB6
 *   closed first, inside Sequencer.start and before its first step can run
 *   (see `beforeSequence`). If PB6 cannot be commanded closed, the sequence
 *   does not start. Matching "any sequence" rather than the hot-fire one by
 *   name is deliberate: sequences are renamed and copied in the editor, and
 *   a copy of the hot fire that slipped past a name match is exactly the
 *   case this exists for. The one sequence never refused is the abort.
 *
 *   The controller also goes off on DISARM, on ABORT, if TC3 loses its
 *   reading, and if PB6 is closed by hand. It cannot be turned on while a
 *   sequence is running. While it is on, PB6 cannot be OPENED by hand
 *   (state.js), because then two things would be driving one valve.
 */

export const GOX_VALVE = 'SV-GOX-PURGE';   // PB6
export const GOX_SENSOR = 'TC3';           // Dragon

/** Upper bound on one opening, whatever the browser asks for. */
export const MAX_OPEN_LIMIT_MS = 60000;
/** Upper bound on the closed dwell between openings. */
export const MAX_DWELL_MS = 60000;
const SETTING_KEYS = ['openAt', 'closeAt', 'maxOpenMs', 'dwellMs'];

export class GoxPurge {
  constructor(stand) {
    this.stand = stand;
    this.enabled = false;
    this.settings = null;      // { openAt, closeAt, maxOpenMs, dwellMs }
    this.openedAt = 0;         // when this controller last opened PB6, 0 when closed
    this.closedAt = 0;         // when this controller last closed PB6; the dwell runs from here
    this.enabledAt = 0;
    this.lastOff = null;       // { reason, at, source }
  }

  /** True on a stand that has both PB6 and the Dragon TC. */
  get available() {
    return Boolean(this.stand.configStore.valve(GOX_VALVE))
      && this.stand.config.sensors.some((s) => s.id === GOX_SENSOR);
  }

  /** While enabled, PB6 is this loop's valve. */
  owns(id) { return this.enabled && id === GOX_VALVE; }

  /**
   * POST /api/gox-purge. `{ enable: true, ...settings }` turns it on,
   * `{ enable: false }` off, settings alone retune it (live, if on).
   */
  set(body = {}, source = 'operator') {
    if (body.enable === false) return this.disable('turned off by operator', source);

    const hasSettings = SETTING_KEYS.some((k) => body[k] !== undefined);
    if (hasSettings) {
      const checked = checkSettings({ ...this.settings, ...pick(body) });
      if (!checked.ok) return checked;
      const changed = JSON.stringify(checked.settings) !== JSON.stringify(this.settings);
      this.settings = checked.settings;
      if (changed && this.enabled) {
        this.stand.log('control', `GOX purge retuned — ${describe(this.settings)}`, source);
      }
    }

    if (body.enable === true) return this.enable(source);
    this.stand.emit('telemetry', this.stand.snapshot());
    return { ok: true };
  }

  enable(source = 'operator') {
    const stand = this.stand;
    if (this.enabled) return { ok: true };
    if (!this.available) return { ok: false, error: `This stand has no ${GOX_VALVE} (PB6) and ${GOX_SENSOR} (Dragon)` };
    if (!this.settings) return { ok: false, error: 'Set the GOX purge band and max open time first' };
    if (stand.abortState.active) return { ok: false, error: 'Stand is in ABORT' };
    if (!stand.armed) return { ok: false, error: 'GOX purge controller requires the stand to be ARMED' };
    if (stand.sequencer.running) {
      return { ok: false, error: 'An autosequence is running — the GOX purge controller cannot be turned on during one' };
    }
    if (stand.bangbang.ownedValves().has(GOX_VALVE)) {
      return { ok: false, error: `${GOX_VALVE} is under bang-bang control` };
    }
    if (!Number.isFinite(stand.readings[GOX_SENSOR])) {
      return { ok: false, error: `${GOX_SENSOR} (Dragon) has no reading — cannot run the GOX purge controller blind` };
    }

    this.enabled = true;
    this.enabledAt = Date.now();
    // A PB6 that is already open was opened by hand; its clock starts now.
    this.openedAt = stand.valveStates[GOX_VALVE] === 'open' ? Date.now() : 0;
    this.closedAt = 0;
    stand.log('control', `GOX PURGE CONTROLLER ON — ${describe(this.settings)}`, source);
    stand.emit('telemetry', stand.snapshot());
    return { ok: true };
  }

  /**
   * Turn off and command PB6 closed. The close goes out whether or not this
   * loop believes PB6 is open — off means PB6 closed, not "closed if we
   * remember opening it". Returns {ok:false} only if that close failed.
   *
   * A controller that was already off leaves PB6 alone: a valve someone
   * opened by hand with the loop off is theirs.
   */
  disable(reason, source = 'gox-purge', { quiet = false } = {}) {
    const stand = this.stand;
    const wasOn = this.enabled;
    this.enabled = false;
    this.openedAt = 0;
    this.closedAt = 0;

    let closeError = null;
    if (wasOn && stand.configStore.valve(GOX_VALVE)) {
      // `fromAbort` so that nothing — ABORT included — can hold this close back.
      const res = stand.commandValve(GOX_VALVE, 'closed', { source, internal: true, fromAbort: true });
      if (!res.ok) closeError = res.error;
    }

    if (wasOn) {
      this.lastOff = { reason, at: Date.now(), source };
      stand.log(closeError ? 'error' : 'control',
        `GOX PURGE CONTROLLER OFF (${reason})` +
        (closeError ? ` — PB6 FAILED TO CLOSE: ${closeError}` : ' — PB6 closed'),
        source);
    }
    if (!quiet) stand.emit('telemetry', stand.snapshot());
    return closeError ? { ok: false, error: `PB6 (${GOX_VALVE}) failed to close: ${closeError}` } : { ok: true };
  }

  /**
   * Called by Sequencer.start before anything else happens. Off, and PB6
   * closed, or the sequence does not start — except the abort sequence,
   * which nothing refuses.
   */
  beforeSequence(cfg, source = 'sequencer') {
    if (!this.enabled) return { ok: true };
    const res = this.disable(`autosequence "${cfg.name}" starting`, source, { quiet: true });
    const isAbort = cfg.id === this.stand.config.safety?.abortSequenceId;
    if (!res.ok && !isAbort) {
      return { ok: false, error: `${res.error} — "${cfg.name}" not started` };
    }
    return { ok: true };
  }

  /** A hand command on PB6, from state.js. A close turns the loop off. */
  handCommand(id, state, source) {
    if (!this.owns(id)) return { ok: true };
    if (state === 'open') {
      return { ok: false, error: 'PB6 is driven by the GOX purge controller — turn it off (G) before opening it by hand' };
    }
    this.disable('PB6 closed by hand', source, { quiet: true });
    return { ok: true, handled: true };
  }

  /** Every tick. */
  update(readings, now) {
    if (!this.enabled) return;
    const stand = this.stand;
    const s = this.settings;
    const t = readings[GOX_SENSOR];
    const open = stand.valveStates[GOX_VALVE] === 'open';

    if (stand.abortState.active) return void this.disable('abort');
    if (!stand.armed) return void this.disable('stand disarmed');
    if (stand.sequencer.running) return void this.disable('autosequence running');
    if (!Number.isFinite(t)) return void this.disable(`${GOX_SENSOR} (Dragon) lost its reading`);

    if (open) {
      if (!this.openedAt) this.openedAt = now;
      if (now - this.openedAt >= s.maxOpenMs) {
        stand.log('control',
          `GOX purge: PB6 open the max ${fmtS(s.maxOpenMs)} with Dragon at ${t.toFixed(1)} °F — closing, ${fmtS(s.dwellMs)} dwell`,
          'gox-purge');
        this.command('closed', now);
      } else if (t <= s.closeAt) {
        this.command('closed', now);
      }
    } else {
      this.openedAt = 0;
      if (t >= s.openAt && this.dwellLeft(now) <= 0) this.command('open', now);
    }
  }

  /** ms before PB6 may open again; 0 when it may. */
  dwellLeft(now = Date.now()) {
    if (!this.closedAt || !this.settings) return 0;
    return Math.max(0, this.settings.dwellMs - (now - this.closedAt));
  }

  command(state, now) {
    const res = this.stand.commandValve(GOX_VALVE, state, { source: 'gox-purge', internal: true });
    if (!res.ok) return void this.disable(`PB6 would not ${state === 'open' ? 'open' : 'close'}: ${res.error}`);
    this.openedAt = state === 'open' ? now : 0;
    if (state === 'closed') this.closedAt = now;
  }

  snapshot() {
    return {
      available: this.available,
      valve: GOX_VALVE,
      sensor: GOX_SENSOR,
      enabled: this.enabled,
      enabledAt: this.enabledAt,
      settings: this.settings ? { ...this.settings } : null,
      openedAt: this.openedAt || null,
      // The dwell runs on the server's clock; the browser counts it down
      // from here.
      closedAt: this.enabled && this.closedAt ? this.closedAt : null,
      lastOff: this.lastOff ? { ...this.lastOff } : null,
      limits: { maxOpenMs: MAX_OPEN_LIMIT_MS, dwellMs: MAX_DWELL_MS },
    };
  }
}

function pick(body) {
  const out = {};
  for (const k of SETTING_KEYS) if (body[k] !== undefined) out[k] = Number(body[k]);
  return out;
}

export function checkSettings(s) {
  const { openAt, closeAt, maxOpenMs, dwellMs } = s || {};
  if (![openAt, closeAt, maxOpenMs, dwellMs].every(Number.isFinite)) {
    return { ok: false, error: 'Open temperature, close temperature, max open time and dwell time are all required' };
  }
  if (openAt <= closeAt) {
    return { ok: false, error: `The open temperature (${openAt} °F) must be above the close temperature (${closeAt} °F)` };
  }
  if (maxOpenMs <= 0 || maxOpenMs > MAX_OPEN_LIMIT_MS) {
    return { ok: false, error: `Max open time must be between 0 and ${MAX_OPEN_LIMIT_MS / 1000} s` };
  }
  if (dwellMs < 0 || dwellMs > MAX_DWELL_MS) {
    return { ok: false, error: `Dwell time must be between 0 and ${MAX_DWELL_MS / 1000} s` };
  }
  return { ok: true, settings: { openAt, closeAt, maxOpenMs, dwellMs } };
}

function describe(s) {
  return `open ≥ ${s.openAt} °F, close ≤ ${s.closeAt} °F, max open ${fmtS(s.maxOpenMs)}, dwell ${fmtS(s.dwellMs)}`;
}

function fmtS(ms) { return `${(ms / 1000).toFixed(1)} s`; }
