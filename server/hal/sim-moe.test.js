/**
 * Tests for the MOE simulator model.
 *
 *   node --test server/hal/sim-moe.test.js
 *
 * Run against the REAL config/moe.json, like the Draco tests run against
 * stand.json, so a valve or transducer renamed in the config that the model
 * still keys on fails here instead of reading ambient forever on screen.
 * What is asserted is the plumbing -- which valve moves which pressure, what
 * a QD release or a dead actuator bus stops -- not the tuned numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MoeSimulatorDriver } from './sim-moe.js';
import { createDriver } from './index.js';
import { validateConfig } from '../config-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'config', 'moe.json'), 'utf8'));
const valveById = new Map(config.valves.map((v) => [v.id, v]));

async function vehicle() {
  let t = 1_000_000;
  const events = [];
  const sim = new MoeSimulatorDriver({ now: () => t, onEvent: (m, level) => events.push({ m, level }) });
  await sim.init(config);
  let last = sim.read();
  const api = {
    sim,
    events,
    run(seconds) {
      const ticks = Math.round(seconds / 0.02);
      for (let i = 0; i < ticks; i++) { t += 20; last = sim.read(); }
      return last;
    },
    set(id, state) {
      assert.ok(valveById.has(id), `config/moe.json has no valve ${id}`);
      sim.setValve(valveById.get(id), state);
    },
    hand(id, state) { assert.equal(sim.simSetManual(id, state).ok, true, `hand valve ${id}`); },
    read: () => last,
    state: (id) => sim.valveState.get(id),

    /** Charge the vehicle's GN2 bus from the ground to the regulator's set pressure. */
    fillGn2(seconds = 40) {
      api.set('GN2-VENT', 'closed');
      api.set('GND-GN2-VENT', 'closed');
      api.set('GND-GN2-PRESS', 'open');
      api.run(seconds);
      api.set('GND-GN2-PRESS', 'closed');
      api.set('GND-GN2-VENT', 'open');
      api.run(2);
    },
    fillLox(seconds = 40) {
      api.set('GND-LOX-VENT', 'closed');
      api.set('GND-LOX-FILL', 'open');
      api.run(seconds);
      api.set('GND-LOX-FILL', 'closed');
      api.set('GND-LOX-VENT', 'open');
    },
    fillFuel(seconds = 40) {
      api.hand('HV-FUEL-PRESS', 'open');
      api.run(5);
      api.hand('HV-FUEL-QD-FILL', 'open');
      api.set('FUEL-FILL', 'open');
      api.run(seconds);
      api.set('FUEL-FILL', 'closed');
      api.hand('HV-FUEL-QD-FILL', 'closed');
    },
    pressurize(side, psi) {
      const vent = side === 'ox' ? 'LOX-VENT' : 'FUEL-VENT';
      const press = side === 'ox' ? 'LOX-PRESS' : 'FUEL-PRESS';
      const pt = side === 'ox' ? 'LOX-TANK-PT' : 'FUEL-TANK-PT';
      api.set(vent, 'closed');
      api.set(press, 'open');
      for (let i = 0; i < 3000 && api.run(0.1)[pt] < psi; i++) { /* pulse */ }
      api.set(press, 'closed');
      api.run(1);
    },
  };
  return api;
}

test('config/moe.json is a valid stand config', () => {
  assert.deepEqual(validateConfig(config), []);
});

test('meta.simModel selects the MOE model, and an unknown model is refused', () => {
  assert.ok(createDriver('simulator', { simModel: 'moe' }) instanceof MoeSimulatorDriver);
  assert.ok(!(createDriver('simulator', {}) instanceof MoeSimulatorDriver), 'no simModel is still Draco');
  assert.throws(() => createDriver('simulator', { simModel: 'nope' }), /Unknown simulator model/);
});

test('one stand\'s wiring file is refused for the other stand', () => {
  const root = path.join(here, '..', '..');
  assert.throws(
    () => createDriver('stand', { root, hardwareConfig: 'config/hardware.json', standName: 'MOE' }),
    /is for "Draco", but the stand config is "MOE"/,
  );
  assert.throws(
    () => createDriver('stand', { root, hardwareConfig: 'config/hardware-moe.json', standName: 'Draco' }),
    /is for "MOE", but the stand config is "Draco"/,
  );
});

test('config/hardware-moe.json names only sensors and valves that moe.json has', () => {
  const hw = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'config', 'hardware-moe.json'), 'utf8'));
  const sensorIds = new Set(config.sensors.map((s) => s.id));
  for (const [key, id] of Object.entries(hw.nidaq.channelMap)) {
    assert.ok(sensorIds.has(id), `${key} -> ${id} is not a sensor in moe.json`);
  }
  for (const meta of Object.values(hw.panda.dcChannels)) {
    const v = valveById.get(meta.valve);
    assert.ok(v, `${meta.id} -> ${meta.valve} is not a valve in moe.json`);
    assert.equal(meta.id, `DC${v.channel}`, `${meta.valve} is on channel ${v.channel}, not ${meta.id}`);
  }
});

test('every configured sensor reads a finite number from the model', async () => {
  const s = await vehicle();
  const sample = s.read();
  for (const sensor of config.sensors) {
    assert.ok(Number.isFinite(sample[sensor.id]), `${sensor.id} should read`);
  }
  // Every sensor is one the model actually drives, not the spare-channel filler.
  for (const id of Object.values(s.sim.roles.sensors)) {
    assert.ok(config.sensors.some((x) => x.id === id), `model role sensor ${id} exists in moe.json`);
  }
  for (const id of Object.values(s.sim.roles.valves)) {
    assert.ok(valveById.has(id), `model role valve ${id} exists in moe.json`);
  }
});

test('the vehicle starts empty and vented, the ground starts charged', async () => {
  const s = await vehicle();
  const r = s.run(2);
  assert.ok(r['GN2-BUS-PT'] < 30, `COPVs empty, read ${r['GN2-BUS-PT']}`);
  assert.ok(r['LOX-TANK-PT'] < 25 && r['FUEL-TANK-PT'] < 25, 'tanks at ambient');
  assert.ok(r['GN2-BOTTLE-PT'] > 5000, 'supply bottles full');
  assert.ok(Math.abs(r['GN2-REG-PT'] - 4000) < 50, `ground regulator at set, read ${r['GN2-REG-PT']}`);
  assert.ok(r['GSE-MUSCLE-PT'] > 100, 'GSE muscle charged');
});

test('GN2 fills the vehicle bus through the QD, and not while the QD is released', async () => {
  const s = await vehicle();
  s.set('GN2-QD-CTRL', 'open');
  s.fillGn2(20);
  assert.ok(s.read()['GN2-BUS-PT'] < 30, 'a released QD passes nothing');

  s.set('GN2-QD-CTRL', 'closed');
  s.fillGn2();
  const bus = s.read()['GN2-BUS-PT'];
  assert.ok(bus > 3500 && bus < 4100, `bus charged toward the 4000 psi regulator, read ${bus}`);
  assert.ok(s.read()['GN2-FILL-PT'] < 100, 'ground vent bled the fill line afterwards');

  // The check valve holds the bus once the fill line is vented.
  s.run(10);
  assert.ok(s.read()['GN2-BUS-PT'] > bus - 50, 'bus does not flow back out through the fill line');

  // GN2 VENT is normally open: de-energize it and the bus blows down.
  s.set('GN2-VENT', 'open');
  assert.ok(s.run(20)['GN2-BUS-PT'] < 100, 'GN2 VENT blows the bus down');
});

test('LOX fills from the dewar only with the tank vented and the ground vent shut', async () => {
  const s = await vehicle();
  s.set('LOX-VENT', 'closed');
  s.fillLox(20);
  const sealedMass = s.sim.s.oxMass;
  assert.ok(sealedMass < 20, `a sealed tank stalls at dewar head, took ${sealedMass.toFixed(1)} lbm`);

  s.set('LOX-VENT', 'open');
  s.run(10);
  s.fillLox(40);
  assert.ok(s.sim.s.oxMass > 55, `vented tank fills, holds ${s.sim.s.oxMass.toFixed(1)} lbm`);
  assert.ok(s.run(5)['LOX-FILL-PT'] < 25, 'ground vent dumps the fill line after');
});

test('fuel fills from storage through the QD and the fill solenoid', async () => {
  const s = await vehicle();
  s.fillFuel(10);
  assert.ok(s.sim.s.fuelMass > 10, `fuel loaded, ${s.sim.s.fuelMass.toFixed(1)} lbm`);
  assert.ok(s.read()['FUEL-FILL-PT'] > 50, `fill line pressurized by shop air, read ${s.read()['FUEL-FILL-PT']}`);
});

test('the main valves cannot open until the LOX tank feeds the actuator bus', async () => {
  const s = await vehicle();
  s.set('MOV', 'open');
  s.run(1);
  assert.equal(s.state('MOV'), 'closed', 'no actuator pressure: MOV held shut by its spring');
  assert.ok(s.events.some((e) => /MOV did not move: actuator bus/.test(e.m)), 'and the log says why');

  s.fillGn2();
  s.pressurize('ox', 300);
  s.run(3);
  const act = s.read()['ACTUATOR-PT'];
  assert.ok(act > 120 && act < 160, `actuator bus regulated to ~150 psi, read ${act}`);
  assert.equal(s.state('MOV'), 'open', 'MOV followed its coil once the bus came up');
});

test('GROUND valves stroke on the GSE muscle, and fall to their springs without it', async () => {
  const s = await vehicle();
  s.set('GND-LOX-FILL', 'open');
  s.run(0.5);
  assert.equal(s.state('GND-LOX-FILL'), 'open');

  s.set('GND-PNEU-VENT', 'open');
  s.run(15);
  assert.ok(s.read()['GSE-MUSCLE-PT'] < 50, 'pneumatics vent blew the muscle down');
  assert.equal(s.state('GND-LOX-FILL'), 'closed', 'normally-closed fill fell shut');
  assert.equal(s.state('GND-LOX-VENT'), 'open', 'normally-open vent stayed open');
});

test('a hot fire lights near the design point', async () => {
  const s = await vehicle();
  s.fillGn2();
  s.fillLox();
  s.fillFuel();
  s.pressurize('ox', 700);
  s.pressurize('fuel', 700);

  s.set('MOV', 'open');
  s.set('MFV', 'open');
  // Hold the tanks up the way the bang-bang loop would.
  for (let i = 0; i < 20; i++) {
    const r = s.run(0.1);
    s.set('LOX-PRESS', r['LOX-TANK-PT'] < 690 ? 'open' : 'closed');
    s.set('FUEL-PRESS', r['FUEL-TANK-PT'] < 690 ? 'open' : 'closed');
  }
  assert.equal(s.sim.s.burning, true, 'engine lit');
  const pc = s.sim.s.chamberP;
  assert.ok(pc > 380 && pc < 600, `chamber near 500 psi, ${pc.toFixed(0)}`);
  const inj = s.read()['LOX-ENGINE-PT'];
  assert.ok(inj > pc, `injector ${inj.toFixed(0)} above chamber ${pc.toFixed(0)}`);

  s.set('MOV', 'closed');
  s.set('MFV', 'closed');
  s.run(2);
  assert.equal(s.sim.s.burning, false, 'cutoff');
});
