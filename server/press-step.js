/**
 * press-step.js — one operator-commanded COPV press step.
 *
 * The COPV Press Tool (C, in the browser) walks an operator up a list of
 * target pressures on the vehicle's GN2 bus. Every step is one click of
 * Proceed, and one click is exactly one change of setpoint on the GN2
 * bang-bang loop — the SOFTWARE loop in gn2-press.js, which pulses GN2
 * BANG-BANG PRESS against whichever PT it is set to. (LOX and fuel still
 * regulate on the PANDA; only GN2 runs here.)
 *
 * A step is:
 *
 *   - GROUND GN2 PRESS opened, if it is not already — it isolates the fill
 *     line, and the bang-bang solenoid upstream of it can do nothing to the
 *     bus while it is shut,
 *   - the loop's setpoint set to the step's target, and the loop turned on
 *     (through Gn2Press, so its ARM, ABORT and overpressure checks apply
 *     exactly as on the GN2 card),
 *
 * and the step ENDS on the first of:
 *
 *   - the loop's PT reaching the target — the loop is LEFT RUNNING, holding
 *     the bus at that target until the next Proceed raises it, or Stop,
 *   - the step timeout running out — the loop is turned off,
 *   - the loop going off for any other reason: disarm, abort, a lost PT, the
 *     overpressure close, an operator on the card.
 *
 * The overpressure close in gn2-press.js is the second layer under all of
 * this: whatever the step or the loop is doing, the PT reaching it shuts
 * both GN2 BANG-BANG PRESS and GROUND GN2 PRESS.
 */

export const VENT_VALVE = 'GN2-VENT';   // the vehicle's bus vent

/** Upper bound on one step, whatever the browser asks for. */
export const MAX_STEP_MS = 600000;

export class PressStep {
  constructor(stand) {
    this.stand = stand;
    this.active = null;   // { sensor, target, timeoutMs, startedAt, startP, by }
    this.last = null;     // the most recent completed step, for every station
  }

  get loop() { return this.stand.gn2Press; }

  /**
   * Raise (or set) the GN2 loop's setpoint to `target` and run it.
   * Returns {ok, error}.
   *
   * A target at or below what the bus already reads is allowed: the loop
   * will not press, and the step ends as reached on the next tick. The tool
   * asks for SHIFT before sending one; the server has nothing to protect.
   */
  start({ target, timeoutMs } = {}, source = 'operator') {
    const stand = this.stand;
    const loop = this.loop;
    if (this.active) return { ok: false, error: 'A press step is already in progress' };
    if (!loop?.available) return { ok: false, error: 'This stand has no GN2 press loop' };

    target = Number(target);
    timeoutMs = Number(timeoutMs);
    if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'Target pressure must be a positive number' };
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, error: 'Step timeout must be a positive number' };
    if (timeoutMs > MAX_STEP_MS) {
      return { ok: false, error: `Step timeout is limited to ${MAX_STEP_MS / 1000} s` };
    }
    // The setpoint's own range and its gap under the overpressure close are
    // the loop's to judge — checked BEFORE anything moves.
    const checked = loop.check({ ...loop.settings, setpoint: target });
    if (!checked.ok) return checked;

    const sensor = loop.settings.sensor;
    const p = stand.readings[sensor];
    if (!Number.isFinite(p)) return { ok: false, error: `${sensor} has no reading — cannot judge the step` };

    // The isolation valve first: if the loop then fails to start, an open
    // ball valve behind a shut solenoid moves no gas. Shut again only if this
    // step is what opened it.
    const isolation = loop.cfg.isolationValve;
    let openedIsolation = false;
    if (isolation && stand.configStore.valve(isolation) && stand.valveStates[isolation] !== 'open') {
      const res = stand.commandValve(isolation, 'open', { source: 'press-tool' });
      if (!res.ok) return res;
      openedIsolation = true;
    }

    const res = loop.set({ setpoint: target, enabled: true }, 'press-tool');
    if (!res.ok) {
      if (openedIsolation) stand.commandValve(isolation, 'closed', { source: 'press-tool', internal: true, fromAbort: true });
      return res;
    }

    this.active = { sensor, target, timeoutMs, startedAt: Date.now(), startP: p, by: source };
    stand.log('command',
      `COPV press step: GN2 loop -> ${target} psi (±${loop.settings.deadband}) — ${sensor} at ${p.toFixed(0)} psi, ` +
      `timeout ${fmtS(timeoutMs)}`,
      source);
    stand.emit('telemetry', stand.snapshot());
    return { ok: true };
  }

  /**
   * End the run: the GN2 loop off, GROUND GN2 PRESS shut. Always permitted —
   * both are the safe direction — and works with no step in progress, since
   * the loop is left holding between steps.
   */
  stop(reason = 'stopped by operator', source = 'operator') {
    const stand = this.stand;
    const loop = this.loop;
    if (this.active) this.finish(reason, Date.now(), source);
    if (!loop?.available) return { ok: true };
    if (loop.enabled) loop.disable(reason, source, { quiet: true });
    const isolation = loop.cfg.isolationValve;
    if (isolation && stand.configStore.valve(isolation) && stand.valveStates[isolation] !== 'closed') {
      // `internal` so nothing — a sequence that has claimed it, an ABORT in
      // progress — can stop this close from going out.
      stand.commandValve(isolation, 'closed', { source, internal: true, fromAbort: true });
    }
    stand.emit('telemetry', stand.snapshot());
    return { ok: true };
  }

  /** Stop, then open GN2 VENT. Opening a vent is its safe direction. */
  vent(source = 'operator') {
    const stand = this.stand;
    this.stop('vent', source);
    if (!stand.configStore.valve(VENT_VALVE)) return { ok: false, error: `This stand has no ${VENT_VALVE} valve` };
    return stand.commandValve(VENT_VALVE, 'open', { source });
  }

  /** Called every tick, after the GN2 loop's own update. */
  update(readings, now) {
    const a = this.active;
    if (!a) return;
    const loop = this.loop;
    // The PT can be changed mid-step; the step judges by the loop's.
    if (loop?.settings?.sensor) a.sensor = loop.settings.sensor;
    const p = readings[a.sensor];

    if (!loop?.enabled) {
      this.finish(`loop stopped${loop?.fault ? ` (${loop.fault})` : ''}`, now);
    } else if (Number.isFinite(p) && p >= a.target) {
      // Left running: holding the bus here is the point of the bang-bang.
      this.finish('target reached', now);
    } else if (now - a.startedAt >= a.timeoutMs) {
      loop.disable('COPV press step timeout', 'press-tool', { quiet: true });
      this.finish('step timeout', now);
    }
  }

  finish(reason, now, source = 'press-tool') {
    const a = this.active;
    this.active = null;
    const stand = this.stand;
    const endP = stand.readings[a.sensor];
    this.last = {
      sensor: a.sensor,
      target: a.target,
      timeoutMs: a.timeoutMs,
      startedAt: a.startedAt,
      endedAt: now,
      durationMs: Math.max(0, now - a.startedAt),
      startP: a.startP,
      endP: Number.isFinite(endP) ? endP : null,
      reason,
    };
    const endText = Number.isFinite(endP) ? `${endP.toFixed(0)} psi` : 'no reading';
    const holding = this.loop?.enabled;
    stand.log(['target reached', 'vent', 'stopped by operator'].includes(reason) ? 'command' : 'warn',
      `COPV press step ended (${reason}) after ${fmtS(this.last.durationMs)} — ${a.startP.toFixed(0)} → ${endText}` +
      (holding ? `, holding ${a.target} psi` : ''),
      source);
  }

  snapshot() {
    const loop = this.loop;
    const cfg = loop?.available ? loop.cfg : null;
    return {
      available: Boolean(cfg),
      valve: cfg?.valve ?? null,
      isolation: cfg?.isolationValve ?? null,
      sensor: loop?.settings?.sensor ?? null,
      vent: VENT_VALVE,
      maxStepMs: MAX_STEP_MS,
      active: this.active ? { ...this.active } : null,
      last: this.last ? { ...this.last } : null,
    };
  }
}

function fmtS(ms) { return `${(ms / 1000).toFixed(1)} s`; }
