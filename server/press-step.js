/**
 * press-step.js — one operator-commanded COPV press actuation.
 *
 * The COPV Press Tool (C, in the browser) walks an operator up a list of
 * target pressures. It is NOT a controller: every step is one click of
 * Proceed, and one click is exactly one opening of GROUND GN2 PRESS. That
 * opening ends on the first of:
 *
 *   - GN2 BUS PT reaching the step's target,
 *   - the step's max actuation time running out,
 *   - GN2 BUS PT going stale (no reading means no idea when to stop),
 *   - the valve leaving OPEN by any other hand: an operator closing it, safe
 *     all, an abort.
 *
 * WHY THIS LIVES ON THE SERVER
 *   The close is the safety-critical half of the actuation. A browser tab
 *   that opened the valve and then froze, lost its link, or was closed would
 *   leave a ball valve open on a COPV with nothing watching it. Here the close
 *   runs on the stand's own tick loop, against the same readings every other
 *   interlock uses, and the max time is enforced whatever happens to the
 *   station that asked. The steps, targets and wait between them are the
 *   browser's business — they only decide when the next Proceed is offered.
 */

export const PRESS_VALVE = 'GND-GN2-PRESS';
export const PRESS_SENSOR = 'GN2-BUS-PT';   // the default; a step may name another PT
export const VENT_VALVE = 'GN2-VENT';   // the vehicle's bus vent

/** Upper bound on one actuation, whatever the browser asks for. */
export const MAX_ACTUATION_MS = 120000;

export class PressStep {
  constructor(stand) {
    this.stand = stand;
    this.active = null;   // { target, maxMs, startedAt, startP, by }
    this.last = null;     // the most recent completed step, for every station
  }

  /**
   * Open the press valve for one step. Returns {ok, error}.
   *
   * `force` is the operator's SHIFT override for a bus that already reads at
   * or above the target: the step is allowed, and since the target cannot
   * end it, it runs for the max actuation time. Everything else still ends
   * it — a lost PT, a close from elsewhere, an abort.
   *
   * `sensor` is the PT the step closes on, GN2 BUS PT unless the operator
   * chose another in the tool's setup. Any DAQ pressure channel will do; the
   * boards' own transducers will not, because their readings arrive on the
   * bang-bang heartbeat rather than on this tick.
   */
  start({ target, maxMs, force = false, sensor = PRESS_SENSOR } = {}, source = 'operator') {
    const stand = this.stand;
    if (this.active) return { ok: false, error: 'A press step is already in progress' };

    const valve = stand.configStore.valve(PRESS_VALVE);
    if (!valve) return { ok: false, error: `This stand has no ${PRESS_VALVE} valve` };
    const pt = stand.config.sensors.find((s) => s.id === sensor);
    if (!pt) return { ok: false, error: `This stand has no ${sensor} sensor` };
    if ((pt.kind ?? 'pressure') !== 'pressure') return { ok: false, error: `${sensor} is not a pressure transducer` };

    target = Number(target);
    maxMs = Number(maxMs);
    if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'Target pressure must be a positive number' };
    if (!Number.isFinite(maxMs) || maxMs <= 0) return { ok: false, error: 'Max actuation time must be a positive number' };
    if (maxMs > MAX_ACTUATION_MS) {
      return { ok: false, error: `Max actuation time is limited to ${MAX_ACTUATION_MS / 1000} s per step` };
    }

    const p = stand.readings[sensor];
    if (!Number.isFinite(p)) return { ok: false, error: `${sensor} has no reading — cannot press blind` };
    const overTarget = p >= target;
    if (overTarget && !force) {
      return { ok: false, error: `${sensor} already reads ${p.toFixed(0)} psi, at or above the ${target} psi target` };
    }
    if (stand.valveStates[PRESS_VALVE] === 'open') {
      return { ok: false, error: `${valve.name} is already open — close it before starting a step` };
    }

    // Every interlock (ARM, ABORT, bang-bang and sequencer ownership) is
    // commandValve's, not a copy of it here.
    const res = stand.commandValve(PRESS_VALVE, 'open', { source: 'press-tool' });
    if (!res.ok) return res;

    this.active = { sensor, target, maxMs, startedAt: Date.now(), startP: p, by: source, forced: overTarget };
    stand.log('command',
      overTarget
        ? `COPV press step (OVERRIDE, ${sensor} ${p.toFixed(0)} psi already ≥ ${target} psi target): ${PRESS_VALVE} OPEN for max ${fmtS(maxMs)}`
        : `COPV press step: ${PRESS_VALVE} OPEN — ${sensor} ${p.toFixed(0)} → ${target} psi, max ${fmtS(maxMs)}`,
      source);
    stand.emit('telemetry', stand.snapshot());
    return { ok: true };
  }

  /** Close early. Always permitted — closed is the valve's safe state. */
  stop(reason = 'stopped by operator', source = 'operator') {
    if (!this.active) return { ok: true, idle: true };
    this.finish(reason, Date.now(), source);
    this.stand.emit('telemetry', this.stand.snapshot());
    return { ok: true };
  }

  /** Called every tick, with the tick's readings. */
  update(readings, now) {
    const a = this.active;
    if (!a) return;
    const p = readings[a.sensor];

    if (this.stand.valveStates[PRESS_VALVE] !== 'open') {
      this.finish('valve closed elsewhere', now, 'press-tool', { alreadyClosed: true });
    } else if (!a.forced && Number.isFinite(p) && p >= a.target) {
      this.finish('target reached', now);
    } else if (now - a.startedAt >= a.maxMs) {
      this.finish('max actuation time', now);
    } else if (!Number.isFinite(p)) {
      this.finish(`${a.sensor} lost`, now);
    }
  }

  finish(reason, now, source = 'press-tool', { alreadyClosed = false } = {}) {
    const a = this.active;
    this.active = null;
    const stand = this.stand;

    let closeError = null;
    if (!alreadyClosed) {
      // `internal` so that nothing — not even a sequence that has since
      // claimed the valve — can stop this close from going out.
      const res = stand.commandValve(PRESS_VALVE, 'closed', { source, internal: true, fromAbort: true });
      if (!res.ok) closeError = res.error;
    }

    const endP = stand.readings[a.sensor];
    this.last = {
      sensor: a.sensor,
      target: a.target,
      maxMs: a.maxMs,
      startedAt: a.startedAt,
      endedAt: now,
      durationMs: Math.max(0, now - a.startedAt),
      startP: a.startP,
      endP: Number.isFinite(endP) ? endP : null,
      reason,
    };

    const endText = Number.isFinite(endP) ? `${endP.toFixed(0)} psi` : 'no reading';
    stand.log(closeError ? 'error' : 'command',
      `COPV press step ended (${reason}) after ${fmtS(this.last.durationMs)} — ${a.startP.toFixed(0)} → ${endText}` +
      (closeError ? ` — ${PRESS_VALVE} FAILED TO CLOSE: ${closeError}` : ''),
      source);
  }

  snapshot() {
    return {
      valve: PRESS_VALVE,
      sensor: PRESS_SENSOR,
      vent: VENT_VALVE,
      active: this.active ? { ...this.active } : null,
      last: this.last ? { ...this.last } : null,
    };
  }
}

function fmtS(ms) { return `${(ms / 1000).toFixed(1)} s`; }
