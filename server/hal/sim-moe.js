/**
 * sim-moe.js — lumped-parameter model of MOE and its ground support equipment.
 *
 * Selected by `meta.simModel: "moe"` in the stand config (see hal/index.js).
 * Everything that is not the physics -- the emulated PANDA bang-bang board,
 * coil current sense, tares, the simulator's hand valves and regulators --
 * is inherited from the Draco simulator unchanged, so `npm run sim` on MOE
 * exercises the same protocol paths it does on Draco.
 *
 * Like the Draco model it follows the drawing (MOE P&ID V2.0) and aims for
 * PLAUSIBLE traces to exercise screens and sequences. Do not size hardware
 * from it.
 *
 * THE VEHICLE, AS MODELLED
 *   GN2       two COPVs on one bus (GN2 BUS PT), filled from the ground
 *             through the GN2 QD and a check valve. GN2 VENT is normally
 *             open; the burst disk ruptures at 5000 psi and stays ruptured.
 *   Tanks     LOX PRESS / FUEL PRESS meter bus gas into each tank through an
 *             orifice. LOX VENT / FUEL VENT are normally open; both tanks
 *             relieve at 937 psi. LOX boils off and self-pressurizes when
 *             sealed. The tank PTs read ullage.
 *   Actuators the ACTUATOR REG is fed from the LOX press line, downstream of
 *             its orifice -- so the actuator bus (ACTUATOR PT) can only come
 *             up once the LOX tank is pressurized. MOV and MFV are
 *             spring-return pneumatic valves on that bus: below it they stay
 *             shut whatever the coil says. That is what the drawing implies,
 *             and the simulator shows it rather than hiding it.
 *   Engine    injector-limited flow from each tank through its main valve
 *             into the chamber; both propellants flowing lights it (the sim
 *             assumes the igniter is live). The engine PTs read injector
 *             manifold pressure. Sized to the P&ID's design point: 2.23 kg/s
 *             LOX, 2.02 kg/s IPA, 625 psi injector, 500 psi chamber.
 *
 * THE GROUND, AS MODELLED
 *   GSE muscle  compressor + surge tank (GSE MUSCLE PT), vented by GROUND
 *               PNEUMATICS VENT. Every GROUND ... valve is a spring-return
 *               pneumatic valve on this bus.
 *   GN2 GSE     supply bottles -> GROUND GN2 REG -> orifice -> GROUND GN2
 *               PRESS -> GN2 QD. GROUND GN2 VENT (normally open) bleeds the
 *               fill line. GN2 QD CONTROL releases the QD while energized.
 *   LOX GSE     dewar -> GROUND LOX FILL -> LOX QD -> check valve -> tank.
 *               GROUND LOX VENT (normally open) dumps the fill line. LOX QD
 *               CONTROL releases the QD while energized. A sealed tank cannot
 *               be filled past dewar head pressure -- vent it to fill it.
 *   Fuel GSE    fuel storage, pushed by shop air through GROUND FUEL PRESS,
 *               out through GROUND FUEL QD FILL -> FUEL QD -> FUEL FILL
 *               SOLENOID into the vehicle's fuel line below the tank.
 */
import { SimulatorDriver, AMBIENT_PSI, relieve, clamp, gauss } from './simulator.js';

/** Model roles -> ids from config/moe.json. */
const MOE_ROLES = {
  valves: {
    oxPress: 'LOX-PRESS',
    fuelPress: 'FUEL-PRESS',
    oxVent: 'LOX-VENT',
    fuelVent: 'FUEL-VENT',
    gn2Vent: 'GN2-VENT',
    oxMain: 'MOV',
    fuelMain: 'MFV',
    fuelFill: 'FUEL-FILL',
    gndLoxFill: 'GND-LOX-FILL',
    gndLoxVent: 'GND-LOX-VENT',
    gndGn2Press: 'GND-GN2-PRESS',
    gndGn2Vent: 'GND-GN2-VENT',
    gn2QdRelease: 'GN2-QD-CTRL',
    loxQdRelease: 'LOX-QD-CTRL',
    pneuVent: 'GND-PNEU-VENT',
  },
  sensors: {
    busP: 'GN2-BUS-PT',
    fuelTankP: 'FUEL-TANK-PT',
    oxTankP: 'LOX-TANK-PT',
    actuatorP: 'ACTUATOR-PT',
    oxEngineP: 'LOX-ENGINE-PT',
    fuelEngineP: 'FUEL-ENGINE-PT',
    muscleP: 'GSE-MUSCLE-PT',
    loxFillP: 'LOX-FILL-PT',
    gn2FillP: 'GN2-FILL-PT',
    gn2RegP: 'GN2-REG-PT',
    gn2BottleP: 'GN2-BOTTLE-PT',
    fuelFillP: 'FUEL-FILL-PT',
  },
};

/**
 * Hand valves, keyed by their P&ID component id. The supply valves start
 * open -- opening the bottles and the dewar is pad setup, done before anyone
 * sits at the console -- and everything on the fuel cart starts shut.
 */
const MOE_HAND_VALVES = {
  'HV-GN2-BOTTLES': { name: 'GN2 supply bottle valves', state: 'open' },
  'HV-LOX-DEWAR': { name: 'LOX dewar liquid valve', state: 'open' },
  'HV-FUEL-PRESS': { name: 'Ground fuel press', state: 'closed' },
  'HV-FUEL-VENT': { name: 'Ground fuel vent', state: 'closed' },
  'HV-FUEL-FILL': { name: 'Ground fuel fill (storage)', state: 'closed' },
  'HV-FUEL-QD-FILL': { name: 'Ground fuel QD fill', state: 'closed' },
  'HV-WATER-FILL': { name: 'Ground water fill', state: 'closed' },
};

/** Regulators, keyed by their P&ID component id. `psi` is the set pressure. */
const MOE_REGULATORS = {
  'GND-GN2-REG': { name: 'Ground GN2 regulator', psi: 4000, min: 0, max: 4500, step: 50 },
  'ACT-REG': { name: 'Actuator regulator', psi: 150, min: 0, max: 300, step: 5 },
  'GSE-COMP': { name: 'GSE air compressor cut-out', psi: 150, min: 0, max: 200, step: 5 },
};

/** Model tuning constants. */
const tune = {
  supplyStartPsi: 6000,
  supplyDrain: 0.02,       // supply psi lost per psi delivered to the bus
  regFlowGn2: 2500,        // psi/s the ground regulator can push into the fill line
  fillLineVent: 3,         // fill line blowdown through GROUND GN2 VENT
  busFill: 0.6,            // bus psi/s per psi of fill line above it, through the QD
  busVent: 0.35,           // GN2 VENT blowdown
  burstPsi: 5000,
  pressFlow: 0.011,        // tank psi/s per psi of bus above the tank
  pressBusDrain: 0.12,     // bus psi lost per psi delivered to a tank
  ventGain: 0.55,
  tankLeak: 0.0025,
  boilOffPsiPerS: 0.4,
  tankRelief: 937,
  // LOX fill
  dewarPsi: 40,
  loxFillRate: 2.4,        // lbm/s with the tank vented
  loxSqueeze: 1.6,         // ullage psi per lbm of LOX let into a sealed tank
  oxMassFull: 60,
  // Fuel fill
  fuelFillRate: 2.0,
  fuelMassFull: 50,
  storageMassFull: 80,
  storageRefill: 2.0,      // lbm/s through GROUND FUEL FILL / WATER FILL
  storagePressGain: 1.2,
  storageVentGain: 1.5,
  // Actuator bus
  actRegFlow: 200,
  actRelief: 250,
  actLeak: 0.003,
  actSlugPsi: 3,
  // GSE muscle
  compressorRate: 30,
  cutInBelow: 12,
  muscleVentGain: 2.0,     // wide enough to outrun the compressor, so venting drops the valves
  muscleSlugPsi: 4,
  // Engine: mdot = sqrt((P_tank_bottom - Pc) / R), injector = Pc + K mdot^2.
  // R and K are set so the design point lands on the P&ID's numbers with the
  // tanks at 700 psi.
  oxR: 8.33, fuelR: 10.1,
  oxInjK: 5.2, fuelInjK: 6.3,
  pcPerMdot: 53.5,         // chamber psi per lbm/s of total flow, burning
  coldPcPerMdot: 5,
  ignitionDelayS: 0.3,
  flameoutGraceS: 0.15,
  tankHeightIn: 60,
  loxDensity: 71.2,
  fuelDensity: 49.1,
};

const noise = { pt: 0.15, gn2: 1.5, injector: 1.8 };

/** Vehicle valves that stroke on the actuator bus rather than the GSE muscle. */
const ACTUATOR_BUS_ROLES = ['oxMain', 'fuelMain'];

export class MoeSimulatorDriver extends SimulatorDriver {
  constructor(options = {}) {
    super(options);
    this.name = 'simulator';
    this.detail = 'Physics simulator — MOE (no hardware)';
    this.roles = structuredClone(MOE_ROLES);
  }

  reset() {
    this.s = {
      supplyP: tune.supplyStartPsi,  // GN2 supply manifold, behind the bottles
      regP: AMBIENT_PSI,             // GN2 REG PT, downstream of the ground regulator
      gn2FillP: AMBIENT_PSI,         // GN2 FILL PT, the ground side of the GN2 QD
      busP: AMBIENT_PSI,             // the vehicle's GN2 COPVs
      burst: false,
      oxP: AMBIENT_PSI,              // LOX tank ullage -- named for the board emulation
      fuelP: AMBIENT_PSI,
      oxMass: 0,
      fuelMass: 0,
      actP: AMBIENT_PSI,
      muscleP: MOE_REGULATORS['GSE-COMP'].psi,
      compressorOn: false,
      loxLineP: AMBIENT_PSI,
      storageP: AMBIENT_PSI,
      storageMass: tune.storageMassFull,
      fuelLineP: AMBIENT_PSI,
      chamberP: AMBIENT_PSI,
      oxInjP: AMBIENT_PSI,
      fuelInjP: AMBIENT_PSI,
      mdotO: 0,
      mdotF: 0,
      bothFlowingFor: 0,
      flameoutFor: 0,
      burning: false,
    };
    this.hand = structuredClone(MOE_HAND_VALVES);
    this.regs = structuredClone(MOE_REGULATORS);
    this.tares = new Map();
    this.lastSample = {};
  }

  // ---------------------------------------------------------- actuators ----

  isActuatorBusValve(valve) {
    return ACTUATOR_BUS_ROLES.some((role) => this.roles.valves[role] === valve.id);
  }

  actuatorSupply(valve) {
    return this.isActuatorBusValve(valve)
      ? { psi: this.s.actP, name: 'actuator bus' }
      : { psi: this.s.muscleP, name: 'GSE muscle' };
  }

  chargeStroke(valve) {
    if (this.isActuatorBusValve(valve)) {
      this.s.actP = Math.max(AMBIENT_PSI, this.s.actP - tune.actSlugPsi);
    } else {
      this.s.muscleP = Math.max(AMBIENT_PSI, this.s.muscleP - tune.muscleSlugPsi);
    }
  }

  // ------------------------------------------------------------ physics ----

  step(dt) {
    const s = this.s;
    const relax = (rate) => Math.min(1, rate * dt);
    const open = (role) => this.isOpen(role);

    // --- GSE muscle ----------------------------------------------------------
    const cutOut = this.regs['GSE-COMP'].psi;
    if (cutOut <= AMBIENT_PSI) s.compressorOn = false;
    else if (s.muscleP < cutOut - tune.cutInBelow) s.compressorOn = true;
    else if (s.muscleP >= cutOut) s.compressorOn = false;
    if (s.compressorOn) s.muscleP += tune.compressorRate * dt;
    if (open('pneuVent')) s.muscleP -= (s.muscleP - AMBIENT_PSI) * tune.muscleVentGain * dt;
    s.muscleP -= (s.muscleP - AMBIENT_PSI) * 0.004 * dt;
    s.muscleP = Math.max(AMBIENT_PSI, s.muscleP);

    // --- Actuator bus: regulated off the LOX press line ---------------------
    // Downstream of its orifice the press line is open to the LOX ullage, so
    // that is what feeds the regulator. The regulator only ever adds gas;
    // the bus comes down by leakage, strokes and its relief.
    const actTarget = Math.min(this.regs['ACT-REG'].psi, s.oxP - 5);
    if (s.actP < actTarget) s.actP += Math.min(tune.actRegFlow * dt, actTarget - s.actP);
    s.actP -= (s.actP - AMBIENT_PSI) * tune.actLeak * dt;
    s.actP = relieve(Math.max(AMBIENT_PSI, s.actP), tune.actRelief, dt);

    for (const v of this.config?.valves || []) {
      if (v.type === 'ball') this.settleActuator(v);
    }

    // --- GN2 GSE ---------------------------------------------------------------
    const bottles = this.handOpen('HV-GN2-BOTTLES');
    const regSet = this.regs['GND-GN2-REG'].psi;
    const regOut = bottles ? Math.min(regSet, s.supplyP) : Math.min(regSet, s.regP);
    s.regP += (regOut - s.regP) * relax(4);

    if (open('gndGn2Press')) {
      const push = Math.max(0, s.regP - s.gn2FillP);
      s.gn2FillP += Math.min(push, tune.regFlowGn2 * dt * clamp(push / 200, 0.05, 1));
    }
    if (open('gndGn2Vent')) s.gn2FillP -= (s.gn2FillP - AMBIENT_PSI) * tune.fillLineVent * dt;

    // Through the QD and the vehicle's check valve, only ever toward the bus.
    const gn2Mated = !open('gn2QdRelease');
    if (gn2Mated && s.gn2FillP > s.busP) {
      const d = (s.gn2FillP - s.busP) * tune.busFill * dt;
      s.busP += d;
      s.gn2FillP -= d * 0.5;
      if (bottles) s.supplyP = Math.max(AMBIENT_PSI, s.supplyP - d * tune.supplyDrain);
    }
    s.gn2FillP = Math.max(AMBIENT_PSI, s.gn2FillP);

    // --- Vehicle GN2 bus ------------------------------------------------------
    if (open('gn2Vent')) s.busP -= (s.busP - AMBIENT_PSI) * tune.busVent * dt;
    if (!s.burst && s.busP > tune.burstPsi) {
      s.burst = true;
      this.onEvent(`SIM: GN2 burst disk ruptured at ${s.busP.toFixed(0)} psi — the bus is venting`, 'error');
    }
    if (s.burst) s.busP -= (s.busP - AMBIENT_PSI) * 2 * dt;
    s.busP -= (s.busP - AMBIENT_PSI) * 0.0005 * dt;

    // --- Tank pressurization -----------------------------------------------------
    for (const side of ['ox', 'fuel']) {
      const key = side === 'ox' ? 'oxP' : 'fuelP';
      if (!open(side === 'ox' ? 'oxPress' : 'fuelPress')) continue;
      const d = tune.pressFlow * Math.max(0, s.busP - s[key]) * dt;
      s[key] += d;
      s.busP = Math.max(AMBIENT_PSI, s.busP - d * tune.pressBusDrain);
    }

    if (open('oxVent')) s.oxP -= (s.oxP - AMBIENT_PSI) * tune.ventGain * dt;
    if (open('fuelVent')) s.fuelP -= (s.fuelP - AMBIENT_PSI) * tune.ventGain * dt;
    s.oxP -= (s.oxP - AMBIENT_PSI) * tune.tankLeak * dt;
    s.fuelP -= (s.fuelP - AMBIENT_PSI) * tune.tankLeak * dt;
    if (!open('oxVent') && s.oxMass > 0.5) s.oxP += tune.boilOffPsiPerS * dt;
    s.oxP = relieve(s.oxP, tune.tankRelief, dt);
    s.fuelP = relieve(s.fuelP, tune.tankRelief, dt);

    // --- LOX fill ---------------------------------------------------------------
    const loxMated = !open('loxQdRelease');
    const dewarFeeding = this.handOpen('HV-LOX-DEWAR') && open('gndLoxFill');
    if (dewarFeeding) {
      // An open ground vent dumps most of what the dewar pushes.
      const head = open('gndLoxVent') ? AMBIENT_PSI + (tune.dewarPsi - AMBIENT_PSI) * 0.3 : tune.dewarPsi;
      s.loxLineP += (head - s.loxLineP) * relax(3);
    } else if (open('gndLoxVent')) {
      s.loxLineP += (AMBIENT_PSI - s.loxLineP) * relax(2);
    } else {
      s.loxLineP += (AMBIENT_PSI - s.loxLineP) * relax(0.02);
    }
    if (dewarFeeding && loxMated && s.oxMass < tune.oxMassFull) {
      const push = clamp((s.loxLineP - s.oxP) / (tune.dewarPsi - AMBIENT_PSI), 0, 1);
      const rate = tune.loxFillRate * push;
      s.oxMass = Math.min(tune.oxMassFull, s.oxMass + rate * dt);
      if (!open('oxVent')) s.oxP += rate * tune.loxSqueeze * dt;
    }

    // --- Fuel storage and fill ----------------------------------------------------
    if (this.handOpen('HV-FUEL-PRESS') && s.storageP < s.muscleP) {
      const d = (s.muscleP - s.storageP) * tune.storagePressGain * dt;
      s.storageP += d;
      s.muscleP -= d * 0.1;
    }
    if (this.handOpen('HV-FUEL-VENT')) s.storageP -= (s.storageP - AMBIENT_PSI) * tune.storageVentGain * dt;
    s.storageP = Math.max(AMBIENT_PSI, s.storageP);
    for (const id of ['HV-FUEL-FILL', 'HV-WATER-FILL']) {
      if (this.handOpen(id)) s.storageMass = Math.min(tune.storageMassFull, s.storageMass + tune.storageRefill * dt);
    }

    const storageFeeding = this.handOpen('HV-FUEL-QD-FILL') && s.storageMass > 0.1;
    s.fuelLineP += ((storageFeeding ? s.storageP : AMBIENT_PSI) - s.fuelLineP) * relax(storageFeeding ? 5 : 0.05);
    // The fill enters the fuel line below the tank, so it pushes against the
    // ullage plus the head of whatever is already loaded.
    const fuelBottom = s.fuelP + this.head('fuel');
    if (open('fuelFill') && storageFeeding && s.fuelMass < tune.fuelMassFull) {
      const rate = tune.fuelFillRate * clamp((s.fuelLineP - fuelBottom) / 30, 0, 1);
      s.fuelMass = Math.min(tune.fuelMassFull, s.fuelMass + rate * dt);
      s.storageMass = Math.max(0, s.storageMass - rate * dt);
      if (!open('fuelVent')) s.fuelP += rate * 0.9 * dt;
    }

    // --- Engine -------------------------------------------------------------------
    const oxBottom = s.oxP + this.head('ox');
    const oxFlow = open('oxMain') && s.oxMass > 0.05;
    const fuelFlow = open('fuelMain') && s.fuelMass > 0.05;
    s.mdotO = oxFlow ? Math.sqrt(Math.max(0, oxBottom - s.chamberP) / tune.oxR) : 0;
    s.mdotF = fuelFlow ? Math.sqrt(Math.max(0, s.fuelP + this.head('fuel') - s.chamberP) / tune.fuelR) : 0;
    s.oxMass = Math.max(0, s.oxMass - s.mdotO * dt);
    s.fuelMass = Math.max(0, s.fuelMass - s.mdotF * dt);
    if (s.mdotO > 0) s.oxP -= s.mdotO * 2.2 * dt;
    if (s.mdotF > 0) s.fuelP -= s.mdotF * 2.4 * dt;

    if (s.mdotO > 0.2 && s.mdotF > 0.2) {
      s.bothFlowingFor += dt;
      if (s.bothFlowingFor >= tune.ignitionDelayS) s.burning = true;
      s.flameoutFor = 0;
    } else {
      s.bothFlowingFor = 0;
      s.flameoutFor += dt;
      if (s.flameoutFor > tune.flameoutGraceS) s.burning = false;
    }
    const mdot = s.mdotO + s.mdotF;
    const targetPc = AMBIENT_PSI + mdot * (s.burning ? tune.pcPerMdot : tune.coldPcPerMdot);
    s.chamberP += (targetPc - s.chamberP) * relax(14);

    const injector = (current, mdotSide, k) => mdotSide > 0
      ? current + (s.chamberP + k * mdotSide * mdotSide - current) * relax(10)
      : current + (s.chamberP - current) * relax(0.7);
    s.oxInjP = injector(s.oxInjP, s.mdotO, tune.oxInjK);
    s.fuelInjP = injector(s.fuelInjP, s.mdotF, tune.fuelInjK);

    s.oxP = Math.max(AMBIENT_PSI, s.oxP);
    s.fuelP = Math.max(AMBIENT_PSI, s.fuelP);
    s.chamberP = Math.max(AMBIENT_PSI, s.chamberP);
  }

  head(side) {
    const mass = side === 'ox' ? this.s.oxMass : this.s.fuelMass;
    const full = side === 'ox' ? tune.oxMassFull : tune.fuelMassFull;
    const rho = side === 'ox' ? tune.loxDensity : tune.fuelDensity;
    return (rho * tune.tankHeightIn * clamp(mass / full, 0, 1)) / 1728;
  }

  sample() {
    const s = this.s;
    const out = {};
    const put = (role, value, sigma) => {
      const id = this.roles.sensors[role];
      if (id) out[id] = value + gauss() * sigma;
    };

    put('busP', s.busP, noise.gn2);
    put('gn2BottleP', this.handOpen('HV-GN2-BOTTLES') ? s.supplyP : s.regP, noise.gn2);
    put('gn2RegP', s.regP, noise.gn2);
    put('gn2FillP', s.gn2FillP, noise.pt);
    put('oxTankP', s.oxP, noise.pt);
    put('fuelTankP', s.fuelP, noise.pt);
    put('actuatorP', s.actP, noise.pt);
    put('oxEngineP', s.oxInjP, s.mdotO > 0 ? noise.injector : noise.pt);
    put('fuelEngineP', s.fuelInjP, s.mdotF > 0 ? noise.injector : noise.pt);
    put('muscleP', s.muscleP, noise.pt);
    put('loxFillP', s.loxLineP, noise.pt);
    put('fuelFillP', s.fuelLineP, noise.pt);

    return this.finishSample(out);
  }
}
