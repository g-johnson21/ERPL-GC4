/**
 * gn2-press.js — the GN2 bang-bang loop, run here in the ground station.
 *
 * MOE's COPVs are filled from the ground GN2 bottles through GN2 BANG-BANG
 * PRESS (a solenoid on the supply, PANDA DC15) and GROUND GN2 PRESS (the
 * ball valve that isolates the fill line). This loop pulses the solenoid
 * against one pressure transducer:
 *
 *   PT ≥ setpoint + deadband   solenoid CLOSED
 *   PT < setpoint − deadband   solenoid OPEN (once the dwell has passed)
 *   in between                 no change
 *
 * One opening lasts at most `maxOpenMs`. A close on that cap, short of the
 * top of the band, keeps the loop pulsing (after the dwell) until the top of
 * the band is reached — the cap meters the flow, it does not end the fill.
 * Every close is followed by at least `minIntervalMs` closed.
 *
 * THIS IS NOT THE PANDA'S LOOP. LOX and fuel tank pressurization still run
 * on the board (bangbang.js). Only GN2 runs here, so the transducer it
 * regulates on can be any pressure channel the stand has, and can be changed
 * while ARMED from the GN2 card or the COPV Press Tool.
 *
 * THE OVERPRESSURE CLOSE (a second, independent layer)
 *   `overpressure` is NOT the setpoint. Whenever the selected PT reads at or
 *   above it, GN2 BANG-BANG PRESS and GROUND GN2 PRESS are both commanded
 *   closed and the loop is turned off — whether the loop was on or not, so a
 *   valve opened by hand is closed too. While the PT stays over it, neither
 *   valve can be opened by hand. It must sit above the top of the band, so
 *   ordinary regulation never reaches it.
 *
 * The loop also goes off on DISARM, on ABORT, on safe-all, if its PT loses
 * its reading (a host loop cannot regulate blind), and if the solenoid is
 * closed by hand. While it is on, the solenoid cannot be OPENED by hand
 * (state.js), because then two things would be driving one valve.
 */

const SETTING_KEYS = ['sensor', 'setpoint', 'deadband', 'maxOpenMs', 'minIntervalMs', 'overpressure'];

/** Guard rails against a typo, as on the board's cards. */
export const MAX_PULSE_MS = 60000;
export const MAX_DWELL_MS = 60000;

export class Gn2Press {
  constructor(stand) {
    this.stand = stand;
    this.enabled = false;
    this.settings = null;    // { sensor, setpoint, deadband, maxOpenMs, minIntervalMs, overpressure }
    this.openedAt = null;    // when this loop last opened the solenoid, null while closed
    this.closedAt = null;    // when it last closed it; the dwell runs from here
    this.capped = false;     // the last close was the pulse cap, short of the band top
    this.enabledAt = 0;
    this.cycles = 0;
    this.fault = null;
    this.trip = null;        // { at, value, sensor, limit } — the last overpressure close
    this.sync();
  }

  /** This stand's `gn2Press` section, or null. */
  get cfg() { return this.stand.config.gn2Press ?? null; }
  get available() { return Boolean(this.cfg); }

  /**
   * After a config reload. Live settings survive, as a board controller's do;
   * a removed section turns the loop off.
   */
  sync() {
    const cfg = this.cfg;
    if (!cfg) {
      if (this.enabled) this.disable('GN2 press removed from the config');
      this.settings = null;
      return;
    }
    const prev = this.settings;
    this.settings = {
      sensor: prev?.sensor ?? cfg.sensor,
      setpoint: prev?.setpoint ?? cfg.setpoint,
      deadband: prev?.deadband ?? cfg.deadband,
      maxOpenMs: prev?.maxOpenMs ?? cfg.maxOpenMs ?? 0,
      minIntervalMs: prev?.minIntervalMs ?? cfg.minIntervalMs ?? 0,
      overpressure: prev?.overpressure ?? cfg.overpressure,
    };
    if (!this.stand.config.sensors.some((s) => s.id === this.settings.sensor)) this.settings.sensor = cfg.sensor;
  }

  /** While on, the solenoid is this loop's valve. */
  owns(id) { return this.enabled && id === this.cfg?.valve; }

  /** The two valves the overpressure close shuts. */
  guardedValves() {
    const cfg = this.cfg;
    return cfg ? [cfg.valve, cfg.isolationValve].filter(Boolean) : [];
  }

  reading(readings = this.stand.readings) {
    return this.settings ? readings[this.settings.sensor] : undefined;
  }

  /**
   * POST /api/gn2-press. Settings retune it (live, if on); `enabled` turns it
   * on or off. Every setting may change while ARMED — the PT included.
   */
  set(body = {}, source = 'operator') {
    const stand = this.stand;
    if (!this.available) return { ok: false, error: 'This stand has no GN2 press controller' };
    if (body.enabled === false) return this.disable('turned off by operator', source);

    if (SETTING_KEYS.some((k) => body[k] !== undefined)) {
      const merged = { ...this.settings };
      for (const k of SETTING_KEYS) {
        if (body[k] !== undefined) merged[k] = k === 'sensor' ? String(body[k]) : Number(body[k]);
      }
      const checked = this.check(merged);
      if (!checked.ok) return checked;
      const sensorChanged = merged.sensor !== this.settings.sensor;
      if (sensorChanged && !Number.isFinite(stand.readings[merged.sensor])) {
        return { ok: false, error: `${merged.sensor} has no reading — the GN2 loop cannot switch to it` };
      }

      const changes = SETTING_KEYS
        .filter((k) => merged[k] !== this.settings[k])
        .map((k) => `${k} ${this.settings[k]} -> ${merged[k]}`);
      // Switching transducers mid-regulation: close first, so a pulse that
      // started on the old reading is not finished on the new one.
      if (sensorChanged && this.enabled && this.isOpen()) this.command('closed', Date.now(), source);
      this.settings = merged;
      if (sensorChanged) {
        stand.log('command',
          `*** GN2 PRESS PT -> ${merged.sensor} *** — the loop and the overpressure close now read this transducer`,
          source);
      }
      if (changes.length) stand.log('command', `${this.cfg.name || 'GN2 press'}: ${changes.join(', ')}`, source);
    }

    if (body.enabled === true) return this.enable(source);
    stand.emit('telemetry', stand.snapshot());
    return { ok: true };
  }

  check(s) {
    const cfg = this.cfg;
    const sensor = this.stand.config.sensors.find((x) => x.id === s.sensor);
    if (!sensor) return { ok: false, error: `Unknown sensor "${s.sensor}"` };
    if ((sensor.kind ?? 'pressure') !== 'pressure') return { ok: false, error: `${s.sensor} is not a pressure transducer` };
    const nums = ['setpoint', 'deadband', 'maxOpenMs', 'minIntervalMs', 'overpressure'];
    const bad = nums.find((k) => !Number.isFinite(s[k]));
    if (bad) return { ok: false, error: `${bad} must be a number` };
    if (Number.isFinite(cfg.setpointMin) && s.setpoint < cfg.setpointMin ||
        Number.isFinite(cfg.setpointMax) && s.setpoint > cfg.setpointMax) {
      return { ok: false, error: `Setpoint must be between ${cfg.setpointMin ?? 0} and ${cfg.setpointMax} psi` };
    }
    if (s.deadband <= 0 ||
        Number.isFinite(cfg.deadbandMin) && s.deadband < cfg.deadbandMin ||
        Number.isFinite(cfg.deadbandMax) && s.deadband > cfg.deadbandMax) {
      return { ok: false, error: `Deadband must be between ${cfg.deadbandMin ?? 0} and ${cfg.deadbandMax ?? '∞'} psi` };
    }
    if (s.maxOpenMs < 0 || s.maxOpenMs > MAX_PULSE_MS) {
      return { ok: false, error: `Max pulse must be between 0 and ${MAX_PULSE_MS} ms (0 = no limit)` };
    }
    if (s.minIntervalMs < 0 || s.minIntervalMs > MAX_DWELL_MS) {
      return { ok: false, error: `Dwell must be between 0 and ${MAX_DWELL_MS} ms` };
    }
    // The point of the overpressure close is that ordinary regulation never
    // reaches it.
    if (s.overpressure <= s.setpoint + s.deadband) {
      return {
        ok: false,
        error: `Overpressure close (${s.overpressure} psi) must be above the top of the band ` +
               `(${s.setpoint + s.deadband} psi), or regulation would trip it`,
      };
    }
    return { ok: true };
  }

  enable(source = 'operator') {
    const stand = this.stand;
    const cfg = this.cfg;
    if (this.enabled) { stand.emit('telemetry', stand.snapshot()); return { ok: true }; }
    if (!stand.configStore.valve(cfg.valve)) return { ok: false, error: `This stand has no ${cfg.valve} valve` };
    if (stand.abortState.active) return { ok: false, error: 'Stand is in ABORT' };
    if (cfg.requiresArm !== false && !stand.armed) return { ok: false, error: `${cfg.name} requires the stand to be ARMED` };
    if (stand.sequencer.ownsValve?.(cfg.valve)) {
      return { ok: false, error: `${cfg.valve} is driven by the Panda autosequencer — stop the sequence first` };
    }
    const p = this.reading();
    if (!Number.isFinite(p)) return { ok: false, error: `${this.settings.sensor} has no reading — cannot regulate blind` };
    if (p >= this.settings.overpressure) {
      return { ok: false, error: `${this.settings.sensor} reads ${p.toFixed(0)} psi, at or above the ${this.settings.overpressure} psi overpressure close` };
    }

    this.enabled = true;
    this.enabledAt = Date.now();
    this.fault = null;
    this.cycles = 0;
    this.capped = false;
    // A solenoid already open was opened by hand; its pulse clock starts now.
    this.openedAt = this.isOpen() ? Date.now() : null;
    this.closedAt = null;
    stand.log('control', `GN2 PRESS LOOP ON — ${describe(this.settings)}`, source);
    stand.emit('telemetry', stand.snapshot());
    return { ok: true };
  }

  /**
   * Turn off and command the solenoid closed — off means closed, not "closed
   * if we remember opening it". A loop that was already off leaves it alone.
   * GROUND GN2 PRESS is not touched: it is an isolation valve, not the loop's.
   */
  disable(reason, source = 'gn2-press', { fault = null, quiet = false } = {}) {
    const stand = this.stand;
    const wasOn = this.enabled;
    this.enabled = false;
    this.openedAt = null;
    this.capped = false;
    if (fault) this.fault = fault;

    let closeError = null;
    if (wasOn && this.cfg && stand.configStore.valve(this.cfg.valve)) {
      // `fromAbort` so that nothing — ABORT included — can hold this close back.
      const res = stand.commandValve(this.cfg.valve, 'closed', { source, internal: true, fromAbort: true });
      if (!res.ok) closeError = res.error;
    }
    if (wasOn) {
      stand.log(closeError ? 'error' : fault ? 'warn' : 'control',
        `GN2 PRESS LOOP OFF (${reason})` +
        (closeError ? ` — ${this.cfg.valve} FAILED TO CLOSE: ${closeError}` : ` — ${this.cfg.valve} closed`),
        source);
    }
    if (!quiet) stand.emit('telemetry', stand.snapshot());
    return closeError ? { ok: false, error: `${this.cfg.valve} failed to close: ${closeError}` } : { ok: true };
  }

  /**
   * A hand (or sequence) command on a GN2 valve, from state.js. Opening the
   * solenoid under the loop is refused; closing it turns the loop off. Over
   * the overpressure limit, neither guarded valve may be opened at all.
   */
  handCommand(id, state, source) {
    if (!this.available || !this.guardedValves().includes(id)) return { ok: true };
    if (state === 'open') {
      const p = this.reading();
      if (Number.isFinite(p) && p >= this.settings.overpressure) {
        return {
          ok: false,
          error: `${this.settings.sensor} reads ${p.toFixed(0)} psi, at or above the ${this.settings.overpressure} psi ` +
                 'GN2 overpressure close — vent it down first',
        };
      }
      if (this.owns(id)) {
        return { ok: false, error: `${id} is driven by the GN2 press loop — turn it off before opening it by hand` };
      }
      return { ok: true };
    }
    if (this.owns(id)) this.disable(`${id} closed by hand`, source, { quiet: true });
    return { ok: true };
  }

  isOpen() { return this.cfg ? this.stand.valveStates[this.cfg.valve] === 'open' : false; }

  /** Every tick, before the COPV press step looks at the loop. */
  update(readings, now) {
    if (!this.available || !this.settings) return;
    const stand = this.stand;
    const s = this.settings;
    const p = readings[s.sensor];

    // The overpressure close runs whether the loop is on or not.
    if (Number.isFinite(p) && p >= s.overpressure) {
      const open = this.guardedValves().filter((id) => stand.valveStates[id] === 'open');
      // Re-sent at 1 Hz, not the tick rate, if a close did not take.
      const recent = this.trip && now - this.trip.at < 1000;
      if (this.enabled || (open.length && !recent)) return void this.overpressure(p, now);
    }

    if (!this.enabled) return;
    if (stand.abortState.active) return void this.disable('abort');
    if (this.cfg.requiresArm !== false && !stand.armed) return void this.disable('stand disarmed');
    if (!Number.isFinite(p)) return void this.disable(`${s.sensor} lost its reading`, 'gn2-press', { fault: `${s.sensor} lost` });

    const hi = s.setpoint + s.deadband;
    const lo = s.setpoint - s.deadband;
    if (this.isOpen()) {
      this.openedAt ??= now;
      if (p >= hi) {
        this.capped = false;
        this.command('closed', now);
      } else if (s.maxOpenMs > 0 && now - this.openedAt >= s.maxOpenMs) {
        this.capped = true;
        this.command('closed', now);
      }
    } else {
      this.openedAt = null;
      const below = this.capped ? p < hi : p < lo;
      if (below && this.dwellLeft(now) <= 0) this.command('open', now);
    }
  }

  overpressure(p, now) {
    const stand = this.stand;
    const s = this.settings;
    this.trip = { at: now, value: p, sensor: s.sensor, limit: s.overpressure };
    const message = `GN2 OVERPRESSURE: ${s.sensor} ${p.toFixed(0)} psi ≥ ${s.overpressure} psi`;
    this.disable(message, 'gn2-overpressure', { fault: message, quiet: true });
    const failed = [];
    for (const id of this.guardedValves()) {
      if (!stand.configStore.valve(id)) continue;
      const res = stand.commandValve(id, 'closed', { source: 'gn2-overpressure', internal: true, fromAbort: true });
      if (!res.ok) failed.push(`${id}: ${res.error}`);
    }
    stand.log('error',
      `*** ${message} *** — ${this.guardedValves().join(' and ')} commanded CLOSED` +
      (failed.length ? ` — FAILED: ${failed.join('; ')}` : ''),
      'gn2-overpressure');
    stand.emit('telemetry', stand.snapshot());
  }

  /** ms before the solenoid may open again; 0 when it may. */
  dwellLeft(now = Date.now()) {
    if (this.closedAt == null || !this.settings) return 0;
    return Math.max(0, this.settings.minIntervalMs - (now - this.closedAt));
  }

  command(state, now, source = 'gn2-press') {
    const res = this.stand.commandValve(this.cfg.valve, state, { source, internal: true, quietLog: true });
    if (!res.ok) {
      return void this.disable(`${this.cfg.valve} would not ${state === 'open' ? 'open' : 'close'}: ${res.error}`,
        'gn2-press', { fault: res.error });
    }
    if (state === 'open') { this.openedAt = now; this.cycles++; } else { this.openedAt = null; this.closedAt = now; }
  }

  snapshot() {
    const cfg = this.cfg;
    if (!cfg) return { available: false };
    return {
      available: true,
      name: cfg.name,
      valve: cfg.valve,
      isolationValve: cfg.isolationValve ?? null,
      requiresArm: cfg.requiresArm !== false,
      enabled: this.enabled,
      enabledAt: this.enabledAt || null,
      ...this.settings,
      open: this.isOpen(),
      openedAt: this.openedAt,
      dwellLeftMs: this.enabled ? this.dwellLeft() : 0,
      cycles: this.cycles,
      fault: this.fault,
      trip: this.trip ? { ...this.trip } : null,
      limits: {
        setpointMin: cfg.setpointMin ?? 0, setpointMax: cfg.setpointMax ?? null, setpointStep: cfg.setpointStep ?? 1,
        deadbandMin: cfg.deadbandMin ?? 0, deadbandMax: cfg.deadbandMax ?? null,
        maxOpenMs: MAX_PULSE_MS, minIntervalMs: MAX_DWELL_MS,
      },
    };
  }
}

function describe(s) {
  return `${s.sensor} to ${s.setpoint} ±${s.deadband} psi, pulse ${s.maxOpenMs || '∞'} ms, ` +
         `dwell ${s.minIntervalMs} ms, overpressure close ${s.overpressure} psi`;
}
