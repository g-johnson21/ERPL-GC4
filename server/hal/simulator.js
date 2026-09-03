/**
 * simulator.js — lumped-parameter test stand simulator.
 *
 * Lets you exercise the full GUI, autosequences, bang-bang control and CSV
 * recording with no hardware attached. The model is deliberately simple:
 * it is tuned for *plausible* traces to shake out the UI and sequences, NOT
 * for engineering-grade prediction. Do not size hardware from these numbers.
 *
 * Roles are matched to valve/sensor IDs via `roles` below. If your stand uses
 * different IDs, edit the mapping here (or run with --driver=udp / serial).
 * Any sensor not covered by the model simply reads ambient + noise.
 *
 * BANG-BANG
 *   The regulator does NOT run in this file. It runs in bb-firmware.js, an
 *   emulation of the PANDA board, and this driver talks to it over the same
 *   ASCII command grammar the real board uses — encoded, handed across, and
 *   parsed back out of `BB:` and `EVT:` lines. So `npm run sim` exercises the
 *   real §5 protocol end to end, including the config echo and the enable
 *   handshake, rather than a shortcut that would agree with the server no
 *   matter what the wire format said.
 *
 *   The emulated board reads its OWN transducer, offset and noised
 *   independently of the DAQ channel the ground station sees. That divergence
 *   is deliberate: two sensors on one tank is the real situation, and a
 *   simulator where both loops read the identical number would hide it.
 */
import { BangBangFirmware } from './bb-firmware.js';
import {
  parseLine,
  encodeConfig,
  encodeVent,
  encodeMdot,
  encodeEnable,
  encodeManualVent,
  encodeAbort,
  encodePredictive,
  encodePtTare,
  encodePtTareClear,
  encodePtOffset,
  parsePtTare,
  commandSide,
} from './bb-protocol.js';

const AMBIENT_PSI = 14.7;
const AMBIENT_F = 72;
const LOX_F = -297;

/**
 * Fixed bias of the emulated board's PT against the DAQ's, per side, in psi.
 * Small enough to be plausible, large enough that a UI meant to surface the
 * disagreement visibly does.
 */
const BOARD_PT_BIAS = { l: 1.8, f: -2.4 };

/** Holding current of an energized solenoid coil, in amps. */
const COIL_HOLD_AMPS = 0.62;

/**
 * Sense-resistor leakage on a de-energized channel, in amps.
 *
 * Measured on the real board: every idle channel sits around 0.4 mA and
 * wanders in the last digit. Three orders of magnitude below a pulled-in coil,
 * which is exactly why the current display has to adapt its units.
 */
const COIL_LEAK_AMPS = 0.0004;

/** Map model roles -> IDs from config/stand.json. Edit to match your stand. */
const roles = {
  valves: {
    n2iso: 'SV-N2-ISO',
    pneu: 'SV-PNEU',
    fuelPress: 'SV-FP',
    oxPress: 'SV-OP',
    fuelVent: 'SV-FV',
    oxVent: 'SV-OV',
    fuelDrain: 'SV-FD',
    oxDrain: 'SV-OD',
    loxFill: 'SV-LOX-FILL',
    fuelMain: 'MV-F',
    oxMain: 'MV-O',
    purge: 'SV-PURGE',
    igniter: 'IGN-1',
  },
  sensors: {
    bottleP: 'PT-101',
    regP: 'PT-102',
    fuelP: 'PT-201',
    oxP: 'PT-301',
    fuelInjP: 'PT-401',
    oxInjP: 'PT-402',
    chamberP: 'PT-501',
    pneuP: 'PT-601',
    fuelT: 'TC-201',
    oxT: 'TC-301',
    oxLineT: 'TC-302',
    chamberWallT: 'TC-501',
    throatT: 'TC-502',
    thrust: 'LC-101',
    fuelMass: 'LC-201',
    oxMass: 'LC-301',
  },
};

/** Model tuning constants — adjust to make the sim behave like your stand. */
const tune = {
  bottleVolumeL: 9,
  bottleStartPsi: 4500,
  regSetPsi: 600,
  // Tank fill coefficient: dP/dt = (Preg - Ptank) * pressGain. At 0.25 a tank
  // reaches a 450 psi setpoint from ambient in roughly 6 s. Much higher and a
  // single control tick can overshoot the whole bang-bang deadband, which is a
  // simulator artefact rather than anything a real solenoid would do.
  pressGain: 0.25,
  bottleDrain: 0.055,    // bottle depletion per unit of gas delivered
  ventGain: 0.55,        // tank blowdown coefficient
  pneuGain: 3.0,
  pneuMaxPsi: 130,
  fuelStartMass: 45,     // lbm
  oxStartMass: 55,       // lbm
  fuelCdA: 0.055,        // main valve effective flow coefficient
  oxCdA: 0.062,
  cstarEff: 0.92,
  thrustCoeff: 1.42,
  throatAreaIn2: 1.15,
  pcPerMdot: 165,        // chamber pressure per lbm/s of total flow
  drainRate: 1.6,        // lbm/s through drain valves
  fillRate: 2.4,         // lbm/s through LOX fill
  ignitionWindowS: 3.0,  // how long after igniter fire ignition is possible
  flameoutGraceS: 0.15,  // flow may dip this long before the burn is declared out
};

export class SimulatorDriver {
  constructor(options = {}) {
    this.name = 'simulator';
    this.connected = true;
    this.detail = 'Physics simulator (no hardware)';
    this.opts = options;
    this.valveState = new Map();   // valveId -> 'open' | 'closed'
    this.lastT = Date.now() / 1000;
    this.onEvent = options.onEvent || (() => {});
    // Set by the bang-bang bank, to attribute a board rejection to whatever
    // command was in flight. Mirrors the PANDA driver's hook.
    this.onBbError = options.onBbError || null;
    this.ptOffsets = { L: null, F: null };
    this.ptTareConfirmedAt = 0;
    this.ptTareError = null;
    // Matches the PANDA driver's default, so the energized threshold behaves
    // the same in the simulator as it does on the stand.
    this.dcThresholdA = Number(options.dcThresholdA ?? 0.1);

    // Per-instance, because init() rewires roles from the loaded config and a
    // shared module-level object would leak that between stands.
    this.roles = structuredClone(roles);

    // The emulated board. Its lines come back through parseLine(), the same
    // decoder the real driver uses, so the mirror below is built by the code
    // path that has to work on hardware.
    this.bb = { l: freshBbSide(), f: freshBbSide() };
    this.bbEchoes = false;
    this.bbSides = {};             // 'l' | 'f' -> {valve, ventValve}
    this.firmware = new BangBangFirmware({ onLine: (line) => this.onBoardLine(line) });

    this.reset();
  }

  reset() {
    this.s = {
      bottleP: tune.bottleStartPsi,
      regP: AMBIENT_PSI,
      pneuP: AMBIENT_PSI,
      fuelP: AMBIENT_PSI,
      oxP: AMBIENT_PSI,
      fuelMass: tune.fuelStartMass,
      oxMass: tune.oxStartMass,
      chamberP: AMBIENT_PSI,
      thrust: 0,
      fuelT: AMBIENT_F,
      oxT: LOX_F,
      oxLineT: AMBIENT_F,
      wallT: AMBIENT_F,
      throatT: AMBIENT_F,
      ignitedUntil: 0,
      igniterFiredAt: -1e9,
      burning: false,
      flameoutFor: 0,
      mdotF: 0,
      mdotO: 0,
    };

    // Tare offsets, in engineering units, subtracted from the model's output.
    //
    // The real stand zeroes inside the NI-DAQ sidecar, before conversion; the
    // model has no such layer, so it subtracts here instead. What matters is
    // that both honour the same driver contract — the point of the simulator
    // is that the screens above it can be exercised for real with no hardware
    // attached, and a zeroing function nobody can try out is a zeroing
    // function nobody trusts on test day.
    this.tares = new Map();
    this.lastSample = {};
  }

  async init(config) {
    this.config = config;
    for (const v of config.valves) {
      this.valveState.set(v.id, v.safeState || (v.normallyOpen ? 'open' : 'closed'));
    }
    this.bindBangBang(config);
    return this;
  }

  /**
   * Point the model's press/vent/tank roles at whatever the bang-bang config
   * actually names, so the emulated board pressurises the tank the operator is
   * watching instead of a role id from an older stand.
   *
   * Only the four roles bang-bang needs are rewired. The rest of the `roles`
   * map above still assumes the previous stand's ids, so anything else the
   * model drives may be reading a channel this config does not define.
   */
  bindBangBang(config) {
    this.bbSides = {};
    for (const c of config.bangbang || []) {
      const side = String(c.side || '').toLowerCase();
      if (side !== 'l' && side !== 'f') continue;
      this.bbSides[side] = { valve: c.valve, ventValve: c.ventValve };
      if (side === 'l') {
        if (c.valve) this.roles.valves.oxPress = c.valve;
        if (c.ventValve) this.roles.valves.oxVent = c.ventValve;
        if (c.sensor) this.roles.sensors.oxP = c.sensor;
      } else {
        if (c.valve) this.roles.valves.fuelPress = c.valve;
        if (c.ventValve) this.roles.valves.fuelVent = c.ventValve;
        if (c.sensor) this.roles.sensors.fuelP = c.sensor;
      }
    }
  }

  setValve(valve, state /* 'open' | 'closed' */) {
    this.valveState.set(valve.id, state);
    if (valve.id === this.roles.valves.igniter && state === 'open') {
      this.s.igniterFiredAt = Date.now() / 1000;
    }
  }

  isOpen(role) {
    return this.valveState.get(this.roles.valves[role]) === 'open';
  }

  /** Does this stand actually have the valve the model wants for this role? */
  hasValve(role) {
    return this.valveState.has(this.roles.valves[role]);
  }

  /**
   * Is pressurant available at the regulator?
   *
   * A role this stand does not define is not a CLOSED valve — it is a part of
   * the model this stand does not have. Draco has no separate N2 isolation
   * valve, and reading its absence as "shut" left the regulator at ambient,
   * so the bang-bang loop could open its press valve onto nothing and never
   * reach setpoint. An absent isolation valve means the supply is simply
   * always live.
   */
  pressurantAvailable() {
    return !this.hasValve('n2iso') || this.isOpen('n2iso');
  }

  setArmed(armed) {
    // Mirrors the board's 'a'/'r'. The latch itself gates one command
    // (predictive shutoff); the 'r' path additionally runs the firmware's
    // forceSafe() across both sides, so a regulator does not survive a disarm.
    this.firmware.setArmed(armed);
    if (!armed) this.firmware.forceSafe();
  }

  safeAll() {
    this.firmware.forceSafe();
  }

  // ----------------------------------------------------------- bang-bang ----
  //
  // The same seven commands the PANDA driver sends, encoded with the same
  // encoders and handed to the emulated board as ASCII. Going through the wire
  // format rather than calling the firmware's methods directly is the point:
  // a mistake in the grammar shows up here instead of at the pad.

  bbConfig(side, cfg) { return this.boardCommand(() => encodeConfig(side, cfg)); }
  bbVent(side, cfg) { return this.boardCommand(() => encodeVent(side, cfg)); }
  bbMdot(side, cfg) { return this.boardCommand(() => encodeMdot(side, cfg)); }
  bbEnable(side, on) { return this.boardCommand(() => encodeEnable(side, on)); }
  bbManualVent(side, open) { return this.boardCommand(() => encodeManualVent(side, open)); }
  bbAbort(side) { return this.boardCommand(() => encodeAbort(side)); }
  bbPredictive(side, on) { return this.boardCommand(() => encodePredictive(side, on)); }

  // PT tare, over the same emulated wire as everything else — so `npm run sim`
  // exercises the real `T` grammar and the real PT_TARE / PT_ERROR answers
  // rather than a shortcut that would agree with the server no matter what.
  ptTare(side) {
    const res = this.boardCommand(() => encodePtTare(side));
    if (res.ok) this.ptTareError = null;
    return res;
  }

  ptOffset(side, psi) {
    const res = this.boardCommand(() => encodePtOffset(side, psi));
    if (res.ok) {
      const c = commandSide(side);
      if (c) this.ptOffsets[c] = Number(psi);
      this.ptTareError = null;
    }
    return res;
  }

  ptTareClearAll() {
    const res = this.boardCommand(() => encodePtTareClear());
    if (res.ok) { this.ptOffsets = { L: 0, F: 0 }; this.ptTareError = null; }
    return res;
  }

  ptTareStatus() {
    return { offsets: { ...this.ptOffsets }, confirmedAt: this.ptTareConfirmedAt, error: this.ptTareError };
  }

  boardCommand(build) {
    let command;
    try {
      command = build();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.firmware.command(command);
    return { ok: true, command };
  }

  /** Decode a line from the emulated board exactly as the real driver would. */
  onBoardLine(line) {
    const msg = parseLine(line);
    if (msg.kind === 'heartbeat') {
      const side = this.bb[msg.side];
      if (!side) return;
      side.state = msg.state;
      side.stateValid = msg.stateValid;
      side.press = msg.press;
      side.vent = msg.vent;
      if (msg.pressure !== undefined) side.pressure = msg.pressure;
      side.lastBeatAt = Date.now();
      return;
    }
    if (msg.kind === 'event') {
      if (msg.category === 'PT_TARE') {
        this.ptTareError = null;
        this.ptTareConfirmedAt = Date.now();
        for (const [side, offset] of Object.entries(parsePtTare(msg.detail))) {
          if (this.ptOffsets[side] !== undefined) this.ptOffsets[side] = offset;
        }
      }
      if (msg.category === 'CFG_PUSH' && this.bb[msg.side]) {
        this.bbEchoes = true;
        Object.assign(this.bb[msg.side].confirmed, msg.config.fields);
        this.bb[msg.side].confirmedAt = Date.now();
      }
      this.onEvent(`SIM-PANDA ${msg.category}${msg.side ? `:${msg.side}` : ''} ${msg.detail}`.trim(), 'info');
      return;
    }
    if (msg.kind === 'error') {
      this.onEvent(line, 'error');
      // A PT tare rejection is not a bang-bang rejection — same split the
      // real driver makes, for the same reason.
      if (line.startsWith('PT_ERROR:')) { this.ptTareError = line; return; }
      this.onBbError?.(line);
    }
  }

  bbStatus() {
    const now = Date.now();
    const out = {};
    for (const [key, side] of Object.entries(this.bb)) {
      out[key] = {
        ...side,
        // Never stale: the emulated board is in-process, so the only way to
        // lose its heartbeat is for the whole server to stop.
        stale: false,
        confirmed: { ...side.confirmed },
        echoes: this.bbEchoes,
        lastBeatAt: side.lastBeatAt || now,
      };
    }
    return out;
  }

  /**
   * Run the emulated regulator one tick and let its solenoid demand drive the
   * model. The board's PT is the model's tank pressure with an independent
   * bias and noise — see BOARD_PT_BIAS.
   */
  stepBoard(nowMs) {
    this.firmware.update({
      l: this.s.oxP + BOARD_PT_BIAS.l + gauss() * 0.6,
      f: this.s.fuelP + BOARD_PT_BIAS.f + gauss() * 0.6,
    }, nowMs);

    const outputs = this.firmware.outputs();
    for (const [side, wiring] of Object.entries(this.bbSides)) {
      const demand = outputs[side];
      if (!demand) continue;
      if (wiring.valve) this.applyCoil(wiring.valve, demand.press);
      if (wiring.ventValve) this.applyCoil(wiring.ventValve, demand.vent);
    }
  }

  /** The board commands a COIL; the model tracks FLOW state. */
  applyCoil(valveId, energized) {
    const valve = this.config?.valves.find((v) => v.id === valveId);
    if (!valve) return;
    this.valveState.set(valveId, valve.normallyOpen
      ? (energized ? 'closed' : 'open')
      : (energized ? 'open' : 'closed'));
  }

  /** Advance physics and return { sensorId: engineeringValue }. */
  read() {
    const now = Date.now() / 1000;
    const elapsed = Math.min(0.25, Math.max(0, now - this.lastT));
    this.lastT = now;

    // Before the physics, so a valve the board just opened acts on this tick.
    this.stepBoard(now * 1000);

    // Fixed sub-steps. These are explicit-Euler relaxations, so a long tick
    // (Node timer jitter, GC pause, a busy laptop) would otherwise overshoot:
    // chamber pressure can leap past tank pressure, zero the injector delta-p
    // and "flame out" an engine that is physically running fine. Sub-stepping
    // keeps the trace identical no matter how the host schedules the loop.
    const MAX_STEP = 0.005;
    const steps = Math.max(1, Math.ceil(elapsed / MAX_STEP));
    const h = elapsed / steps;
    for (let i = 0; i < steps; i++) {
      this.step(h, now - elapsed + h * (i + 1));
    }
    return this.sample();
  }

  step(dt, now) {
    const s = this.s;

    // --- Pressurant supply ---------------------------------------------
    const isoOpen = this.pressurantAvailable();
    const targetReg = isoOpen ? Math.min(s.bottleP, tune.regSetPsi) : AMBIENT_PSI;
    s.regP += (targetReg - s.regP) * Math.min(1, 6 * dt);

    const targetPneu = this.isOpen('pneu') ? Math.min(s.regP, tune.pneuMaxPsi) : s.pneuP;
    s.pneuP += (targetPneu - s.pneuP) * Math.min(1, tune.pneuGain * dt);
    if (!this.isOpen('pneu')) s.pneuP -= 0.6 * dt; // slow bleed-down
    s.pneuP = clamp(s.pneuP, AMBIENT_PSI, tune.pneuMaxPsi);

    // --- Tank pressurization -------------------------------------------
    let gasUsed = 0;
    if (this.isOpen('fuelPress') && s.regP > s.fuelP) {
      const d = (s.regP - s.fuelP) * tune.pressGain * dt;
      s.fuelP += d;
      gasUsed += d;
    }
    if (this.isOpen('oxPress') && s.regP > s.oxP) {
      const d = (s.regP - s.oxP) * tune.pressGain * dt;
      s.oxP += d;
      gasUsed += d;
    }
    if (this.isOpen('purge') && s.regP > AMBIENT_PSI) gasUsed += 18 * dt;
    if (gasUsed > 0 && isoOpen) {
      s.bottleP = Math.max(AMBIENT_PSI, s.bottleP - gasUsed * tune.bottleDrain);
    }

    // --- Venting --------------------------------------------------------
    if (this.isOpen('fuelVent')) s.fuelP -= (s.fuelP - AMBIENT_PSI) * tune.ventGain * dt;
    if (this.isOpen('oxVent')) s.oxP -= (s.oxP - AMBIENT_PSI) * tune.ventGain * dt;
    // Every real tank leaks a little.
    s.fuelP -= (s.fuelP - AMBIENT_PSI) * 0.0025 * dt;
    s.oxP -= (s.oxP - AMBIENT_PSI) * 0.0025 * dt;
    // LOX boil-off self-pressurizes a sealed ox tank.
    if (!this.isOpen('oxVent') && s.oxMass > 0.5) s.oxP += 0.9 * dt;

    // --- Fill and drain --------------------------------------------------
    if (this.isOpen('loxFill')) s.oxMass = Math.min(90, s.oxMass + tune.fillRate * dt);
    if (this.isOpen('fuelDrain') && s.fuelMass > 0) {
      s.fuelMass = Math.max(0, s.fuelMass - tune.drainRate * dt * (1 + s.fuelP / 300));
      s.fuelP -= (s.fuelP - AMBIENT_PSI) * 0.25 * dt;
    }
    if (this.isOpen('oxDrain') && s.oxMass > 0) {
      s.oxMass = Math.max(0, s.oxMass - tune.drainRate * dt * (1 + s.oxP / 300));
      s.oxP -= (s.oxP - AMBIENT_PSI) * 0.25 * dt;
    }

    // --- Main propellant flow --------------------------------------------
    const fuelOpen = this.isOpen('fuelMain') && s.fuelMass > 0.05;
    const oxOpen = this.isOpen('oxMain') && s.oxMass > 0.05;
    const dpF = Math.max(0, s.fuelP - s.chamberP);
    const dpO = Math.max(0, s.oxP - s.chamberP);
    s.mdotF = fuelOpen ? tune.fuelCdA * Math.sqrt(dpF) * 3.2 : 0;
    s.mdotO = oxOpen ? tune.oxCdA * Math.sqrt(dpO) * 3.2 : 0;

    s.fuelMass = Math.max(0, s.fuelMass - s.mdotF * dt);
    s.oxMass = Math.max(0, s.oxMass - s.mdotO * dt);
    // Draining liquid grows the ullage, so tank pressure sags unless made up.
    if (s.mdotF > 0) s.fuelP -= s.mdotF * 3.4 * dt;
    if (s.mdotO > 0) s.oxP -= s.mdotO * 3.0 * dt;

    // --- Combustion -------------------------------------------------------
    const igniterLive = now - s.igniterFiredAt < tune.ignitionWindowS;
    const bothFlowing = s.mdotF > 0.05 && s.mdotO > 0.05;
    if (bothFlowing) {
      if (igniterLive || s.burning) s.burning = true;
      s.flameoutFor = 0;
    } else {
      // A hot chamber does not extinguish the instant flow dips — give it a
      // short grace period before declaring flameout.
      s.flameoutFor += dt;
      if (s.flameoutFor > tune.flameoutGraceS) s.burning = false;
    }

    const mdotTotal = s.mdotF + s.mdotO;
    let targetPc = AMBIENT_PSI;
    if (s.burning) {
      targetPc = AMBIENT_PSI + mdotTotal * tune.pcPerMdot * tune.cstarEff;
    } else if (mdotTotal > 0) {
      targetPc = AMBIENT_PSI + mdotTotal * 5; // cold-flow backpressure only
    } else if (this.isOpen('purge')) {
      targetPc = AMBIENT_PSI + 12;
    }
    s.chamberP += (targetPc - s.chamberP) * Math.min(1, 14 * dt);

    const targetThrust = s.burning
      ? Math.max(0, (s.chamberP - AMBIENT_PSI) * tune.throatAreaIn2 * tune.thrustCoeff)
      : 0;
    s.thrust += (targetThrust - s.thrust) * Math.min(1, 16 * dt);

    // --- Thermal -----------------------------------------------------------
    const wallTarget = s.burning ? 300 + s.chamberP * 2.4 : AMBIENT_F;
    s.wallT += (wallTarget - s.wallT) * Math.min(1, (s.burning ? 1.1 : 0.09) * dt);
    const throatTarget = s.burning ? 400 + s.chamberP * 3.1 : AMBIENT_F;
    s.throatT += (throatTarget - s.throatT) * Math.min(1, (s.burning ? 1.5 : 0.07) * dt);

    s.oxT += ((s.oxMass > 1 ? LOX_F : AMBIENT_F) - s.oxT) * Math.min(1, 0.25 * dt);
    const lineTarget = oxOpen || s.oxMass > 1 ? LOX_F + 40 : AMBIENT_F;
    s.oxLineT += (lineTarget - s.oxLineT) * Math.min(1, (oxOpen ? 1.2 : 0.12) * dt);
    s.fuelT += (AMBIENT_F - s.fuelT) * Math.min(1, 0.1 * dt);

    s.fuelP = Math.max(AMBIENT_PSI, s.fuelP);
    s.oxP = Math.max(AMBIENT_PSI, s.oxP);
    s.chamberP = Math.max(AMBIENT_PSI, s.chamberP);
  }

  sample() {
    const s = this.s;
    const out = {};
    const put = (role, value, noise) => {
      const id = this.roles.sensors[role];
      if (id) out[id] = value + gauss() * noise;
    };

    put('bottleP', s.bottleP, 3.0);
    put('regP', s.regP, 1.2);
    put('fuelP', s.fuelP, 0.8);
    put('oxP', s.oxP, 0.8);
    put('pneuP', s.pneuP, 0.4);
    // Injector pressures sit downstream of the mains: line pressure when the
    // valve is open, otherwise trapped at roughly chamber pressure.
    put('fuelInjP', this.isOpen('fuelMain') ? lerp(s.chamberP, s.fuelP, 0.55) : s.chamberP, 1.1);
    put('oxInjP', this.isOpen('oxMain') ? lerp(s.chamberP, s.oxP, 0.55) : s.chamberP, 1.1);
    put('chamberP', s.chamberP, s.burning ? 4.5 : 0.5);
    put('fuelT', s.fuelT, 0.4);
    put('oxT', s.oxT, 1.8);
    put('oxLineT', s.oxLineT, 2.2);
    put('chamberWallT', s.wallT, s.burning ? 12 : 1.5);
    put('throatT', s.throatT, s.burning ? 16 : 1.5);
    put('thrust', s.thrust, s.burning ? 6.0 : 0.35);
    put('fuelMass', s.fuelMass, 0.03);
    put('oxMass', s.oxMass, 0.03);

    // Anything the model does not cover still produces a live channel.
    for (const sensor of this.config?.sensors || []) {
      if (!(sensor.id in out)) {
        const base = sensor.kind === 'temperature' ? AMBIENT_F : 0;
        out[sensor.id] = base + gauss() * ((sensor.max - sensor.min) * 0.002);
      }
    }

    // Applied last, to the finished reading, so a tared channel sits at zero
    // plus its own noise — exactly what the hardware path produces.
    for (const [id, offset] of this.tares) {
      if (offset && id in out) out[id] -= offset;
    }

    this.lastSample = out;
    return out;
  }

  /**
   * Zero sensors against their current reading; `clear` restores them.
   *
   * Mirrors the NI-DAQ driver's contract, including the re-tare behaviour: the
   * existing offset is added back before the new one is taken, so taring twice
   * lands in the same place rather than stacking.
   */
  tareSensors(ids, { clear = false } = {}) {
    const tared = [];
    for (const id of ids) {
      if (!this.config?.sensors.some((s) => s.id === id)) continue;
      if (clear) {
        this.tares.set(id, 0);
      } else {
        const shown = this.lastSample[id];
        if (!Number.isFinite(shown)) continue;      // nothing to zero against
        this.tares.set(id, shown + (this.tares.get(id) || 0));
      }
      tared.push(id);
    }
    return { ok: true, tared, unsupported: ids.filter((id) => !tared.includes(id)) };
  }

  /**
   * Per-valve solenoid current, the way the PANDA's `s` lines report it.
   *
   * Without this the current-sense row on the Control Grid simply never
   * appears in the simulator, which is how five channels came to be pointing
   * at valve ids the stand no longer had: the readings were missing on
   * hardware and there was no way to notice, because they were missing
   * everywhere else too.
   *
   * `energized` is derived from the MEASURED current, not from what was
   * commanded — a coil that was told to pull in and did not is the entire
   * reason this row exists, so deriving it from the command would make the
   * indicator agree with itself and never with the hardware.
   */
  /**
   * The same channel names dcStatus() fabricates, available before any have
   * been measured — so a simulator trace carries the same column headers as a
   * stand trace and a plotting script written against one reads the other.
   */
  dcLabels() {
    const out = {};
    for (const valve of this.config?.valves || []) {
      if (Number.isInteger(valve.channel)) out[valve.id] = `DC${valve.channel}`;
    }
    return out;
  }

  dcStatus() {
    const out = {};
    for (const valve of this.config?.valves || []) {
      if (!Number.isInteger(valve.channel)) continue;
      const state = this.valveState.get(valve.id);
      // A normally-open valve is energized to CLOSE, so coil state is not flow
      // state — the same resolution setValve does on the way out.
      const energized = valve.normallyOpen ? state === 'closed' : state === 'open';
      // Idle is NOT zero. A real board's sense resistors leak a few tenths of
      // a milliamp and that reading wanders constantly, which is the only
      // sign from the card that a channel is alive at all. Modelling idle as a
      // clean zero hid a display bug that rendered every real channel as a
      // frozen "0.00 A".
      const amps = Math.max(0, energized
        ? COIL_HOLD_AMPS + gauss() * 0.015
        : COIL_LEAK_AMPS + gauss() * 0.00005)
      out[valve.id] = {
        id: `DC${valve.channel}`,
        amps,
        energized: amps >= this.dcThresholdA,
      };
    }
    return out;
  }

  /** Every modelled sensor can be tared, so every one reports an offset. */
  tareStatus() {
    const out = {};
    for (const s of this.config?.sensors || []) out[s.id] = this.tares.get(s.id) || 0;
    return out;
  }

  get status() {
    // The model produces a fresh sample on demand, so it is by definition
    // current — reporting the clock keeps the link indicator honest instead
    // of showing a simulated stand as permanently stale.
    return { name: this.name, connected: true, lastRxAt: Date.now(), detail: this.detail };
  }

  async close() {}
}

function freshBbSide() {
  return {
    state: 'OFF',
    stateValid: true,
    press: false,
    vent: false,
    pressure: null,
    lastBeatAt: 0,
    confirmed: {},
    confirmedAt: 0,
  };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

let spare = null;
/** Box-Muller normal(0,1). */
function gauss() {
  if (spare !== null) { const v = spare; spare = null; return v; }
  let u = 0, v = 0, s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  spare = v * mul;
  return u * mul;
}
