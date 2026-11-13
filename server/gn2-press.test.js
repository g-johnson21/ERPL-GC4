/**
 * Tests for the software GN2 bang-bang loop.
 *
 *   node --test server/gn2-press.test.js
 *
 * What matters: the loop pulses only its own solenoid, on the band; the PT is
 * switchable while ARMED; and the OVERPRESSURE CLOSE shuts both GN2 valves
 * whatever else is going on — loop on or off, hand-opened valves included —
 * and holds them shut while the PT stays over it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Gn2Press } from './gn2-press.js';

function gn2Stand({ armed = true, p = 100, alt = 100 } = {}) {
  const valves = {
    'GN2-BB-PRESS': { id: 'GN2-BB-PRESS', name: 'GN2 Bang-Bang Press', safeState: 'closed' },
    'GND-GN2-PRESS': { id: 'GND-GN2-PRESS', name: 'Ground GN2 Press', safeState: 'closed' },
    'GN2-VENT': { id: 'GN2-VENT', name: 'GN2 Vent', safeState: 'open' },
  };
  const wire = [];
  const stand = {
    armed,
    abortState: { active: false },
    readings: { 'GN2-BUS-PT': p, 'GN2-FILL-PT': alt, TC1: 70 },
    valveStates: { 'GN2-BB-PRESS': 'closed', 'GND-GN2-PRESS': 'closed', 'GN2-VENT': 'closed' },
    config: {
      sensors: [{ id: 'GN2-BUS-PT' }, { id: 'GN2-FILL-PT', kind: 'pressure' }, { id: 'TC1', kind: 'temperature' }],
      gn2Press: {
        name: 'GN2 COPV Press', valve: 'GN2-BB-PRESS', isolationValve: 'GND-GN2-PRESS', sensor: 'GN2-BUS-PT',
        setpoint: 1000, deadband: 25, setpointMin: 0, setpointMax: 4500, deadbandMin: 5, deadbandMax: 250,
        maxOpenMs: 1000, minIntervalMs: 500, overpressure: 4600, requiresArm: true,
      },
    },
    configStore: { valve: (id) => valves[id] ?? null },
    sequencer: { ownsValve: () => false },
    logs: [],
    // The handCommand hook, as state.js wires it, so tests can exercise a
    // hand command through the same path.
    commandValve(id, state, opts = {}) {
      if (!opts.internal) {
        const hand = this.gn2Press.handCommand(id, state, opts.source);
        if (!hand.ok) return hand;
        if (state === 'open' && !this.armed) return { ok: false, error: 'requires ARM' };
      }
      wire.push(`${id}=${state}`);
      this.valveStates[id] = state;
      return { ok: true };
    },
    log(level, message) { this.logs.push(`${level}: ${message}`); },
    emit() {}, snapshot() { return {}; },
  };
  stand.gn2Press = new Gn2Press(stand);
  return { stand, loop: stand.gn2Press, wire };
}

test('pulses its own solenoid on the band, and nothing else', () => {
  const { stand, loop, wire } = gn2Stand({ p: 900 });
  assert.equal(loop.set({ enabled: true }).ok, true);
  loop.update(stand.readings, 0);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'open', 'below the band: open');

  stand.readings['GN2-BUS-PT'] = 1010;
  loop.update(stand.readings, 100);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'open', 'inside the band: no change');

  stand.readings['GN2-BUS-PT'] = 1025;
  loop.update(stand.readings, 200);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'closed', 'top of the band: closed');

  stand.readings['GN2-BUS-PT'] = 980;
  loop.update(stand.readings, 300);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'closed', 'inside the band again: stays closed');

  stand.readings['GN2-BUS-PT'] = 970;
  loop.update(stand.readings, 600);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'closed', 'below the band but inside the dwell');
  loop.update(stand.readings, 700);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'open', 'dwell over: reopens');
  assert.ok(wire.every((w) => w.startsWith('GN2-BB-PRESS=')), wire.join(', '));
});

test('after a pulse-cap close it reopens only below the bottom of the band', () => {
  // Setpoint 1000 ±25: band 975..1025.
  const { stand, loop } = gn2Stand({ p: 990 });
  loop.set({ enabled: true });
  loop.update(stand.readings, 0);
  assert.ok(!loop.isOpen(), 'inside the band: does not start a fill');

  stand.readings['GN2-BUS-PT'] = 900;
  loop.update(stand.readings, 0);
  assert.ok(loop.isOpen());
  stand.readings['GN2-BUS-PT'] = 990;   // in the band, short of its top
  loop.update(stand.readings, 1000);
  assert.ok(!loop.isOpen(), 'closed on the 1000 ms cap');
  for (const [t, p] of [[1500, 990], [3000, 1010], [4000, 976], [5000, 975]]) {
    stand.readings['GN2-BUS-PT'] = p;
    loop.update(stand.readings, t);
    assert.ok(!loop.isOpen(), `${p} psi is not below the bottom of the band: stays closed`);
  }
  stand.readings['GN2-BUS-PT'] = 974;
  loop.update(stand.readings, 6000);
  assert.ok(loop.isOpen(), 'below the bottom of the band: reopens');
});

test('a capped pulse below the band reopens after the dwell', () => {
  const { stand, loop } = gn2Stand({ p: 900 });
  loop.set({ enabled: true });
  loop.update(stand.readings, 0);
  assert.ok(loop.isOpen());
  stand.readings['GN2-BUS-PT'] = 950;   // still below the band when the cap lands
  loop.update(stand.readings, 1000);
  assert.ok(!loop.isOpen(), 'closed on the cap');
  loop.update(stand.readings, 1499);
  assert.ok(!loop.isOpen(), 'dwell');
  loop.update(stand.readings, 1500);
  assert.ok(loop.isOpen(), 'still below the band: next pulse');
});

test('the PT can be switched while ARMED and running, and the loop follows it', () => {
  const { stand, loop } = gn2Stand({ p: 900, alt: 1100 });
  loop.set({ enabled: true });
  loop.update(stand.readings, 0);
  assert.ok(loop.isOpen());

  const res = loop.set({ sensor: 'GN2-FILL-PT' });
  assert.equal(res.ok, true);
  assert.equal(loop.settings.sensor, 'GN2-FILL-PT');
  assert.ok(!loop.isOpen(), 'a pulse started on the old PT is not finished on the new one');
  assert.ok(stand.logs.some((l) => l.includes('GN2 PRESS PT -> GN2-FILL-PT')));
  loop.update(stand.readings, 1000);
  assert.ok(!loop.isOpen(), 'GN2-FILL-PT reads over the band');
  assert.equal(loop.enabled, true);

  assert.equal(loop.set({ sensor: 'TC1' }).ok, false, 'not a pressure channel');
  assert.equal(loop.set({ sensor: 'NOPE' }).ok, false);
  stand.readings['GN2-FILL-PT'] = undefined;
  assert.equal(loop.set({ sensor: 'GN2-BUS-PT' }).ok, true);
  stand.readings['GN2-BUS-PT'] = undefined;
  assert.equal(loop.set({ sensor: 'GN2-FILL-PT' }).ok, false, 'no reading on the new PT');
});

test('OVERPRESSURE closes both GN2 valves and turns the loop off', () => {
  const { stand, loop } = gn2Stand({ p: 900 });
  stand.valveStates['GND-GN2-PRESS'] = 'open';
  loop.set({ enabled: true });
  loop.update(stand.readings, 0);
  assert.ok(loop.isOpen());

  stand.readings['GN2-BUS-PT'] = 4600;
  loop.update(stand.readings, 100);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'closed');
  assert.equal(stand.valveStates['GND-GN2-PRESS'], 'closed');
  assert.equal(loop.enabled, false);
  assert.match(loop.fault, /OVERPRESSURE/);
  assert.equal(loop.trip.value, 4600);
});

test('OVERPRESSURE closes hand-opened valves with the loop OFF, and holds them shut', () => {
  const { stand, loop } = gn2Stand({ p: 4700 });
  stand.valveStates['GN2-BB-PRESS'] = 'open';
  stand.valveStates['GND-GN2-PRESS'] = 'open';
  loop.update(stand.readings, 0);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'closed');
  assert.equal(stand.valveStates['GND-GN2-PRESS'], 'closed');

  assert.equal(stand.commandValve('GND-GN2-PRESS', 'open').ok, false, 'no reopening by hand while over');
  assert.equal(stand.commandValve('GN2-BB-PRESS', 'open').ok, false);
  assert.equal(stand.commandValve('GN2-VENT', 'open').ok, true, 'venting is never held');
  assert.equal(loop.set({ enabled: true }).ok, false, 'nor the loop');

  stand.readings['GN2-BUS-PT'] = 4000;
  assert.equal(stand.commandValve('GND-GN2-PRESS', 'open').ok, true, 'free again once vented down');
});

test('the overpressure close reads the SELECTED PT', () => {
  const { stand, loop } = gn2Stand({ p: 900, alt: 4650 });
  stand.valveStates['GND-GN2-PRESS'] = 'open';
  loop.update(stand.readings, 0);
  assert.equal(stand.valveStates['GND-GN2-PRESS'], 'open', 'GN2-FILL-PT is not selected');
  stand.readings['GN2-FILL-PT'] = 4000;
  loop.set({ sensor: 'GN2-FILL-PT' });
  stand.readings['GN2-FILL-PT'] = 4650;
  loop.update(stand.readings, 100);
  assert.equal(stand.valveStates['GND-GN2-PRESS'], 'closed');
});

test('the overpressure close must sit above the band, and is retunable while ARMED', () => {
  const { loop } = gn2Stand();
  assert.equal(loop.set({ overpressure: 1025 }).ok, false, 'at the top of the band');
  assert.equal(loop.set({ setpoint: 4590 }).ok, false, 'a setpoint whose band reaches it');
  assert.equal(loop.set({ overpressure: 3000 }).ok, true);
  assert.equal(loop.settings.overpressure, 3000);
  assert.equal(loop.set({ setpoint: 4600 }).ok, false, 'over setpointMax');
  assert.equal(loop.set({ maxOpenMs: -1 }).ok, false);
});

test('off on disarm, abort and a lost PT — and a hand close turns it off', () => {
  for (const kill of [
    (s) => { s.armed = false; },
    (s) => { s.abortState.active = true; },
    (s) => { s.readings['GN2-BUS-PT'] = null; },
  ]) {
    const { stand, loop } = gn2Stand({ p: 900 });
    loop.set({ enabled: true });
    loop.update(stand.readings, 0);
    kill(stand);
    loop.update(stand.readings, 20);
    assert.equal(loop.enabled, false);
    assert.equal(stand.valveStates['GN2-BB-PRESS'], 'closed');
  }

  const { stand, loop } = gn2Stand({ p: 900 });
  loop.set({ enabled: true });
  loop.update(stand.readings, 0);
  assert.equal(stand.commandValve('GN2-BB-PRESS', 'open').ok, false, 'two drivers on one solenoid');
  assert.equal(stand.commandValve('GN2-BB-PRESS', 'closed').ok, true);
  assert.equal(loop.enabled, false);
});

test('refuses to start disarmed, blind, or over the limit', () => {
  assert.equal(gn2Stand({ armed: false }).loop.set({ enabled: true }).ok, false);
  assert.equal(gn2Stand({ p: null }).loop.set({ enabled: true }).ok, false);
  assert.equal(gn2Stand({ p: 4600 }).loop.set({ enabled: true }).ok, false);
});

test('regulates to the band over a simple fill', () => {
  const { stand, loop } = gn2Stand({ p: 15 });
  loop.set({ setpoint: 2000, deadband: 50, enabled: true });
  // A crude bus: +600 psi/s while open, a slow leak while shut.
  for (let t = 0; t < 30000; t += 20) {
    const p = stand.readings['GN2-BUS-PT'];
    stand.readings['GN2-BUS-PT'] = p + (loop.isOpen() ? 12 : -0.02);
    loop.update(stand.readings, t);
  }
  const p = stand.readings['GN2-BUS-PT'];
  assert.ok(p > 1950 && p < 2065, `held in the band, read ${p}`);
});
