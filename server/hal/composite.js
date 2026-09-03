/**
 * composite.js — one HAL driver backed by several devices.
 *
 * The stand splits responsibilities across two boxes: the NI cDAQ reads
 * instrumentation, the PANDA board actuates valves (and reports its own
 * sensors). StandController expects a single driver, so this composes them.
 *
 *   sensors   every device's read() is merged. Later devices in the list win
 *             on conflict, so a channel measured by both is resolved by
 *             ordering rather than silently by object-key chance.
 *   valves    routed to the first device that claims the valve's channel via
 *             `valveDevice`, defaulting to the first actuation-capable one.
 *
 * Link state is reported per device, and `connected` is true only when every
 * REQUIRED device is up. A stand that has lost its DAQ is not "connected"
 * merely because its valve board still answers.
 */

export class CompositeDriver {
  constructor(options = {}) {
    this.name = 'composite';
    this.devices = options.devices || [];      // [{key, driver, required, actuates}]
    this.valveDevice = options.valveDevice || {};  // valveId -> device key
    this.onEvent = options.onEvent || (() => {});
  }

  async init(config) {
    this.config = config;
    for (const dev of this.devices) {
      try {
        await dev.driver.init(config);
      } catch (err) {
        // A failed optional device must not stop the stand from coming up;
        // a failed required one must, and loudly.
        if (dev.required) {
          throw new Error(`${dev.key}: ${err.message}`);
        }
        console.error(`[composite] optional device "${dev.key}" failed: ${err.message}`);
        dev.failed = true;
      }
    }
    return this;
  }

  deviceFor(valve) {
    const key = this.valveDevice[valve.id];
    if (key) {
      const named = this.devices.find((d) => d.key === key);
      if (named) return named;
      throw new Error(`valve ${valve.id} is mapped to unknown device "${key}"`);
    }
    const actuator = this.devices.find((d) => d.actuates && !d.failed);
    if (!actuator) {
      // Every valve would raise this identically. Say it once — thirteen
      // copies of the same line buries whatever else went wrong at startup.
      if (!this.warnedNoActuator) {
        this.warnedNoActuator = true;
        console.error('[composite] no actuation device — valve commands will be refused');
      }
      throw new Error('no actuation device is available');
    }
    return actuator;
  }

  setValve(valve, state) {
    this.deviceFor(valve).driver.setValve(valve, state);
  }

  setArmed(armed) {
    for (const dev of this.devices) {
      if (!dev.failed) dev.driver.setArmed?.(armed);
    }
  }

  safeAll() {
    for (const dev of this.devices) {
      if (dev.failed) continue;
      try {
        dev.driver.safeAll?.();
      } catch (err) {
        // Keep going: one device refusing to safe must not prevent the rest.
        console.error(`[composite] safeAll on "${dev.key}" failed: ${err.message}`);
      }
    }
  }

  read() {
    const out = {};
    for (const dev of this.devices) {
      if (dev.failed) continue;
      try {
        Object.assign(out, dev.driver.read());
      } catch (err) {
        console.error(`[composite] read from "${dev.key}" failed: ${err.message}`);
      }
    }
    return out;
  }

  /** Merged per-channel acquisition status, where a device reports one. */
  channelStatus() {
    const out = {};
    for (const dev of this.devices) {
      if (!dev.failed) Object.assign(out, dev.driver.channelStatus?.() || {});
    }
    return out;
  }

  /**
   * Zero sensors on whichever device measures them.
   *
   * Each device is offered only the ids nobody has claimed yet, so a sensor
   * read by two devices is tared once, by the first that owns it — the same
   * precedence `deviceFor` uses for valves.
   */
  tareSensors(ids, options) {
    const tared = [];
    const errors = [];
    for (const dev of this.devices) {
      if (dev.failed || typeof dev.driver.tareSensors !== 'function') continue;
      const remaining = ids.filter((id) => !tared.includes(id));
      if (!remaining.length) break;
      const res = dev.driver.tareSensors(remaining, options);
      tared.push(...(res.tared || []));
      if (res.error) errors.push(`${dev.key}: ${res.error}`);
    }
    return {
      ok: errors.length === 0,
      error: errors.join('; ') || undefined,
      tared,
      unsupported: ids.filter((id) => !tared.includes(id)),
    };
  }

  /** Merged per-sensor tare offsets, from whichever device can zero them. */
  tareStatus() {
    const out = {};
    for (const dev of this.devices) {
      if (!dev.failed) Object.assign(out, dev.driver.tareStatus?.() || {});
    }
    return out;
  }

  // ----------------------------------------------------------- bang-bang ----
  //
  // The regulator runs on one device (the PANDA), so these are a straight
  // passthrough rather than a merge. `bbDevice()` is deliberately not the
  // actuation device: which box happens to drive the solenoids and which box
  // runs the loop are separate facts, and a stand that split them would find
  // out the hard way.

  bbDevice() {
    return this.devices.find((d) => !d.failed && typeof d.driver.bbEnable === 'function')?.driver || null;
  }

  bbConfig(side, cfg) { return this.bbCall((d) => d.bbConfig(side, cfg)); }
  bbVent(side, cfg) { return this.bbCall((d) => d.bbVent(side, cfg)); }
  bbMdot(side, cfg) { return this.bbCall((d) => d.bbMdot(side, cfg)); }
  bbEnable(side, on) { return this.bbCall((d) => d.bbEnable(side, on)); }
  bbManualVent(side, open) { return this.bbCall((d) => d.bbManualVent(side, open)); }
  bbAbort(side) { return this.bbCall((d) => d.bbAbort(side)); }
  bbPredictive(side, on) { return this.bbCall((d) => d.bbPredictive(side, on)); }

  bbCall(fn) {
    const device = this.bbDevice();
    if (!device) return { ok: false, error: 'no device runs bang-bang control' };
    return fn(device);
  }

  bbStatus() { return this.bbDevice()?.bbStatus?.() ?? {}; }

  // The board's own transducers belong to the device that runs the regulator,
  // not to whichever box the DAQ tare goes to — so these route through
  // bbDevice() like the rest of the bang-bang surface.
  ptTare(side) { return this.bbCall((d) => d.ptTare(side)); }
  ptOffset(side, psi) { return this.bbCall((d) => d.ptOffset(side, psi)); }
  ptTareClearAll() { return this.bbCall((d) => d.ptTareClearAll()); }
  ptTareStatus() { return this.bbDevice()?.ptTareStatus?.() ?? null; }

  /** Merged per-valve current sense, from whichever device measures it. */
  dcStatus() {
    const out = {};
    for (const dev of this.devices) {
      if (!dev.failed) Object.assign(out, dev.driver.dcStatus?.() || {});
    }
    return out;
  }

  /** Merged per-valve channel names, from whichever device wires them. */
  dcLabels() {
    const out = {};
    for (const dev of this.devices) Object.assign(out, dev.driver.dcLabels?.() || {});
    return out;
  }

  /** Look up one device, so a route can reach e.g. the DAQ's tare command. */
  device(key) {
    return this.devices.find((d) => d.key === key)?.driver;
  }

  get status() {
    const parts = [];
    const devices = [];
    let allRequiredUp = true;
    let lastRxAt = 0;
    for (const dev of this.devices) {
      const s = dev.driver.status;
      parts.push(`${dev.key}:${s.connected ? 'up' : 'DOWN'}`);
      if (dev.required && !s.connected) allRequiredUp = false;
      // Per-device link state, so the UI can say WHICH box went quiet. A
      // composite that only reports "DOWN" sends an operator to the wrong
      // rack: the DAQ and the valve board fail for completely different
      // reasons and are fixed in completely different places.
      devices.push({
        key: dev.key,
        name: s.name,
        connected: Boolean(s.connected),
        required: dev.required !== false,
        failed: Boolean(dev.failed),
        lastRxAt: s.lastRxAt ?? 0,
        // Measured receive rate, where the device reports one. Absent on
        // devices that do not measure it, and the header simply omits it.
        rxSampleHz: s.rxSampleHz ?? null,
        rxFrameHz: s.rxFrameHz ?? null,
        sampleClockHz: s.sampleClockHz ?? null,
        detail: s.detail,
      });
      lastRxAt = Math.max(lastRxAt, s.lastRxAt ?? 0);
    }
    return {
      name: this.name,
      connected: allRequiredUp,
      lastRxAt,
      devices,
      detail: parts.join(' · ') || 'no devices',
    };
  }

  async close() {
    for (const dev of this.devices) {
      try {
        await dev.driver.close?.();
      } catch (err) {
        console.error(`[composite] close of "${dev.key}" failed: ${err.message}`);
      }
    }
  }
}
