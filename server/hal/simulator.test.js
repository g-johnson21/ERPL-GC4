/**
 * Tests for the Draco stand simulator.
 *
 *   node --test server/hal/simulator.test.js
 *
 * These run the model against the REAL config/stand.json, so a tag renamed
 * on the P&ID that the model still keys on fails here rather than reading
 * ambient forever on screen. What is asserted is the plumbing -- which
 * valve moves which pressure, which check valve stops what -- not the
 * numbers, which are tuned for plausibility and free to change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulatorDriver } from './simulator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'config', 'stand.json'), 'utf8'));
const valveById = new Map(config.valves.map((v) => [v.id, v]));

/** A simulator with a clock the test drives, plus a transcript of its events. */
async function stand() {
  let t = 1_000_000;
  const events = [];
  const sim = new SimulatorDriver({ now: () => t, onEvent: (m, level) => events.push({ m, level }) });
  await sim.init(config);
  let last = sim.read();
  const api = {
    sim,
    events,
    /** Advance `seconds` in 20 ms ticks, like the 50 Hz control loop. */
    run(seconds) {
      const ticks = Math.round(seconds / 0.02);
      for (let i = 0; i < ticks; i++) { t += 20; last = sim.read(); }
      return last;
    },
    /** Command a valve as the controller would. */
    set(id, state) { sim.setValve(valveById.get(id), state); },
    read: () => last,
    /** Fill the LOX tank from the dewar with the vent open. */
    fillLox(seconds = 30) { api.set('SV-LOX-FILL', 'open'); api.run(seconds); api.set('SV-LOX-FILL', 'closed'); },
    /** Seal a tank and pulse its press solenoid until it reaches `psi`. */
    pressurize(side, psi) {
      const vent = side === 'ox' ? 'SV-LOXV' : 'SV-FV';
      const press = side === 'ox' ? 'SV-LOXBB' : 'SV-FBB';
      const pt = side === 'ox' ? 'PT4' : 'PT14';
      api.set(vent, 'closed');
      api.set(press, 'open');
      for (let i = 0; i < 3000 && api.run(0.1)[pt] < psi; i++) { /* pulse */ }
      api.set(press, 'closed');
      api.run(1);
    },
  };
  return api;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stddev = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

test('every configured sensor reads a finite number from the model', async () => {
  const s = await stand();
  const sample = s.read();
  for (const sensor of config.sensors) {
    assert.ok(Number.isFinite(sample[sensor.id]), `${sensor.id} should read`);
  }
});

test('the stand starts safe: tanks vented, LOX empty, muscle bus charged, purge bus dead', async () => {
  const s = await stand();
  const r = s.run(2);
  assert.ok(r.PT4 < 25, `LOX tank at ambient, read ${r.PT4}`);
  assert.ok(r.PT14 < 25, `fuel tank at ambient, read ${r.PT14}`);
  assert.ok(r.LC4 < 90, `LOX tank empty, weight ${r.LC4}`);
  assert.ok(r.PT31 > 100, `muscle bus charged, read ${r.PT31}`);
  assert.ok(r.PT32 < 25, `purge bus has no supply until the fuel leg is pressurized, read ${r.PT32}`);
  assert.ok(r.PT1 > 5000 && r.PT11 > 5000, 'both bottle banks are full');
});

test('PB5 fills the LOX tank from the dewar only while the tank is vented', async () => {
  const s = await stand();
  s.fillLox(20);
  const filled = s.read();
  assert.ok(filled.LC4 > 120, `tank weight rose, read ${filled.LC4}`);
  assert.ok(filled.TC1 < -200, `tank bottom went cold, read ${filled.TC1}`);
  assert.ok(filled.TC3 < -150, `outlet line went cold, read ${filled.TC3}`);
  // Head: the bottom transducer reads above the (vented) ullage.
  assert.ok(filled.PT4 - filled.PT2 > 1, 'hydrostatic head separates PT4 from the ullage');

  // A pressurized tank cannot be filled against the dewar.
  s.pressurize('ox', 200);
  const before = s.read().LC4;
  s.fillLox(10);
  assert.ok(Math.abs(s.read().LC4 - before) < 2, 'no fill against a pressurized tank');
});

test('S1 pressurizes the LOX tank; PT2 rides above it with S1 open and settles to it after', async () => {
  const s = await stand();
  s.fillLox(15);
  s.set('SV-LOXV', 'closed');
  s.set('SV-LOXBB', 'open');
  const during = s.run(3);
  assert.ok(during.PT4 > 100, `tank came up, read ${during.PT4}`);
  assert.ok(during.PT2 > during.PT4 + 20, `PT2 above the tank while pushing: ${during.PT2} vs ${during.PT4}`);
  assert.ok(during.PT1 < 6000, 'the bottle bank is being drawn down');

  s.set('SV-LOXBB', 'closed');
  const after = s.run(4);
  assert.ok(Math.abs(after.PT2 - after.PT4) < 8, `PT2 bled to tank pressure through C1: ${after.PT2} vs ${after.PT4}`);

  s.set('SV-LOXV', 'open');
  const vented = s.run(15);
  assert.ok(vented.PT4 < 40, `PB1 vents the tank, read ${vented.PT4}`);
});

test('RV2 holds the LOX tank at its set pressure however long S1 stays open', async () => {
  const s = await stand();
  s.set('SV-LOXV', 'closed');
  s.set('SV-LOXBB', 'open');
  const r = s.run(60);
  assert.ok(r.PT4 > 1250 && r.PT4 < 1320, `relieved at 1300, read ${r.PT4}`);
});

test('the purge bus is regulated off the fuel leg, and R1, B6 and S4 all show on PT32', async () => {
  const s = await stand();
  s.pressurize('fuel', 450);
  const bus = s.run(3);
  assert.ok(Math.abs(bus.PT32 - 200) < 6, `R1 holds its 200 psi default, read ${bus.PT32}`);

  const set = s.sim.simSetRegulator('R1', 120);
  assert.equal(set.ok, true);
  const bled = s.run(20);
  assert.ok(bled.PT32 < 130, `bus came down toward the new setting, read ${bled.PT32}`);

  s.sim.simSetManual('B6', 'open');
  const vented = s.run(4);
  assert.ok(vented.PT32 < bled.PT32 - 20, `B6 vents the bus, read ${vented.PT32}`);
  s.sim.simSetManual('B6', 'closed');
  s.sim.simSetRegulator('R1', 200);
  s.run(5);

  // Purge gas reaches the LOX manifold only through S4.
  const idle = s.read().PT5;
  s.set('SV-LOXPURGE', 'open');
  const purging = s.run(2);
  assert.ok(purging.PT5 > idle + 100, `S4 pressurizes the LOX manifold, ${idle} -> ${purging.PT5}`);
  assert.ok(purging.PT4 < 50, 'the check valves keep purge gas out of the run line');
});

test('a hot fire needs both propellants, lights on its own, and shuts down clean', async () => {
  const s = await stand();
  s.fillLox(30);
  s.pressurize('ox', 460);
  s.pressurize('fuel', 450);

  // Fuel alone is a cold flow: no ignition, no thrust.
  s.set('MV-F', 'open');
  const fuelOnly = s.run(2);
  assert.ok(fuelOnly.PT0 < 60, `no ignition on one propellant, chamber read ${fuelOnly.PT0}`);
  assert.ok(fuelOnly.PT24 < fuelOnly.PT23 - 100, 'the fuel venturi cavitates under flow');
  s.set('MV-F', 'closed');
  s.run(2);

  s.set('MV-LOX', 'open');
  s.run(0.5);
  s.set('MV-F', 'open');
  const burn = s.run(3);
  assert.ok(burn.PT0 > 150, `chamber pressure, read ${burn.PT0}`);
  assert.ok(burn.LC1 + burn.LC2 + burn.LC3 > 200, 'thrust on the three cells');
  assert.ok(burn.TC5 > 500, `chamber thermocouple, read ${burn.TC5}`);
  assert.ok(burn.PT5 > burn.PT0 && burn.PT5 < burn.PT4, 'the LOX manifold sits between chamber and tank');
  assert.ok(burn.PT22 < 40, 'the LOX venturi throat is at vapour pressure');

  s.set('MV-LOX', 'closed');
  s.set('MV-F', 'closed');
  const off = s.run(4);
  assert.ok(off.PT0 < 40, `chamber decayed after cutoff, read ${off.PT0}`);
  assert.ok(off.LC1 + off.LC2 + off.LC3 < 20, 'thrust gone');
  assert.ok(off.PT22 > 300, 'the throat reads line pressure once flow stops');
});

test('losing the muscle bus drops every pneumatic valve to its spring position, and they follow the coil back', async () => {
  const s = await stand();
  s.fillLox(15);
  s.set('SV-LOXV', 'closed');            // PB1: energized closed
  s.set('MV-LOX', 'open');               // PB2: energized open
  s.run(1);
  assert.equal(s.sim.valveState.get('SV-LOXV'), 'closed');
  assert.equal(s.sim.valveState.get('MV-LOX'), 'open');

  s.sim.simSetRegulator('AC-1', 0);      // compressor off
  s.set('SV-MBV', 'open');               // S3 blows the bus down
  const low = s.run(12);
  assert.ok(low.PT31 < 50, `muscle bus collapsed, read ${low.PT31}`);
  assert.equal(s.sim.valveState.get('SV-LOXV'), 'open', 'the NO vent fell open');
  assert.equal(s.sim.valveState.get('MV-LOX'), 'closed', 'the NC main fell closed');
  assert.ok(s.events.some((e) => e.level === 'warn' && /MV-LOX/.test(e.m)), 'the fall is logged');
  // The coils never changed, and the current sense says so.
  assert.equal(s.sim.dcStatus()['MV-LOX'].energized, true);

  // A fresh command with no muscle pressure is refused, loudly.
  s.set('SV-LOX-FILL', 'open');
  assert.equal(s.sim.valveState.get('SV-LOX-FILL'), 'closed');
  assert.ok(s.events.some((e) => /SV-LOX-FILL did not move/.test(e.m)));

  s.set('SV-MBV', 'closed');
  s.sim.simSetRegulator('AC-1', 120);
  const back = s.run(8);
  assert.ok(back.PT31 > 100, `bus recovered, read ${back.PT31}`);
  assert.equal(s.sim.valveState.get('MV-LOX'), 'open', 'the main followed its coil once it could');
  assert.equal(s.sim.valveState.get('SV-LOX-FILL'), 'open');
});

test('hand valves: B2 drains LOX, B4 drains fuel, B3 vents the fuel tank', async () => {
  const s = await stand();
  s.fillLox(20);
  const full = s.read().LC4;
  s.sim.simSetManual('B2', 'open');
  s.run(10);
  assert.ok(s.read().LC4 < full - 10, 'B2 drains the LOX tank');
  s.sim.simSetManual('B2', 'closed');

  s.pressurize('fuel', 300);
  s.sim.simSetManual('B3', 'open');
  const vented = s.run(15);
  assert.ok(vented.PT14 < 60, `B3 vents the fuel tank, read ${vented.PT14}`);
  s.sim.simSetManual('B3', 'closed');

  const head = s.read().PT14 - s.read().PT12;
  s.sim.simSetManual('B4', 'open');
  s.run(25);
  assert.ok(s.read().PT14 - s.read().PT12 < head - 0.5, 'B4 drains fuel and the head falls');

  const controls = s.sim.simControls();
  assert.deepEqual(Object.keys(controls.manual).sort(), ['B1', 'B2', 'B3', 'B4', 'B6']);
  assert.deepEqual(Object.keys(controls.regulators).sort(), ['AC-1', 'R1']);
  assert.equal(s.sim.simSetManual('B9', 'open').ok, false);
  assert.equal(s.sim.simSetRegulator('R1', 9999).psi, 300, 'clamped to the regulator range');
});

test('transducers are quiet: a settled tank holds to a few tenths of a psi', async () => {
  const s = await stand();
  s.fillLox(15);
  s.pressurize('ox', 300);
  s.set('SV-LOXBB', 'closed');
  s.run(2);
  const samples = [];
  for (let i = 0; i < 200; i++) samples.push(s.run(0.02).PT4);
  const sd = stddev(samples);
  assert.ok(sd < 0.5, `PT4 one-sigma should be under half a psi, got ${sd.toFixed(3)}`);
  const bottles = [];
  for (let i = 0; i < 200; i++) bottles.push(s.run(0.02).PT1);
  assert.ok(stddev(bottles) < 3, 'a 6000 psi bottle transducer stays within a few psi');
});

test('the emulated board reads the tank ullage with its own bias', async () => {
  const s = await stand();
  s.pressurize('ox', 250);
  s.run(1);
  const board = s.sim.bbStatus().l.pressure;
  const ullage = s.read().PT2;
  assert.ok(Number.isFinite(board), 'the board reports a pressure');
  assert.ok(Math.abs(board - ullage) < 10, `board PT tracks the ullage: ${board} vs ${ullage}`);
});
