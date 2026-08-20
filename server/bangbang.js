/**
 * bangbang.js — hysteresis (bang-bang) pressure controllers.
 *
 * Each controller watches one sensor and drives one valve:
 *
 *   value < setpoint - deadband  ->  valve OPEN   (pressurize)
 *   value > setpoint + deadband  ->  valve CLOSED (hold)
 *   in between                   ->  no change    (hysteresis band)
 *
 * Safety behaviour, all configurable per controller in stand.json:
 *   - `requiresArm`    : controller is forced off while the stand is DISARMED
 *   - `maxOpenSeconds` : a valve stuck open past this trips the controller off
 *                        and raises a fault (indicates a leak or a dead PT)
 *   - `abortAbove`     : value above this triggers a stand-wide ABORT
 */

export class BangBangBank {
  constructor(controller) {
    this.stand = controller;
    this.runtime = new Map(); // id -> runtime state
    this.sync();
  }

  /** Rebuild runtime state after a config reload, preserving live settings. */
  sync() {
    const cfg = this.stand.config;
    const next = new Map();
    for (const c of cfg.bangbang) {
      const prev = this.runtime.get(c.id);
      next.set(c.id, {
        id: c.id,
        enabled: prev?.enabled ?? c.enabled ?? false,
        setpoint: prev?.setpoint ?? c.setpoint,
        deadband: prev?.deadband ?? c.deadband,
        output: prev?.output ?? false,
        openSince: prev?.openSince ?? 0,
        cycles: prev?.cycles ?? 0,
        fault: prev?.fault ?? null,
        lastSwitchAt: prev?.lastSwitchAt ?? 0,
      });
    }
    this.runtime = next;
  }

  get(id) { return this.runtime.get(id); }

  /** Apply an operator or sequence change. Returns {ok, error}. */
  set(id, { enabled, setpoint, deadband }, source = 'operator') {
    const cfg = this.stand.configStore.controller(id);
    const rt = this.runtime.get(id);
    if (!cfg || !rt) return { ok: false, error: `Unknown controller "${id}"` };

    if (setpoint !== undefined) {
      const v = Number(setpoint);
      if (!Number.isFinite(v)) return { ok: false, error: 'setpoint must be a number' };
      rt.setpoint = clamp(v, cfg.setpointMin, cfg.setpointMax);
    }
    if (deadband !== undefined) {
      const v = Number(deadband);
      if (!Number.isFinite(v) || v <= 0) return { ok: false, error: 'deadband must be > 0' };
      rt.deadband = clamp(v, cfg.deadbandMin, cfg.deadbandMax);
    }
    if (enabled !== undefined) {
      const want = Boolean(enabled);
      if (want && cfg.requiresArm && !this.stand.armed) {
        return { ok: false, error: `${cfg.name} requires the stand to be ARMED` };
      }
      if (want !== rt.enabled) {
        rt.enabled = want;
        rt.fault = null;
        rt.cycles = 0;
        this.stand.log(
          want ? 'command' : 'info',
          `${cfg.name}: control ${want ? 'ENABLED' : 'DISABLED'} @ ${rt.setpoint} ±${rt.deadband}`,
          source
        );
        if (!want) this.drive(cfg, rt, false, source); // fail closed on disable
      }
    }
    return { ok: true };
  }

  setAll(patch, source) {
    for (const c of this.stand.config.bangbang) this.set(c.id, patch, source);
    return { ok: true };
  }

  /** Called every control tick. */
  update(readings, now) {
    for (const cfg of this.stand.config.bangbang) {
      const rt = this.runtime.get(cfg.id);
      if (!rt) continue;

      // Losing ARM drops every controller that depends on it.
      if (rt.enabled && cfg.requiresArm && !this.stand.armed) {
        rt.enabled = false;
        rt.fault = 'Disarmed';
        this.drive(cfg, rt, false, 'interlock');
        this.stand.log('warn', `${cfg.name}: control dropped (stand disarmed)`, 'interlock');
        continue;
      }
      if (!rt.enabled) { rt.output = false; continue; }

      const value = readings[cfg.sensor];
      if (!Number.isFinite(value)) {
        rt.enabled = false;
        rt.fault = 'No sensor data';
        this.drive(cfg, rt, false, 'interlock');
        this.stand.log('error', `${cfg.name}: no data from ${cfg.sensor} — control dropped`, 'interlock');
        continue;
      }

      if (cfg.abortAbove != null && value > cfg.abortAbove) {
        rt.enabled = false;
        rt.fault = 'Abort threshold';
        this.drive(cfg, rt, false, 'interlock');
        this.stand.abort(`${cfg.sensor} = ${value.toFixed(1)} exceeded abort limit ${cfg.abortAbove}`);
        continue;
      }

      let want = rt.output;
      if (value < rt.setpoint - rt.deadband) want = true;
      else if (value > rt.setpoint + rt.deadband) want = false;

      if (want && cfg.maxOpenSeconds > 0 && rt.output && rt.openSince) {
        const openFor = (now - rt.openSince) / 1000;
        if (openFor > cfg.maxOpenSeconds) {
          rt.enabled = false;
          rt.fault = `Valve open > ${cfg.maxOpenSeconds}s`;
          this.drive(cfg, rt, false, 'interlock');
          this.stand.log(
            'error',
            `${cfg.name}: ${cfg.valve} open ${openFor.toFixed(0)}s without reaching setpoint — control dropped (leak? failed PT?)`,
            'interlock'
          );
          continue;
        }
      }

      if (want !== rt.output) {
        rt.cycles++;
        rt.lastSwitchAt = now;
        rt.openSince = want ? now : 0;
        this.drive(cfg, rt, want, 'bang-bang');
      }
    }
  }

  drive(cfg, rt, open, source) {
    rt.output = open;
    if (!open) rt.openSince = 0;
    this.stand.commandValve(cfg.valve, open ? 'open' : 'closed', { source, internal: true });
  }

  snapshot() {
    const out = {};
    for (const cfg of this.stand.config.bangbang) {
      const rt = this.runtime.get(cfg.id);
      if (!rt) continue;
      out[cfg.id] = {
        enabled: rt.enabled,
        setpoint: rt.setpoint,
        deadband: rt.deadband,
        output: rt.output,
        cycles: rt.cycles,
        fault: rt.fault,
      };
    }
    return out;
  }
}

function clamp(v, lo, hi) {
  if (Number.isFinite(lo)) v = Math.max(lo, v);
  if (Number.isFinite(hi)) v = Math.min(hi, v);
  return v;
}
