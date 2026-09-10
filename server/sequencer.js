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

import { encodeSequence } from './hal/sequence-protocol.js';

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

    let remote = null;
    if (cfg.usePandaAutosequencer) {
      if (!this.stand.armed) return { ok: false, error: 'Panda sequences require the stand to be ARMED' };
      try {
        remote = this.pandaConfig(cfg);
        for (const step of remote.steps) {
          if (this.stand.bangbang.ownedValves().has(step.target)) {
            return { ok: false, error: `${step.target} is under bang-bang control; disable it before running this sequence` };
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

    if (this.active.panda) {
      this.updatePanda(now);
      return;
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
        // Whatever the controller lets an operator retune from the control
        // screen, a sequence step may also set — otherwise a step could not
        // reproduce a configuration an operator can dial in by hand.
        const patch = {};
        for (const key of ['enabled', 'setpoint', 'deadband', 'maxOpenMs', 'minIntervalMs',
                           'maxOpenSeconds', 'abortAbove', 'ventTrigger', 'ventAuto',
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
