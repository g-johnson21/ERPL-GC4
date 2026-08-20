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
 */

const AMBIENT_PSI = 14.7;
const AMBIENT_F = 72;
const LOX_F = -297;

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
  }

  async init(config) {
    this.config = config;
    for (const v of config.valves) {
      this.valveState.set(v.id, v.safeState || (v.normallyOpen ? 'open' : 'closed'));
    }
    return this;
  }

  setValve(valve, state /* 'open' | 'closed' */) {
    this.valveState.set(valve.id, state);
    if (valve.id === roles.valves.igniter && state === 'open') {
      this.s.igniterFiredAt = Date.now() / 1000;
    }
  }

  isOpen(role) {
    return this.valveState.get(roles.valves[role]) === 'open';
  }

  /** Advance physics and return { sensorId: engineeringValue }. */
  read() {
    const now = Date.now() / 1000;
    const elapsed = Math.min(0.25, Math.max(0, now - this.lastT));
    this.lastT = now;

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
    const isoOpen = this.isOpen('n2iso');
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
      const id = roles.sensors[role];
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
    return out;
  }

  get status() {
    return { name: this.name, connected: true, detail: this.detail };
  }

  async close() {}
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
