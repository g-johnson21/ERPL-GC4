/**
 * simulator.js — lumped-parameter model of the Draco test stand.
 *
 * Lets you exercise the full GUI, autosequences, bang-bang control and CSV
 * recording with no hardware attached. The model follows the stand's own
 * P&ID (Draco V4.02) tag for tag, so every transducer on the drawing reads
 * something that depends on the valves around it. It is tuned for *plausible*
 * traces to shake out the UI and sequences, NOT for engineering-grade
 * prediction. Do not size hardware from these numbers.
 *
 * THE STAND, AS MODELLED
 *   GN2       two bottle banks, one per bus (PT1, PT11). S1 / S2 pulse gas
 *             into the tanks through C1 / C3. PT2 sits between S1 and C1, so
 *             it reads the bottle's push while S1 is open and settles to tank
 *             pressure through the check valve afterwards. PT12 sits below C3
 *             and reads the fuel tank.
 *   Tanks     ullage pressure, propellant mass, and the hydrostatic head that
 *             separates PT4 / PT14 at the bottom from the ullage. PB1 / PB3
 *             are the normally-open vents. RV2 / RV3 relieve. LOX boils off
 *             and self-pressurizes a sealed tank; every tank leaks a little.
 *   LOX fill  from the dewar through PB5 and C5, only while the tank is below
 *             dewar head pressure -- vent the tank to fill it. B1 vents the
 *             fill line, B2 drains the tank.
 *   Run lines cavitating venturis (PT21 / PT22, PT23 / PT24): flow set by
 *             inlet pressure, throat at vapour pressure while it cavitates.
 *             C2 / C4 isolate the manifolds (PT5 / PT15) from the run valves.
 *   Purge     R1 regulates purge gas off the FUEL leg, so the purge bus (PT32)
 *             only holds pressure once the fuel side is pressurized. RV5
 *             relieves, B6 vents. S4 / S5 push purge gas into the manifolds.
 *   Muscle    the compressor keeps the surge tank between cut-in and cut-out
 *             (PT31); S3 vents it. The PB valves are spring-return pneumatic
 *             actuators: below MUSCLE_DROP_PSI they sit in their spring
 *             position whatever the coil says -- lose the bus and the mains
 *             shut while the vents fall open, as they would on the stand.
 *   Engine    ignites on its own once both propellants are flowing (the sim
 *             assumes the igniter is live), so a cold flow sequence burns.
 *
 * SIMULATOR-ONLY CONTROLS
 *   The hand valves (B1-B6) and the two regulators (R1, the compressor) have
 *   no channel on the real stand -- someone at the pad turns them. Here they
 *   are exposed through simControls() / simSetManual() / simSetRegulator(),
 *   which the server offers on /api/sim/* only while this driver is loaded,
 *   and the P&ID makes those symbols clickable. Nothing else in the system
 *   learns they exist.
 *
 * BANG-BANG
 *   The regulator does NOT run in this file. It runs in bb-firmware.js, an
 *   emulation of the PANDA board, and this driver talks to it over the same
 *   ASCII command grammar the real board uses -- encoded, handed across, and
 *   parsed back out of `BB:` and `EVT:` lines. So `npm run sim` exercises the
 *   real §5 protocol end to end, including the config echo and the enable
 *   handshake, rather than a shortcut that would agree with the server no
 *   matter what the wire format said.
 *
 *   The emulated board reads its OWN transducer (PT3 / PT13 on the drawing),
 *   offset and noised independently of the DAQ channel the ground station
 *   sees. That divergence is deliberate: two sensors on one tank is the real
 *   situation, and a simulator where both loops read the identical number
 *   would hide it.
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

/**
 * Below MUSCLE_DROP_PSI a pneumatic actuator cannot hold against its spring;
 * it does not pick its coil back up until the bus is above MUSCLE_PICKUP_PSI.
 * The gap is what keeps a bus hovering at the threshold from chattering every
 * actuator on the stand.
 */
const MUSCLE_DROP_PSI = 50;
const MUSCLE_PICKUP_PSI = 65;

/** Map model roles -> IDs from config/stand.json (Draco V4.02 tags). */
const roles = {
  valves: {
    oxPress: 'SV-LOXBB',       // S1
    fuelPress: 'SV-FBB',       // S2
    oxVent: 'SV-LOXV',         // PB1, normally open
    fuelVent: 'SV-FV',         // PB3, normally open
    oxMain: 'MV-LOX',          // PB2
    fuelMain: 'MV-F',          // PB4
    loxFill: 'SV-LOX-FILL',    // PB5
    goxVent: 'SV-GOX-PURGE',   // PB6
    oxPurge: 'SV-LOXPURGE',    // S4
    fuelPurge: 'SV-FPURGE',    // S5
    muscleVent: 'SV-MBV',      // S3
  },
  sensors: {
    oxBottleP: 'PT1',
    oxUpstreamP: 'PT2',
    oxTankBottomP: 'PT4',
    oxVenturiInP: 'PT21',
    oxVenturiThroatP: 'PT22',
    oxManifoldP: 'PT5',
    fuelBottleP: 'PT11',
    fuelUpstreamP: 'PT12',
    fuelTankBottomP: 'PT14',
    fuelVenturiInP: 'PT23',
    fuelVenturiThroatP: 'PT24',
    fuelManifoldP: 'PT15',
    chamberP: 'PT0',
    muscleP: 'PT31',
    purgeP: 'PT32',
    thrustA: 'LC1',
    thrustB: 'LC2',
    thrustC: 'LC3',
    oxTankWeight: 'LC4',
    oxTankBottomT: 'TC1',
    oxTankTopT: 'TC2',
    oxLineT: 'TC3',
    goxLineT: 'TC4',
    chamberT: 'TC5',
  },
};

/**
 * Hand valves, keyed by the id they carry on the P&ID. `closed` is where a
 * stand is left between tests; B1 and B3 are vents and start shut too.
 */
const HAND_VALVES = {
  B1: { name: 'LOX fill line vent', state: 'closed' },
  B2: { name: 'LOX tank drain', state: 'closed' },
  B3: { name: 'Fuel tank manual vent', state: 'closed' },
  B4: { name: 'Fuel tank drain', state: 'closed' },
  B6: { name: 'Purge bus vent', state: 'closed' },
};

/** Regulators, keyed by their P&ID id. `psi` is the set pressure. */
const REGULATORS = {
  R1: { name: 'Purge regulator', psi: 200, min: 0, max: 300, step: 5 },
  'AC-1': { name: 'Air compressor cut-out', psi: 120, min: 0, max: 150, step: 5 },
};

/** Model tuning constants -- adjust to make the sim behave like your stand. */
const tune = {
  bottleStartPsi: 6000,
  // Bottle pressure lost per psi delivered to a tank. Two 6K bottles feeding
  // an ullage a few tens of litres: roughly a fifth.
  bottleDrain: 0.2,
  // Tank pressure gained per second per psi of bottle behind the solenoid --
  // choked flow through the press valve orifice. 6000 psi bottles give about
  // 66 psi/s, so a 500 ms bang-bang pulse lands 30 psi and a tank comes up
  // from ambient to a 450 psi setpoint in a dozen seconds of pulsing.
  pressFlow: 0.011,
  // What PT2 reads above the tank while S1 is open: the check valve's crack
  // plus line loss, which grows a little with the push behind it.
  upstreamRise: 40,
  upstreamRisePerBottlePsi: 0.005,
  ventGain: 0.55,        // tank blowdown coefficient through the GN2 vent
  manualVentGain: 0.35,  // B3 is a smaller port than PB3
  tankLeak: 0.0025,
  boilOffPsiPerS: 0.4,   // LOX self-pressurization, sealed tank
  reliefs: { RV2: 1300, RV3: 1400, RV5: 250 },
  dewarPsi: 40,          // head pressure the dewar pushes LOX with
  fillRate: 2.4,         // lbm/s through PB5 with the tank vented
  drainRate: 1.6,        // lbm/s through B2 / B4
  goxVentRate: 0.12,     // lbm/s of LOX lost through PB6
  oxMassFull: 60,        // lbm, a full LOX tank
  fuelMassFull: 45,
  fuelStartMass: 45,     // fuel is hand-loaded before the test
  tankHeightIn: 70,
  loxDensity: 71.2,      // lb/ft^3
  fuelDensity: 49.1,
  oxTankDryLbf: 85,      // what LC4 reads with the tank empty
  // Cavitating venturi flow: mdot = CdA * sqrt(P_in - P_vapour), lbm/s.
  oxCdA: 0.070,
  fuelCdA: 0.050,
  loxVapourPsi: 22,
  fuelVapourPsi: 2,
  injectorK: 40,         // manifold psi above chamber per (lbm/s)^2
  pcPerMdot: 120,        // chamber psi per lbm/s of total flow
  cstarEff: 0.92,
  throatAreaIn2: 1.15,
  thrustCoeff: 1.42,
  ignitionDelayS: 0.3,   // both propellants flowing this long lights the chamber
  flameoutGraceS: 0.15,  // flow may dip this long before the burn is declared out
  // Purge bus: what R1 can pass, what an open purge solenoid or the B6 vent
  // takes out, all in psi/s of bus pressure.
  regFlow: 150,
  regRelieveGain: 0.4,
  purgeDraw: 35,
  purgeVentGain: 2.5,   // a wide-open B6 outruns what R1 can pass
  // Muscle bus. The compressor cuts in `cutInBelow` under its set pressure,
  // S3 blows the bus down, and every actuator stroke costs a slug.
  compressorRate: 30,
  cutInBelow: 12,
  muscleVentGain: 0.8,
  actuatorSlugPsi: 4,
};

/**
 * Transducer noise, one sigma in engineering units. Deliberately small: a
 * good 1500 psi transducer on a quiet DAQ holds to a couple of tenths, and a
 * trace that dances by whole psi teaches an operator to read noise as signal.
 */
const noise = {
  pt: 0.15,
  bottle: 1.5,
  throat: 0.3,
  chamberIdle: 0.3,
  chamberBurn: 2.5,
  tc: 0.12,
  chamberTcBurn: 4,
  lcIdle: 0.4,
  lcBurn: 2.5,
  tankWeight: 0.15,
  board: 0.3,
};

export class SimulatorDriver {
  constructor(options = {}) {
    this.name = 'simulator';
    this.connected = true;
    this.detail = 'Physics simulator (no hardware)';
    this.opts = options;
    // Injectable clock (ms), so a test can march the model through a fill or
    // a burn without waiting for one.
    this.now = options.now || (() => Date.now());
    this.commanded = new Map();    // valveId -> 'open' | 'closed', what the coil was told
    this.valveState = new Map();   // valveId -> 'open' | 'closed', where the valve actually is
    this.springHeld = new Set();   // pneumatic valves currently dropped to their spring
    this.lastT = this.now() / 1000;
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
      oxBottleP: tune.bottleStartPsi,
      fuelBottleP: tune.bottleStartPsi,
      oxUpstreamP: AMBIENT_PSI,   // PT2: between S1 and C1
      oxP: AMBIENT_PSI,           // LOX tank ullage
      fuelP: AMBIENT_PSI,         // fuel tank ullage
      oxMass: 0,                  // the LOX tank is filled from the dewar
      fuelMass: tune.fuelStartMass,
      oxManP: AMBIENT_PSI,        // PT5, below C2
      fuelManP: AMBIENT_PSI,      // PT15, below C4
      purgeP: AMBIENT_PSI,
      muscleP: REGULATORS['AC-1'].psi,
      compressorOn: false,
      chamberP: AMBIENT_PSI,
      thrust: 0,
      oxTankBottomT: AMBIENT_F,
      oxTankTopT: AMBIENT_F,
      oxLineT: AMBIENT_F,
      goxLineT: AMBIENT_F,
      chamberT: AMBIENT_F,
      bothFlowingFor: 0,
      burning: false,
      flameoutFor: 0,
      mdotF: 0,
      mdotO: 0,
    };

    this.hand = structuredClone(HAND_VALVES);
    this.regs = structuredClone(REGULATORS);

    // Tare offsets, in engineering units, subtracted from the model's output.
    //
    // The real stand zeroes inside the NI-DAQ sidecar, before conversion; the
    // model has no such layer, so it subtracts here instead. What matters is
    // that both honour the same driver contract -- the point of the simulator
    // is that the screens above it can be exercised for real with no hardware
    // attached, and a zeroing function nobody can try out is a zeroing
    // function nobody trusts on test day.
    this.tares = new Map();
    this.lastSample = {};
  }

  async init(config) {
    this.config = config;
    for (const v of config.valves) {
      const state = v.safeState || (v.normallyOpen ? 'open' : 'closed');
      this.commanded.set(v.id, state);
      this.valveState.set(v.id, state);
    }
    this.bindBangBang(config);
    return this;
  }

  /**
   * Point the model's press/vent/tank roles at whatever the bang-bang config
   * actually names, so the emulated board pressurises the tank the operator is
   * watching instead of a role id from an older stand.
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
      } else {
        if (c.valve) this.roles.valves.fuelPress = c.valve;
        if (c.ventValve) this.roles.valves.fuelVent = c.ventValve;
      }
    }
  }

  // ------------------------------------------------------------- valves ----

  setValve(valve, state /* 'open' | 'closed' */) {
    this.commanded.set(valve.id, state);
    this.settleActuator(valve, true);
  }

  /**
   * Where a valve actually is, given what its coil was told.
   *
   * A solenoid follows its coil. A pneumatic ball valve follows its coil only
   * while the muscle bus can hold it against its spring; below MUSCLE_MIN_PSI
   * it drops to the spring position -- open for a normally-open vent, closed
   * for a main -- and stays there until the bus comes back, at which point it
   * goes wherever the coil has been asking for.
   */
  settleActuator(valve, fromCommand = false) {
    const wanted = this.commanded.get(valve.id);
    const was = this.valveState.get(valve.id);
    let actual = wanted;
    let powered = true;
    if (valve.type === 'ball') {
      const spring = valve.normallyOpen ? 'open' : 'closed';
      const p = this.s.muscleP;
      // Dropped out below one threshold, back in only above a higher one.
      const held = this.springHeld.has(valve.id)
        ? p < MUSCLE_PICKUP_PSI
        : p < MUSCLE_DROP_PSI;
      if (held) this.springHeld.add(valve.id); else this.springHeld.delete(valve.id);
      if (held) {
        actual = spring;
        powered = false;
        if (fromCommand && actual !== wanted) {
          this.onEvent(
            `${valve.id} did not move: muscle bus at ${p.toFixed(0)} psi, ` +
            `actuator held ${actual.toUpperCase()} by its spring`, 'warn');
        }
      }
    }
    if (actual !== was) {
      this.valveState.set(valve.id, actual);
      // A stroke under muscle power costs the bus a slug; falling to the
      // spring costs nothing, the spring did the work.
      if (valve.type === 'ball' && powered) {
        this.s.muscleP = Math.max(AMBIENT_PSI, this.s.muscleP - tune.actuatorSlugPsi);
      }
      // A pneumatic valve moving on its own -- to its spring, or back to its
      // coil -- is news. A solenoid following the board's pulse is not.
      if (!fromCommand && valve.type === 'ball') {
        this.onEvent(`${valve.id} ${actual.toUpperCase()} — ` +
          (powered ? 'muscle bus restored, actuator followed its coil' : 'muscle bus lost, actuator fell to its spring position'), 'warn');
      }
    }
  }

  isOpen(role) {
    return this.valveState.get(this.roles.valves[role]) === 'open';
  }

  handOpen(id) {
    return this.hand[id]?.state === 'open';
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

  // ---------------------------------------------------- simulator controls ----
  //
  // Hand valves and regulators. On the stand these are turned by a person at
  // the pad; here they are the operator's, so a fill, a drain, a purge bus
  // vent or a regulator change can be rehearsed from the P&ID.

  simControls() {
    const manual = {};
    for (const [id, v] of Object.entries(this.hand)) manual[id] = { name: v.name, state: v.state };
    const regulators = {};
    for (const [id, r] of Object.entries(this.regs)) {
      regulators[id] = { name: r.name, psi: r.psi, min: r.min, max: r.max, step: r.step };
    }
    return { manual, regulators };
  }

  simSetManual(id, state) {
    const v = this.hand[id];
    if (!v) return { ok: false, error: `No hand valve "${id}" in the simulator` };
    if (state !== 'open' && state !== 'closed') return { ok: false, error: 'state must be "open" or "closed"' };
    v.state = state;
    return { ok: true, id, state, name: v.name };
  }

  simSetRegulator(id, psi) {
    const r = this.regs[id];
    if (!r) return { ok: false, error: `No regulator "${id}" in the simulator` };
    const value = Number(psi);
    if (!Number.isFinite(value)) return { ok: false, error: 'psi must be a number' };
    r.psi = clamp(value, r.min, r.max);
    return { ok: true, id, psi: r.psi, name: r.name };
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

  // PT tare, over the same emulated wire as everything else -- so `npm run
  // sim` exercises the real `T` grammar and the real PT_TARE / PT_ERROR
  // answers rather than a shortcut that would agree with the server no matter
  // what.
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
      side.lastBeatAt = this.now();
      return;
    }
    if (msg.kind === 'event') {
      if (msg.category === 'PT_TARE') {
        this.ptTareError = null;
        this.ptTareConfirmedAt = this.now();
        for (const [side, offset] of Object.entries(parsePtTare(msg.detail))) {
          if (this.ptOffsets[side] !== undefined) this.ptOffsets[side] = offset;
        }
      }
      if (msg.category === 'CFG_PUSH' && this.bb[msg.side]) {
        this.bbEchoes = true;
        Object.assign(this.bb[msg.side].confirmed, msg.config.fields);
        this.bb[msg.side].confirmedAt = this.now();
      }
      this.onEvent(`SIM-PANDA ${msg.category}${msg.side ? `:${msg.side}` : ''} ${msg.detail}`.trim(), 'info');
      return;
    }
    if (msg.kind === 'error') {
      this.onEvent(line, 'error');
      // A PT tare rejection is not a bang-bang rejection -- same split the
      // real driver makes, for the same reason.
      if (line.startsWith('PT_ERROR:')) { this.ptTareError = line; return; }
      this.onBbError?.(line);
    }
  }

  bbStatus() {
    const now = this.now();
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
   * model. The board's PT is the tank ullage (PT3 / PT13 on the drawing) with
   * an independent bias and noise -- see BOARD_PT_BIAS.
   */
  stepBoard(nowMs) {
    this.firmware.update({
      l: this.s.oxP + BOARD_PT_BIAS.l + gauss() * noise.board,
      f: this.s.fuelP + BOARD_PT_BIAS.f + gauss() * noise.board,
    }, nowMs);

    // The board owns a side's coils only while that side is regulating --
    // the same rule the server's bang-bang bank applies when it refuses a
    // hand command on an owned valve. An OFF side reports press=false like
    // any other, and applying that every tick would silently undo every S1
    // or S2 command an operator or a sequence sent by hand.
    const outputs = this.firmware.outputs();
    for (const [side, wiring] of Object.entries(this.bbSides)) {
      const demand = outputs[side];
      if (!demand || !this.boardOwns(side)) continue;
      if (wiring.valve) this.applyCoil(wiring.valve, demand.press);
      if (wiring.ventValve) this.applyCoil(wiring.ventValve, demand.vent);
    }
  }

  /** Is this side's regulator live, so its solenoids answer to the board? */
  boardOwns(side) {
    const state = this.firmware.sides?.[side]?.state;
    return state === 'SUS' || state === 'AV';
  }

  /** The board commands a COIL; the model tracks FLOW state. */
  applyCoil(valveId, energized) {
    const valve = this.config?.valves.find((v) => v.id === valveId);
    if (!valve) return;
    this.commanded.set(valveId, valve.normallyOpen
      ? (energized ? 'closed' : 'open')
      : (energized ? 'open' : 'closed'));
    this.settleActuator(valve);
  }

  // ------------------------------------------------------------ physics ----

  /** Advance physics and return { sensorId: engineeringValue }. */
  read() {
    const now = this.now() / 1000;
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
    for (let i = 0; i < steps; i++) this.step(h);
    return this.sample();
  }

  step(dt) {
    const s = this.s;
    const relax = (rate) => Math.min(1, rate * dt);

    // --- Muscle bus -------------------------------------------------------
    const cutOut = this.regs['AC-1'].psi;
    if (cutOut <= AMBIENT_PSI) s.compressorOn = false;
    else if (s.muscleP < cutOut - tune.cutInBelow) s.compressorOn = true;
    else if (s.muscleP >= cutOut) s.compressorOn = false;
    if (s.compressorOn) s.muscleP += tune.compressorRate * dt;
    if (this.isOpen('muscleVent')) s.muscleP -= (s.muscleP - AMBIENT_PSI) * tune.muscleVentGain * dt;
    s.muscleP -= (s.muscleP - AMBIENT_PSI) * 0.004 * dt;   // fittings weep
    s.muscleP = Math.max(AMBIENT_PSI, s.muscleP);
    // Spring-return actuators follow the bus, not just the coil.
    for (const v of this.config?.valves || []) {
      if (v.type === 'ball') this.settleActuator(v);
    }

    // --- GN2 pressurization ---------------------------------------------
    // PT2 lives between S1 and C1. With S1 open it reads the push above the
    // tank; with S1 shut it bleeds through the check valve to tank pressure.
    if (this.isOpen('oxPress')) {
      const target = s.oxP + tune.upstreamRise + tune.upstreamRisePerBottlePsi * s.oxBottleP;
      s.oxUpstreamP += (Math.min(target, s.oxBottleP) - s.oxUpstreamP) * relax(12);
      const d = tune.pressFlow * s.oxBottleP * dt;
      s.oxP += d;
      s.oxBottleP = Math.max(AMBIENT_PSI, s.oxBottleP - d * tune.bottleDrain);
    } else {
      s.oxUpstreamP += (s.oxP - s.oxUpstreamP) * relax(1.6);
    }
    if (this.isOpen('fuelPress')) {
      const d = tune.pressFlow * s.fuelBottleP * dt;
      s.fuelP += d;
      s.fuelBottleP = Math.max(AMBIENT_PSI, s.fuelBottleP - d * tune.bottleDrain);
    }

    // --- Venting, relief, leaks, boil-off ------------------------------------
    if (this.isOpen('oxVent')) s.oxP -= (s.oxP - AMBIENT_PSI) * tune.ventGain * dt;
    if (this.isOpen('fuelVent')) s.fuelP -= (s.fuelP - AMBIENT_PSI) * tune.ventGain * dt;
    if (this.handOpen('B3')) s.fuelP -= (s.fuelP - AMBIENT_PSI) * tune.manualVentGain * dt;
    s.oxP -= (s.oxP - AMBIENT_PSI) * tune.tankLeak * dt;
    s.fuelP -= (s.fuelP - AMBIENT_PSI) * tune.tankLeak * dt;
    if (!this.isOpen('oxVent') && s.oxMass > 0.5) s.oxP += tune.boilOffPsiPerS * dt;
    s.oxP = relieve(s.oxP, tune.reliefs.RV2, dt);
    s.fuelP = relieve(s.fuelP, tune.reliefs.RV3, dt);

    // --- LOX fill, drains, GOX vent -----------------------------------------
    if (this.isOpen('loxFill') && s.oxMass < tune.oxMassFull) {
      // The dewar can only push against a tank that is below its own head.
      const push = clamp((tune.dewarPsi - s.oxP) / (tune.dewarPsi - AMBIENT_PSI), 0, 1);
      const rate = tune.fillRate * push * (this.handOpen('B1') ? 0.5 : 1);
      s.oxMass = Math.min(tune.oxMassFull, s.oxMass + rate * dt);
      // Liquid coming in squeezes the ullage of a sealed tank.
      if (!this.isOpen('oxVent')) s.oxP += rate * 0.8 * dt;
    }
    if (this.handOpen('B2') && s.oxMass > 0) {
      s.oxMass = Math.max(0, s.oxMass - tune.drainRate * dt * (1 + s.oxP / 300));
      s.oxP -= (s.oxP - AMBIENT_PSI) * 0.25 * dt;
    }
    if (this.handOpen('B4') && s.fuelMass > 0) {
      s.fuelMass = Math.max(0, s.fuelMass - tune.drainRate * dt * (1 + s.fuelP / 300));
      s.fuelP -= (s.fuelP - AMBIENT_PSI) * 0.25 * dt;
    }
    if (this.isOpen('goxVent')) {
      s.oxP -= (s.oxP - AMBIENT_PSI) * 0.08 * dt;
      if (s.oxMass > 0) s.oxMass = Math.max(0, s.oxMass - tune.goxVentRate * dt);
    }

    // --- Purge bus: R1 regulates off the fuel leg ---------------------------
    const purgeSupply = Math.max(AMBIENT_PSI, s.fuelP - 5);
    const purgeSet = Math.min(this.regs.R1.psi, purgeSupply);
    if (s.purgeP < purgeSet) {
      const refill = Math.min(tune.regFlow * dt, purgeSet - s.purgeP);
      s.purgeP += refill;
      s.fuelP -= refill * 0.05;   // the gas came from the fuel ullage
    } else if (s.purgeP > this.regs.R1.psi + 2) {
      // Self-relieving: turned down, the regulator bleeds the bus to match.
      s.purgeP -= (s.purgeP - this.regs.R1.psi) * tune.regRelieveGain * dt;
    }
    let purgeUsers = 0;
    if (this.isOpen('oxPurge')) purgeUsers++;
    if (this.isOpen('fuelPurge')) purgeUsers++;
    if (purgeUsers) s.purgeP -= tune.purgeDraw * purgeUsers * dt;
    if (this.handOpen('B6')) s.purgeP -= (s.purgeP - AMBIENT_PSI) * tune.purgeVentGain * dt;
    s.purgeP -= (s.purgeP - AMBIENT_PSI) * 0.003 * dt;
    s.purgeP = relieve(Math.max(AMBIENT_PSI, s.purgeP), tune.reliefs.RV5, dt);

    // --- Run lines: cavitating venturis --------------------------------------
    const oxBottomP = s.oxP + this.head('ox');
    const fuelBottomP = s.fuelP + this.head('fuel');
    const oxOpen = this.isOpen('oxMain') && s.oxMass > 0.05;
    const fuelOpen = this.isOpen('fuelMain') && s.fuelMass > 0.05;
    // The venturi meters on its inlet as long as the manifold stays well
    // below it; a manifold pushed up near the inlet un-chokes it.
    const oxChoke = clamp((oxBottomP - s.oxManP) / 60, 0, 1);
    const fuelChoke = clamp((fuelBottomP - s.fuelManP) / 60, 0, 1);
    s.mdotO = oxOpen ? tune.oxCdA * Math.sqrt(Math.max(0, oxBottomP - tune.loxVapourPsi)) * oxChoke : 0;
    s.mdotF = fuelOpen ? tune.fuelCdA * Math.sqrt(Math.max(0, fuelBottomP - tune.fuelVapourPsi)) * fuelChoke : 0;

    s.oxMass = Math.max(0, s.oxMass - s.mdotO * dt);
    s.fuelMass = Math.max(0, s.fuelMass - s.mdotF * dt);
    // Draining liquid grows the ullage, so tank pressure sags unless made up.
    if (s.mdotO > 0) s.oxP -= s.mdotO * 3.0 * dt;
    if (s.mdotF > 0) s.fuelP -= s.mdotF * 3.4 * dt;

    // --- Combustion -----------------------------------------------------------
    const bothFlowing = s.mdotO > 0.05 && s.mdotF > 0.05;
    if (bothFlowing) {
      s.bothFlowingFor += dt;
      if (s.bothFlowingFor >= tune.ignitionDelayS) s.burning = true;
      s.flameoutFor = 0;
    } else {
      s.bothFlowingFor = 0;
      // A hot chamber does not extinguish the instant flow dips -- give it a
      // short grace period before declaring flameout.
      s.flameoutFor += dt;
      if (s.flameoutFor > tune.flameoutGraceS) s.burning = false;
    }

    const mdotTotal = s.mdotO + s.mdotF;
    let targetPc = AMBIENT_PSI;
    if (s.burning) {
      targetPc = AMBIENT_PSI + mdotTotal * tune.pcPerMdot * tune.cstarEff;
    } else if (mdotTotal > 0) {
      targetPc = AMBIENT_PSI + mdotTotal * 5;      // cold-flow backpressure only
    } else if (purgeUsers) {
      targetPc = AMBIENT_PSI + 4 * purgeUsers * clamp((s.purgeP - AMBIENT_PSI) / 100, 0, 1);
    }
    s.chamberP += (targetPc - s.chamberP) * relax(14);

    // --- Manifolds, below the check valves -----------------------------------
    // Fed by the run valve while it flows, by the purge solenoid while it is
    // open, and otherwise left to leak down through the injector.
    const manifold = (current, mdot, purgeOpen) => {
      if (mdot > 0) return current + (s.chamberP + tune.injectorK * mdot * mdot - current) * relax(10);
      if (purgeOpen) return current + (Math.max(s.chamberP, s.purgeP - 8) - current) * relax(6);
      return current + (s.chamberP - current) * relax(0.7);
    };
    s.oxManP = manifold(s.oxManP, s.mdotO, this.isOpen('oxPurge'));
    s.fuelManP = manifold(s.fuelManP, s.mdotF, this.isOpen('fuelPurge'));

    const targetThrust = s.burning
      ? Math.max(0, (s.chamberP - AMBIENT_PSI) * tune.throatAreaIn2 * tune.thrustCoeff)
      : 0;
    s.thrust += (targetThrust - s.thrust) * relax(16);

    // --- Thermal --------------------------------------------------------------
    const wetted = s.oxMass > 1;
    s.oxTankBottomT += ((wetted ? LOX_F : AMBIENT_F) - s.oxTankBottomT) * relax(wetted ? 0.35 : 0.015);
    const fill = s.oxMass / tune.oxMassFull;
    const topTarget = fill > 0.85 ? LOX_F + 30 : fill > 0.05 ? LOX_F + 60 + (1 - fill) * 140 : AMBIENT_F;
    s.oxTankTopT += (topTarget - s.oxTankTopT) * relax(wetted ? 0.12 : 0.02);
    s.oxLineT += ((wetted ? LOX_F + 20 : AMBIENT_F) - s.oxLineT) * relax(wetted ? 0.25 : 0.03);
    const goxCold = oxOpen || (this.isOpen('goxVent') && wetted);
    s.goxLineT += ((goxCold ? LOX_F + 35 : AMBIENT_F) - s.goxLineT) * relax(goxCold ? 0.8 : 0.03);
    const chamberTarget = s.burning ? Math.min(2200, 1400 + s.chamberP * 2) : AMBIENT_F;
    s.chamberT += (chamberTarget - s.chamberT) * relax(s.burning ? 0.9 : 0.04);

    s.oxP = Math.max(AMBIENT_PSI, s.oxP);
    s.fuelP = Math.max(AMBIENT_PSI, s.fuelP);
    s.chamberP = Math.max(AMBIENT_PSI, s.chamberP);
  }

  /** Hydrostatic head at the bottom of a tank, psi, from its liquid column. */
  head(side) {
    const mass = side === 'ox' ? this.s.oxMass : this.s.fuelMass;
    const full = side === 'ox' ? tune.oxMassFull : tune.fuelMassFull;
    const rho = side === 'ox' ? tune.loxDensity : tune.fuelDensity;
    const inches = tune.tankHeightIn * clamp(mass / full, 0, 1);
    return (rho * inches) / 1728;
  }

  sample() {
    const s = this.s;
    const out = {};
    const put = (role, value, sigma) => {
      const id = this.roles.sensors[role];
      if (id) out[id] = value + gauss() * sigma;
    };

    const oxBottomP = s.oxP + this.head('ox');
    const fuelBottomP = s.fuelP + this.head('fuel');
    const oxFlowing = s.mdotO > 0;
    const fuelFlowing = s.mdotF > 0;

    put('oxBottleP', s.oxBottleP, noise.bottle);
    put('fuelBottleP', s.fuelBottleP, noise.bottle);
    put('oxUpstreamP', s.oxUpstreamP, noise.pt);
    put('fuelUpstreamP', s.fuelP, noise.pt);
    put('oxTankBottomP', oxBottomP, noise.pt);
    put('fuelTankBottomP', fuelBottomP, noise.pt);
    // The run line up to the venturi reads tank-bottom pressure at rest and a
    // little less under flow; the throat drops to vapour pressure while the
    // venturi cavitates and sits at line pressure when nothing moves.
    put('oxVenturiInP', oxBottomP - (oxFlowing ? 2 + 0.6 * s.mdotO * s.mdotO : 0), noise.pt);
    put('oxVenturiThroatP', oxFlowing ? tune.loxVapourPsi + 4 : oxBottomP, oxFlowing ? noise.throat : noise.pt);
    put('fuelVenturiInP', fuelBottomP - (fuelFlowing ? 2 + 0.6 * s.mdotF * s.mdotF : 0), noise.pt);
    put('fuelVenturiThroatP', fuelFlowing ? tune.fuelVapourPsi + 6 : fuelBottomP, fuelFlowing ? noise.throat : noise.pt);
    put('oxManifoldP', s.oxManP, noise.pt);
    put('fuelManifoldP', s.fuelManP, noise.pt);
    put('chamberP', s.chamberP, s.burning ? noise.chamberBurn : noise.chamberIdle);
    put('muscleP', s.muscleP, noise.pt);
    put('purgeP', s.purgeP, noise.pt);

    // Thrust is carried by three cells; the mount is never perfectly even.
    const lc = s.burning ? noise.lcBurn : noise.lcIdle;
    put('thrustA', s.thrust * 0.345, lc);
    put('thrustB', s.thrust * 0.330, lc);
    put('thrustC', s.thrust * 0.325, lc);
    put('oxTankWeight', tune.oxTankDryLbf + s.oxMass, noise.tankWeight);

    put('oxTankBottomT', s.oxTankBottomT, noise.tc);
    put('oxTankTopT', s.oxTankTopT, noise.tc);
    put('oxLineT', s.oxLineT, noise.tc);
    put('goxLineT', s.goxLineT, noise.tc);
    put('chamberT', s.chamberT, s.burning ? noise.chamberTcBurn : noise.tc);

    // Anything the model does not cover still produces a live channel: a
    // spare thermocouple reads the room, a spare PT reads zero.
    for (const sensor of this.config?.sensors || []) {
      if (!(sensor.id in out)) {
        const base = sensor.kind === 'temperature' ? AMBIENT_F : 0;
        const sigma = sensor.kind === 'temperature' ? noise.tc : noise.pt;
        out[sensor.id] = base + gauss() * sigma;
      }
    }

    // Applied last, to the finished reading, so a tared channel sits at zero
    // plus its own noise -- exactly what the hardware path produces.
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
   * The same channel names dcStatus() fabricates, available before any have
   * been measured -- so a simulator trace carries the same column headers as a
   * stand trace and a plotting script written against one reads the other.
   */
  dcLabels() {
    const out = {};
    for (const valve of this.config?.valves || []) {
      if (Number.isInteger(valve.channel)) out[valve.id] = `DC${valve.channel}`;
    }
    return out;
  }

  /**
   * Per-valve solenoid current, the way the PANDA's `s` lines report it.
   *
   * Measured from the COIL, which follows the command -- not from where the
   * actuator ended up. A pneumatic valve whose muscle bus has collapsed still
   * pulls in its pilot solenoid, and the current sense dutifully reports it
   * energized; that the valve did not move is a different problem, and one
   * the current sense on the real board cannot see either.
   *
   * `energized` is derived from the measured current, not from the command,
   * because a coil that was told to pull in and did not is the entire reason
   * this row exists.
   */
  dcStatus() {
    const out = {};
    for (const valve of this.config?.valves || []) {
      if (!Number.isInteger(valve.channel)) continue;
      const state = this.commanded.get(valve.id);
      // A normally-open valve is energized to CLOSE, so coil state is not flow
      // state -- the same resolution applyCoil does on the way in.
      const energized = valve.normallyOpen ? state === 'closed' : state === 'open';
      // Idle is NOT zero. A real board's sense resistors leak a few tenths of
      // a milliamp and that reading wanders constantly, which is the only
      // sign from the card that a channel is alive at all. Modelling idle as a
      // clean zero hid a display bug that rendered every real channel as a
      // frozen "0.00 A".
      const amps = Math.max(0, energized
        ? COIL_HOLD_AMPS + gauss() * 0.015
        : COIL_LEAK_AMPS + gauss() * 0.00005);
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
    // current -- reporting the clock keeps the link indicator honest instead
    // of showing a simulated stand as permanently stale.
    return { name: this.name, connected: true, lastRxAt: this.now(), detail: this.detail };
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

/** A relief valve: anything above its set pressure is dumped within a few ms. */
function relieve(p, setPsi, dt) {
  if (p <= setPsi) return p;
  return setPsi + (p - setPsi) * Math.exp(-40 * dt);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

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
