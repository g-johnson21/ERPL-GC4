/**
 * press-step.js — one operator-commanded COPV press step.
 *
 * The COPV Press Tool (C, in the browser) walks an operator up a list of
 * target pressures on the vehicle's GN2 bus. Every step is one click of
 * Proceed, and one click is exactly one change of setpoint on the PANDA's GN2
 * bang-bang controller (board side G): the press solenoid on the ground
 * supply, regulating on GN2 BUS PT. The ground regulator that used to sit
 * there is gone — the board's loop is now what brings the bus up and holds it.
 *
 * So a step is no longer a valve opening. It is:
 *
 *   - GROUND GN2 PRESS opened, if it is not already — it isolates the fill
 *     line, and the bang-bang solenoid upstream of it can do nothing to the
 *     bus while it is shut,
 *   - the GN2 controller's setpoint set to the step's target, and the
 *     controller enabled (through BangBangBank, so the config echo handshake
 *     and every interlock it has apply here exactly as on the card),
 *
 * and the step ENDS on the first of:
 *
 *   - GN2 BUS PT reaching the target — the controller is LEFT RUNNING, holding
 *     the bus at that target until the next Proceed raises it, or Stop,
 *   - the step timeout running out — the controller is disabled,
 *   - the controller dropping out for any other reason: disarm, abort, a
 *     board ABORT latch, a leak trip, an operator on the card.
 *
 * WHY THIS STILL LIVES ON THE SERVER
 *   The board holds the band, so a browser that freezes mid-step no longer
 *   leaves a valve open with nothing watching — the board is watching. What
 *   the server still owns is the timeout, which must run whatever happens to
 *   the station that asked, and the Stop and Vent sequences, which have to go
 *   out in a fixed order (disable the loop before touching its vent).
 *
 * THE VENT
 *   The firmware drives GN2 VENT as this side's vent: it SEALS it when the
 *   loop is enabled and holds it while regulating, and refuses hand commands
 *   to it meanwhile. Ground control cannot see that write, so a step refuses
 *   to start with GN2 VENT open (the board would close it behind GC's back),
 *   and Vent disables the loop before opening it.
 */
import { commandSide } from './hal/bb-protocol.js';

/** The board side the tool drives. */
export const PRESS_SIDE = 'G';
/** Ground isolation between the bang-bang solenoid and the GN2 QD. */
export const ISOLATION_VALVE = 'GND-GN2-PRESS';
export const VENT_VALVE = 'GN2-VENT';   // the vehicle's bus vent

/** Upper bound on one step, whatever the browser asks for. */
export const MAX_STEP_MS = 600000;

export class PressStep {
  constructor(stand) {
    this.stand = stand;
    this.active = null;   // { controller, sensor, target, timeoutMs, startedAt, startP, by }
    this.last = null;     // the most recent completed step, for every station
  }

  /** The GN2 bang-bang controller's config, or null on a stand without one. */
  controller() {
    return this.stand.config.bangbang?.find((c) => commandSide(c.side) === PRESS_SIDE) ?? null;
  }

  /**
   * Raise (or set) the GN2 controller's setpoint to `target` and run it.
   * Returns {ok, error}.
   *
   * A target at or below what the bus already reads is allowed: the board
   * will not press, and the step ends as reached on the next tick. The tool
   * asks for SHIFT before sending one; the server has nothing to protect.
   */
  start({ target, timeoutMs } = {}, source = 'operator') {
    const stand = this.stand;
    if (this.active) return { ok: false, error: 'A press step is already in progress' };

    const cfg = this.controller();
    if (!cfg) return { ok: false, error: `This stand has no GN2 bang-bang controller (side ${PRESS_SIDE})` };
    const rt = stand.bangbang.get(cfg.id);
    if (!rt) return { ok: false, error: `${cfg.name || cfg.id} is not loaded` };

    target = Number(target);
    timeoutMs = Number(timeoutMs);
    if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'Target pressure must be a positive number' };
    // Refused rather than clamped: BangBangBank clamps a setpoint into range
    // silently, and a step pressing toward a lower number than its target
    // would never reach it — it would just time out.
    if (Number.isFinite(cfg.setpointMax) && target > cfg.setpointMax) {
      return { ok: false, error: `${target} psi is above ${cfg.name}'s ${cfg.setpointMax} psi setpoint limit` };
    }
    if (Number.isFinite(cfg.setpointMin) && target < cfg.setpointMin) {
      return { ok: false, error: `${target} psi is below ${cfg.name}'s ${cfg.setpointMin} psi setpoint limit` };
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, error: 'Step timeout must be a positive number' };
    if (timeoutMs > MAX_STEP_MS) {
      return { ok: false, error: `Step timeout is limited to ${MAX_STEP_MS / 1000} s` };
    }

    const p = stand.readings[cfg.sensor];
    if (!Number.isFinite(p)) return { ok: false, error: `${cfg.sensor} has no reading — cannot judge the step` };

    const vent = stand.configStore.valve(VENT_VALVE);
    if (vent && stand.valveStates[VENT_VALVE] === 'open') {
      return {
        ok: false,
        error: `${vent.name} is open — seal it first. The board seals it itself when the loop starts, ` +
               'and ground control would no longer know which way it is',
      };
    }

    // The isolation valve first: if the loop then fails to start, an open
    // ball valve behind a shut solenoid moves no gas. Shut again only if this
    // step is what opened it.
    let openedIsolation = false;
    if (stand.configStore.valve(ISOLATION_VALVE) && stand.valveStates[ISOLATION_VALVE] !== 'open') {
      const res = stand.commandValve(ISOLATION_VALVE, 'open', { source: 'press-tool' });
      if (!res.ok) return res;
      openedIsolation = true;
    }

    // Every interlock (ARM, a board ABORT latch, the autosequencer, the
    // config echo handshake) is BangBangBank's, not a copy of it here.
    const res = stand.bangbang.set(cfg.id, { setpoint: target, enabled: true }, 'press-tool');
    if (!res.ok) {
      if (openedIsolation) stand.commandValve(ISOLATION_VALVE, 'closed', { source: 'press-tool', internal: true, fromAbort: true });
      return res;
    }

    this.active = {
      controller: cfg.id, sensor: cfg.sensor, target, timeoutMs,
      startedAt: Date.now(), startP: p, by: source,
    };
    stand.log('command',
      `COPV press step: ${cfg.name} -> ${target} psi (±${rt.deadband}) — ${cfg.sensor} at ${p.toFixed(0)} psi, ` +
      `timeout ${fmtS(timeoutMs)}`,
      source);
    stand.emit('telemetry', stand.snapshot());
    return { ok: true };
  }

  /**
   * End the run: the GN2 loop off, GROUND GN2 PRESS shut. Always permitted —
   * both are the safe direction — and works with no step in progress, since
   * the controller is left holding between steps.
   */
  stop(reason = 'stopped by operator', source = 'operator') {
    const stand = this.stand;
    const cfg = this.controller();
    if (this.active) this.finish(reason, Date.now(), source);
    if (cfg && stand.bangbang.get(cfg.id)?.enabled) {
      stand.bangbang.set(cfg.id, { enabled: false }, source);
    }
    if (stand.configStore.valve(ISOLATION_VALVE) && stand.valveStates[ISOLATION_VALVE] !== 'closed') {
      // `internal` so nothing — a sequence that has claimed it, an ABORT in
      // progress — can stop this close from going out.
      stand.commandValve(ISOLATION_VALVE, 'closed', { source, internal: true, fromAbort: true });
    }
    stand.emit('telemetry', stand.snapshot());
    return { ok: true };
  }

  /**
   * Stop, then open GN2 VENT. In that order and on one serial link, so the
   * board has left SUS — and given the vent channel back — before the open
   * reaches it. `internal` because ground control still counts the vent as
   * the loop's until the next heartbeat says otherwise.
   */
  vent(source = 'operator') {
    const stand = this.stand;
    this.stop('vent', source);
    const valve = stand.configStore.valve(VENT_VALVE);
    if (!valve) return { ok: false, error: `This stand has no ${VENT_VALVE} valve` };
    const res = stand.commandValve(VENT_VALVE, 'open', { source, internal: true, fromAbort: true });
    if (res.ok) stand.log('command', `${VENT_VALVE} (${valve.name}) -> OPEN (COPV press tool vent)`, source);
    return res;
  }

  /** Called every tick, with the tick's readings. */
  update(readings, now) {
    const a = this.active;
    if (!a) return;
    const rt = this.stand.bangbang.get(a.controller);
    const p = readings[a.sensor];

    if (!rt?.enabled) {
      this.finish(`controller stopped${rt?.fault ? ` (${rt.fault})` : ''}`, now);
    } else if (Number.isFinite(p) && p >= a.target) {
      // Left running: holding the bus here is the point of the bang-bang.
      this.finish('target reached', now);
    } else if (now - a.startedAt >= a.timeoutMs) {
      this.stand.bangbang.set(a.controller, { enabled: false }, 'press-tool');
      this.finish('step timeout', now);
    }
    // A lost reading does not end the step: the board regulates on its own
    // PT whatever the ground sees, and the timeout still bounds it.
  }

  finish(reason, now, source = 'press-tool') {
    const a = this.active;
    this.active = null;
    const stand = this.stand;
    const endP = stand.readings[a.sensor];
    this.last = {
      controller: a.controller,
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
    const holding = stand.bangbang.get(a.controller)?.enabled;
    stand.log(reason === 'target reached' || reason === 'vent' || reason === 'stopped by operator' ? 'command' : 'warn',
      `COPV press step ended (${reason}) after ${fmtS(this.last.durationMs)} — ${a.startP.toFixed(0)} → ${endText}` +
      (holding ? `, holding ${a.target} psi` : ''),
      source);
  }

  snapshot() {
    const cfg = this.controller();
    return {
      controller: cfg?.id ?? null,
      valve: cfg?.valve ?? null,
      sensor: cfg?.sensor ?? null,
      setpointMax: cfg?.setpointMax ?? null,
      isolation: ISOLATION_VALVE,
      vent: VENT_VALVE,
      maxStepMs: MAX_STEP_MS,
      active: this.active ? { ...this.active } : null,
      last: this.last ? { ...this.last } : null,
    };
  }
}

function fmtS(ms) { return `${(ms / 1000).toFixed(1)} s`; }
