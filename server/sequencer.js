/**
 * sequencer.js — time-based autosequence engine.
 *
 * A sequence is a list of steps, each with a time `t` in seconds from
 * sequence start. Steps fire in order once wall-clock elapsed >= t, so a
 * sequence keeps real time even if a tick is late (it will fire any steps it
 * skipped over, in order, rather than silently dropping them).
 *
 * While a sequence runs, its `abortConditions` are evaluated every tick.
 * Any tripped condition aborts the stand immediately.
 *
 * A `gate` step checks sensor conditions at a point in the timeline -- e.g.
 * "LOX manifold pressure is above X" after the LOX run valve opens. The
 * conditions get `timeout` seconds to come good and must then stay good for
 * `hold` seconds. A blocking gate (the default) holds the clock while it
 * waits, so nothing after it fires until it passes, and every later step
 * slips by the time spent waiting. A gate that fails runs its `onFail`:
 *   abort     latch a stand-wide ABORT (the default)
 *   sequence  stop this sequence and start `failSequence` in its place
 *   safeAll   stop this sequence and drive every actuator safe
 *   setValves drive `failValves` [{valve, state}] to their states regardless
 *             (turning off any loop holding one), then stop unless
 *             `failStop` is false
 *   stop      stop this sequence, leave the actuators where they are
 *   continue  log the failure and carry on
 * A missing or non-numeric reading never satisfies a condition.
 */

import { encodeSequence } from './hal/sequence-protocol.js';
// Pure (no DOM): the editor describes a gate in the same words the log does.
import { gateLabel } from '../public/js/seq-model.js';

export class Sequencer {
  constructor(controller) {
    this.stand = controller;
    this.active = null;
  }

  get running() { return this.active !== null; }

  pandaDevice() {
    const driver = this.stand.driver;
    return driver.sequenceDevice?.() ?? (driver.sequenceUpload ? driver : null);
  }

  pandaConfig(cfg) {
    const panda = this.pandaDevice();
    if (!panda) throw new Error('This driver has no Panda autosequencer');
    // The board would run a gated valve step unconditionally.
    if (cfg.steps.some((s) => s.gate)) throw new Error('Gated steps cannot run on the Panda autosequencer');
    const encoded = encodeSequence(cfg, this.stand.config.valves);
    for (const step of encoded.steps) {
      const valve = this.stand.configStore.valve(step.target);
      if (this.stand.driver.deviceFor && this.stand.driver.deviceFor(valve).driver !== panda) {
        throw new Error(`${valve.id} is not wired to the Panda autosequencer`);
      }
    }
    return { panda, ...encoded };
  }

  async sendToPanda(id, source = 'operator') {
    if (this.running) return { ok: false, error: 'Cannot upload while a sequence is running' };
    const cfg = this.stand.configStore.sequence(id);
    if (!cfg?.usePandaAutosequencer) return { ok: false, error: 'Save this sequence with Use Panda Autosequencer enabled first' };
    try {
      const { panda, command } = this.pandaConfig(cfg);
      const result = await panda.sequenceUpload(command);
      this.stand.log(result.ok ? 'sequence' : 'error', result.ok
        ? `PANDA CONFIG CONFIRMED: ${cfg.name}` : `PANDA CONFIG FAILED: ${result.error}`, source);
      return result;
    } catch (err) { return { ok: false, error: err.message }; }
  }

  ownsValve(id) {
    return Boolean(this.active?.panda && this.active.cfg.steps.some((s) => s.target === id));
  }

  /** Returns {ok, error}. */
  start(id, source = 'operator') {
    const cfg = this.stand.configStore.sequence(id);
    if (!cfg) return { ok: false, error: `Unknown sequence "${id}"` };

    if (this.active) {
      return { ok: false, error: `"${this.active.cfg.name}" is already running — stop it first` };
    }
    if (cfg.requiresArm && !this.stand.armed) {
      return { ok: false, error: `"${cfg.name}" requires the stand to be ARMED` };
    }
    if (this.stand.abortState.active && cfg.id !== this.stand.config.safety.abortSequenceId) {
      return { ok: false, error: 'Stand is in ABORT — clear the abort before running a sequence' };
    }

    // The GOX purge controller goes off, and PB6 closed, before anything of
    // this sequence can run — on the board or here. A PB6 that cannot be
    // closed refuses the start (the abort sequence excepted). See gox-purge.js.
    const purge = this.stand.goxPurge?.beforeSequence(cfg, source);
    if (purge && !purge.ok) return purge;

    let remote = null;
    if (cfg.usePandaAutosequencer) {
      if (!this.stand.armed) return { ok: false, error: 'Panda sequences require the stand to be ARMED' };
      try {
        remote = this.pandaConfig(cfg);
        for (const step of remote.steps) {
          if (this.stand.bangbang.ownedValves().has(step.target)) {
            return { ok: false, error: `${step.target} is under bang-bang control; disable it before running this sequence` };
          }
          // The board runs these steps itself, past every check in
          // commandValve, so the GN2 loop's solenoid is refused here.
          if (this.stand.gn2Press?.owns(step.target)) {
            return { ok: false, error: `${step.target} is under the GN2 press loop; turn it off before running this sequence` };
          }
        }
        const result = remote.panda.sequenceStart(remote.command);
        if (!result.ok) return result;
      } catch (err) { return { ok: false, error: err.message }; }
    } else if (this.pandaDevice()?.sequenceStatus().pending) {
      return { ok: false, error: 'Wait for the Panda config upload to finish' };
    }

    this.active = {
      cfg,
      panda: remote?.panda,
      items: remote?.items,
      nextItem: 0,
      startedAt: Date.now(),
      nextStep: 0,
      source,
      stepLog: [],
      gates: [],        // gate steps still being evaluated
      heldMs: 0,        // time the clock has been held by blocking gates
      holdSince: null,  // when the current hold began, or null
    };
    this.stand.log('sequence', `SEQUENCE START: ${cfg.name}`, source);
    this.stand.emit('sequence-start', cfg);
    return { ok: true };
  }

  /** Stop without safing — steps simply stop firing. */
  stop(reason = 'Stopped by operator', source = 'operator') {
    if (!this.active) return { ok: false, error: 'No sequence is running' };
    const { cfg, panda } = this.active;
    const elapsed = (Date.now() - this.active.startedAt) / 1000;
    this.active = null;
    if (panda) {
      // Firmware has no halt-only command. `r` cancels and de-energizes.
      this.stand.setArmed(false, source);
      this.stand.safeAll(source);
    }
    this.stand.log('sequence', `SEQUENCE HALT: ${cfg.name} at T+${elapsed.toFixed(2)}s — ${reason}`, source);
    this.stand.emit('sequence-end', cfg, 'halted');
    return { ok: true };
  }

  /** Sequence time in seconds: wall time since start, less any gate holds. */
  seqTime(now, run = this.active) {
    const held = run.heldMs + (run.holdSince !== null ? now - run.holdSince : 0);
    return (now - run.startedAt - held) / 1000;
  }

  update(readings, now) {
    if (!this.active) return;
    // Any step below may stop this run and start another in its place (an
    // ABORT starts the abort sequence; a failed gate may start its fail
    // sequence), so each is followed by a check that `run` still owns the
    // sequencer. Without it the loop would go on firing THIS run's steps
    // under the new run's bookkeeping.
    const run = this.active;
    const { cfg } = run;
    const t = this.seqTime(now, run);

    for (const cond of cfg.abortConditions) {
      const value = readings[cond.sensor];
      if (!Number.isFinite(value)) continue;
      if (compare(value, cond.op, cond.value)) {
        const msg = cond.message || `${cond.sensor} ${cond.op} ${cond.value}`;
        this.stop(`abort condition: ${msg}`, 'sequencer');
        this.stand.abort(`${msg} (${cond.sensor} = ${value.toFixed(1)})`);
        return;
      }
    }

    if (run.panda) {
      this.updatePanda(now);
      return;
    }

    for (const gate of [...run.gates]) {
      this.checkGate(run, gate, readings, now);
      if (this.active !== run) return;
    }

    while (this.active === run && run.holdSince === null && run.nextStep < cfg.steps.length) {
      const step = cfg.steps[run.nextStep];
      if ((step.t ?? 0) > t) break;
      run.nextStep++;
      this.execute(step, cfg, t, readings, now);
    }

    // A non-blocking gate still open past the last step keeps the run alive
    // until it decides.
    if (this.active === run && run.nextStep >= cfg.steps.length && !run.gates.length) {
      this.active = null;
      this.stand.log('sequence', `SEQUENCE COMPLETE: ${cfg.name}`, 'sequencer');
      this.stand.emit('sequence-end', cfg, 'complete');
    }
  }

  // ------------------------------------------------------------- gates ---

  /**
   * Start checking a gate. `spec` holds the conditions and what failing does:
   * a gate step is its own spec; any other step may carry one as `step.gate`,
   * and then that step runs only once the gate passes (`then`).
   */
  openGate(spec, step, cfg, readings, now, then = null) {
    const run = this.active;
    const gate = { spec, step, then, openedAt: now, okSince: null, blocking: spec.blocking !== false };
    run.gates.push(gate);
    if (gate.blocking && run.holdSince === null) run.holdSince = now;
    const timeout = Number(spec.timeout) || 0;
    const hold = Number(spec.hold) || 0;
    this.stand.log('sequence', `${stampOf(step)} GATE: ${gateLabel(spec)}`
      + `${timeout ? ` within ${timeout}s` : ''}${hold ? `, held ${hold}s` : ''}`
      + `${then ? ` before ${actionText(then)}` : ''}`
      + `${gate.blocking ? '' : ' (timeline keeps running)'}`, `seq:${cfg.id}`);
    this.checkGate(run, gate, readings, now);
  }

  checkGate(run, gate, readings, now) {
    const { spec } = gate;
    const result = evaluateGate(spec, readings);
    if (result.ok) {
      gate.okSince ??= now;
      if (now - gate.okSince >= (Number(spec.hold) || 0) * 1000) this.closeGate(run, gate, true, result, now, readings);
    } else {
      gate.okSince = null;
      if (now - gate.openedAt >= (Number(spec.timeout) || 0) * 1000) this.closeGate(run, gate, false, result, now, readings);
    }
  }

  closeGate(run, gate, passed, result, now, readings = {}) {
    const { spec, step, then } = gate;
    const { cfg } = run;
    const src = `seq:${cfg.id}`;
    run.gates.splice(run.gates.indexOf(gate), 1);
    const waited = ((now - gate.openedAt) / 1000).toFixed(2);
    const label = spec.message || gateLabel(spec);
    const onFail = spec.onFail ?? 'abort';

    // Release the clock unless another blocking gate still holds it.
    if (gate.blocking && !run.gates.some((g) => g.blocking) && run.holdSince !== null) {
      run.heldMs += now - run.holdSince;
      run.holdSince = null;
    }

    if (passed) {
      this.stand.log('sequence', `${stampOf(step)} GATE PASS after ${waited}s: ${label} [${readingsText(result)}]`, src);
      if (then) this.execute(then, cfg, this.seqTime(now, run), readings, now, { gated: true });
      return;
    }
    const why = `GATE FAIL: ${label} [${readingsText(result)}]`;
    // A gated step never runs on a failed gate, whatever onFail goes on to do.
    this.stand.log('error', `${stampOf(step)} ${why}${then ? ` — ${actionText(then)} NOT DONE` : ''}`
      + ` -> ${onFail.toUpperCase()}`, src);

    switch (onFail) {
      case 'continue':
        return;
      case 'stop':
        this.stop(why, 'sequencer');
        return;
      case 'safeAll':
        this.stop(why, 'sequencer');
        this.stand.safeAll('sequencer');
        return;
      case 'setValves':
        // Valves first, then (by default) stop: the valves are set whether
        // or not the sequence goes on.
        this.stand.forceValves(spec.failValves || [], src);
        if (spec.failStop !== false && this.active === run) this.stop(why, 'sequencer');
        return;
      case 'sequence': {
        this.stop(why, 'sequencer');
        const res = this.start(spec.failSequence, 'gate');
        if (!res.ok) {
          // The fail sequence is the safing path; one that cannot start is
          // exactly what an ABORT is for.
          this.stand.log('error', `Gate fail sequence "${spec.failSequence}" did not start (${res.error}) — aborting`, src);
          this.stand.abort(`${label} — and its fail sequence did not start`);
        }
        return;
      }
      case 'abort':
      default:
        this.stop(why, 'sequencer');
        this.stand.abort(`Gate failed in ${cfg.name}: ${label} [${readingsText(result)}]`);
    }
  }

  updatePanda(now) {
    const active = this.active;
    const status = active.panda.sequenceStatus();
    if (!status.connected || status.error || status.phase === 'aborted'
        || (status.phase === 'starting' && now - active.startedAt > 3000)
        || now - active.startedAt > active.cfg.duration * 1000 + 5000) {
      this.stand.abort(status.error || 'Panda sequence stopped reporting or was aborted');
      return;
    }
    // Only board reports advance the UI; never replay valve writes on GC.
    const reported = status.phase === 'complete' ? active.items.length : status.nextItem;
    while (active.nextItem < Math.min(reported, active.items.length)) {
      const { step } = active.items[active.nextItem++];
      if (!step) continue;
      active.nextStep++;
      this.stand.valveStates[step.target] = step.state;
      this.stand.valveMeta[step.target] = { at: now, source: `panda:${active.cfg.id}` };
      this.stand.emit('valve-change', step.target, step.state);
    }
    if (status.phase === 'complete') {
      this.active = null;
      this.stand.log('sequence', `SEQUENCE COMPLETE (PANDA): ${active.cfg.name}`, 'sequencer');
      this.stand.emit('sequence-end', active.cfg, 'complete');
    }
  }

  execute(step, cfg, t, readings = {}, now = Date.now(), { gated = false } = {}) {
    const src = `seq:${cfg.id}`;
    const stamp = stampOf(step);
    const run = this.active;

    // A later command to a valve supersedes a gated one still waiting on it
    // (a non-blocking gate): it must not fire afterwards and undo this one.
    if (step.action === 'valve' && run) {
      for (const g of [...run.gates]) {
        if (g.then && g.then !== step && g.then.action === 'valve' && g.then.target === step.target) {
          run.gates.splice(run.gates.indexOf(g), 1);
          this.stand.log('warn', `${stampOf(g.step)} GATE DROPPED: ${actionText(g.then)} superseded by the ${stamp} step`, src);
        }
      }
    }

    // A step with its own gate waits for it, and runs from closeGate on a pass.
    if (step.gate && !gated && step.action !== 'gate') {
      this.openGate(step.gate, step, cfg, readings, now, step);
      return;
    }

    switch (step.action) {
      case 'valve': {
        const res = this.stand.commandValve(step.target, step.state, { source: src, fromSequence: true });
        if (!res.ok) {
          this.stand.log('error', `${stamp} ${step.target} -> ${step.state} REJECTED: ${res.error}`, src);
        } else {
          this.stand.log('sequence', `${stamp} ${step.target} -> ${step.state.toUpperCase()}`, src);
        }
        break;
      }
      case 'bangbang': {
        // Whatever the controller lets an operator retune from the control
        // screen, a sequence step may also set — otherwise a step could not
        // reproduce a configuration an operator can dial in by hand. The
        // converse holds too, which is why `abortAbove` is absent: it is not on
        // the screen either, and a countdown that moved the stand-wide abort
        // threshold on its way past would be the least visible way to do it.
        const patch = {};
        for (const key of ['enabled', 'setpoint', 'deadband', 'maxOpenMs', 'minIntervalMs',
                           'maxOpenSeconds', 'ventTrigger', 'ventAuto',
                           'vent', 'abort']) {
          if (step[key] !== undefined) patch[key] = step[key];
        }
        // A rejected patch used to pass silently. It cannot now: the limits a
        // step may set are validated, so a bad step has to say so rather than
        // leaving the operator to wonder why the controller never changed.
        const res = step.target === '*'
          ? this.stand.bangbang.setAll(patch, src)
          : this.stand.bangbang.set(step.target, patch, src);
        if (!res.ok) {
          this.stand.log('error', `${stamp} ${step.target} bang-bang REJECTED: ${res.error}`, src);
        }
        break;
      }
      case 'safeAll':
        this.stand.safeAll(src);
        this.stand.log('sequence', `${stamp} SAFE ALL`, src);
        break;
      case 'abortStates':
        this.stand.applyAbortStates(src);
        this.stand.log('sequence', `${stamp} ABORT STATES APPLIED`, src);
        break;
      case 'log':
        this.stand.log('sequence', `${stamp} ${step.message ?? ''}`, src);
        break;
      case 'abort':
        this.stand.abort(step.message || `Commanded abort from ${cfg.name}`);
        break;
      case 'end':
        this.stop('sequence end step', src);
        break;
      case 'gate':
        this.openGate(step, step, cfg, readings, now);
        break;
      default:
        this.stand.log('warn', `${stamp} unknown step action "${step.action}"`, src);
    }
    run?.stepLog.push({ t: step.t, action: step.action, target: step.target });
  }

  snapshot() {
    if (!this.active) return { running: false, id: null, name: null, t: 0, duration: 0, step: 0, steps: 0 };
    const { cfg, nextStep, gates, holdSince } = this.active;
    const now = Date.now();
    const holding = holdSince !== null ? gates.find((g) => g.blocking) : null;
    return {
      running: true,
      id: cfg.id,
      name: cfg.name,
      style: cfg.style,
      t: this.seqTime(now),
      // A blocking gate holding the clock: what it waits for and for how long.
      hold: holding ? {
        label: (holding.spec.message || gateLabel(holding.spec))
          + (holding.then ? ` → ${actionText(holding.then)}` : ''),
        waited: (now - holding.openedAt) / 1000,
        timeout: Number(holding.spec.timeout) || 0,
      } : null,
      gates: gates?.length ?? 0,
      duration: cfg.duration,
      step: nextStep,
      steps: cfg.steps.length,
      nextAt: cfg.steps[nextStep]?.t ?? null,
    };
  }
}

function stampOf(step) { return `T+${(step.t ?? 0).toFixed(2)}`; }

/** Whether one reading meets one gate condition. Not a number never does. */
export function conditionMet(value, cond) {
  if (!Number.isFinite(value)) return false;
  switch (cond.op) {
    case 'between': return value >= cond.min && value <= cond.max;
    case 'outside': return value < cond.min || value > cond.max;
    default: return compare(value, cond.op, cond.value);
  }
}

/** {ok, results: [{cond, value, ok}]} for a gate step against the readings. */
export function evaluateGate(step, readings) {
  const results = (step.conditions || []).map((cond) => {
    const value = readings[cond.sensor];
    return { cond, value, ok: conditionMet(value, cond) };
  });
  // No conditions passes nothing: validation refuses that, and a gate that
  // somehow has none must not wave a hot fire through.
  const ok = results.length > 0
    && (step.match === 'any' ? results.some((r) => r.ok) : results.every((r) => r.ok));
  return { ok, results };
}

function actionText(step) {
  if (step.action === 'valve') return `${step.target} ${String(step.state).toUpperCase()}`;
  return step.target ? `${step.action} ${step.target}` : step.action;
}

function readingsText({ results }) {
  return results.map(({ cond, value }) =>
    `${cond.sensor}=${Number.isFinite(value) ? value.toFixed(1) : 'no data'}`).join(', ');
}

function compare(a, op, b) {
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: return false;
  }
}
