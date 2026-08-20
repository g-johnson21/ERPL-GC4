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
 */

export class Sequencer {
  constructor(controller) {
    this.stand = controller;
    this.active = null;
  }

  get running() { return this.active !== null; }

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

    this.active = {
      cfg,
      startedAt: Date.now(),
      nextStep: 0,
      source,
      stepLog: [],
    };
    this.stand.log('sequence', `SEQUENCE START: ${cfg.name}`, source);
    this.stand.emit('sequence-start', cfg);
    return { ok: true };
  }

  /** Stop without safing — steps simply stop firing. */
  stop(reason = 'Stopped by operator', source = 'operator') {
    if (!this.active) return { ok: false, error: 'No sequence is running' };
    const { cfg } = this.active;
    const elapsed = (Date.now() - this.active.startedAt) / 1000;
    this.active = null;
    this.stand.log('sequence', `SEQUENCE HALT: ${cfg.name} at T+${elapsed.toFixed(2)}s — ${reason}`, source);
    this.stand.emit('sequence-end', cfg, 'halted');
    return { ok: true };
  }

  update(readings, now) {
    if (!this.active) return;
    const { cfg, startedAt } = this.active;
    const t = (now - startedAt) / 1000;

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

    while (this.active && this.active.nextStep < cfg.steps.length) {
      const step = cfg.steps[this.active.nextStep];
      if ((step.t ?? 0) > t) break;
      this.active.nextStep++;
      this.execute(step, cfg, t);
    }

    if (this.active && this.active.nextStep >= cfg.steps.length) {
      const done = this.active.cfg;
      this.active = null;
      this.stand.log('sequence', `SEQUENCE COMPLETE: ${done.name}`, 'sequencer');
      this.stand.emit('sequence-end', done, 'complete');
    }
  }

  execute(step, cfg, t) {
    const src = `seq:${cfg.id}`;
    const stamp = `T+${(step.t ?? 0).toFixed(2)}`;

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
        const patch = {};
        if (step.enabled !== undefined) patch.enabled = step.enabled;
        if (step.setpoint !== undefined) patch.setpoint = step.setpoint;
        if (step.deadband !== undefined) patch.deadband = step.deadband;
        if (step.target === '*') this.stand.bangbang.setAll(patch, src);
        else this.stand.bangbang.set(step.target, patch, src);
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
      default:
        this.stand.log('warn', `${stamp} unknown step action "${step.action}"`, src);
    }
    this.active?.stepLog.push({ t: step.t, action: step.action, target: step.target });
  }

  snapshot() {
    if (!this.active) return { running: false, id: null, name: null, t: 0, duration: 0, step: 0, steps: 0 };
    const { cfg, startedAt, nextStep } = this.active;
    return {
      running: true,
      id: cfg.id,
      name: cfg.name,
      style: cfg.style,
      t: (Date.now() - startedAt) / 1000,
      duration: cfg.duration,
      step: nextStep,
      steps: cfg.steps.length,
      nextAt: cfg.steps[nextStep]?.t ?? null,
    };
  }
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
