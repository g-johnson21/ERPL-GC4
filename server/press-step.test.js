/**
 * Tests for the COPV Press Tool's step on the software GN2 loop.
 *
 *   node --test server/press-step.test.js
 *
 * The properties that matter: a step only ever moves the GN2 loop's setpoint
 * (the loop drives the solenoid), the SERVER ends it on target or timeout
 * whatever the browser does, a reached target leaves the loop holding, and
 * the loop's overpressure close ends a step like any other stop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PressStep, VENT_VALVE, MAX_STEP_MS } from './press-step.js';
import { Gn2Press } from './gn2-press.js';

const SENSOR = 'GN2-BUS-PT';
const SOLENOID = 'GN2-BB-PRESS';
const ISOLATION = 'GND-GN2-PRESS';

function fixture({ armed = true, p = 100, vent = 'closed' } = {}) {
  const valves = Object.fromEntries([SOLENOID, ISOLATION, VENT_VALVE].map((id) =>
    [id, { id, name: id, safeState: id === VENT_VALVE ? 'open' : 'closed' }]));
  const wire = [];
  const stand = {
    armed,
    abortState: { active: false },
    readings: { [SENSOR]: p },
    valveStates: { [SOLENOID]: 'closed', [ISOLATION]: 'closed', [VENT_VALVE]: vent },
    config: {
      sensors: [{ id: SENSOR }],
      gn2Press: {
        name: 'GN2 COPV Press', valve: SOLENOID, isolationValve: ISOLATION, sensor: SENSOR,
        setpoint: 500, deadband: 25, setpointMin: 0, setpointMax: 4500,
        maxOpenMs: 1000, minIntervalMs: 500, overpressure: 4600, requiresArm: true,
      },
    },
    configStore: { valve: (id) => valves[id] ?? null },
    sequencer: { ownsValve: () => false },
    commandValve(id, state, opts = {}) {
      if (!opts.internal) {
        const hand = this.gn2Press.handCommand(id, state, opts.source);
        if (!hand.ok) return hand;
        if (state === 'open' && id !== VENT_VALVE && !this.armed) return { ok: false, error: 'requires ARM' };
      }
      wire.push(`${id}=${state}`);
      this.valveStates[id] = state;
      return { ok: true };
    },
    log() {}, emit() {}, snapshot() { return {}; },
  };
  stand.gn2Press = new Gn2Press(stand);
  const step = new PressStep(stand);
  const tick = (now) => { stand.gn2Press.update(stand.readings, now); step.update(stand.readings, now); };
  return { stand, step, loop: stand.gn2Press, wire, tick };
}

test('opens the isolation valve and runs the loop at the target', () => {
  const { stand, step, loop, wire, tick } = fixture();
  assert.equal(step.start({ target: 1000, timeoutMs: 60000 }).ok, true);
  assert.deepEqual(wire, [`${ISOLATION}=open`]);
  assert.equal(loop.enabled, true);
  assert.equal(loop.settings.setpoint, 1000);
  tick(step.active.startedAt);
  assert.equal(stand.valveStates[SOLENOID], 'open', 'the loop, not the step, opened the solenoid');
});

test('ends on target and leaves the loop holding', () => {
  const { stand, step, loop, tick } = fixture();
  step.start({ target: 1000, timeoutMs: 60000 });
  const t0 = step.active.startedAt;

  stand.readings[SENSOR] = 950;
  tick(t0 + 5000);
  assert.ok(step.active, 'short of target: still pressing');

  stand.readings[SENSOR] = 1004;
  tick(t0 + 6000);
  assert.equal(step.active, null);
  assert.equal(step.last.reason, 'target reached');
  assert.equal(step.last.startP, 100);
  assert.equal(step.last.endP, 1004);
  assert.equal(loop.enabled, true, 'holding the bus at the target');
  assert.equal(stand.valveStates[ISOLATION], 'open');

  // The next step raises the same running loop.
  assert.equal(step.start({ target: 2000, timeoutMs: 60000 }).ok, true);
  assert.equal(loop.settings.setpoint, 2000);
});

test('the timeout turns the loop off', () => {
  const { stand, step, loop, tick } = fixture();
  step.start({ target: 1000, timeoutMs: 2000 });
  const t0 = step.active.startedAt;
  stand.readings[SENSOR] = 400;
  tick(t0 + 1999);
  assert.ok(step.active);
  tick(t0 + 2000);
  assert.equal(step.active, null);
  assert.equal(step.last.reason, 'step timeout');
  assert.equal(loop.enabled, false);
  assert.equal(stand.valveStates[SOLENOID], 'closed');
});

test('the overpressure close ends the step and shuts both valves', () => {
  const { stand, step, tick } = fixture();
  step.start({ target: 4000, timeoutMs: 60000 });
  stand.readings[SENSOR] = 4650;
  tick(step.active.startedAt + 100);
  assert.equal(step.active, null);
  assert.match(step.last.reason, /loop stopped \(GN2 OVERPRESSURE/);
  assert.equal(stand.valveStates[SOLENOID], 'closed');
  assert.equal(stand.valveStates[ISOLATION], 'closed');
});

test('a PT switched mid-step is the one the step judges by', () => {
  const { stand, step, loop, tick } = fixture();
  stand.config.sensors.push({ id: 'GN2-FILL-PT', kind: 'pressure' });
  stand.readings['GN2-FILL-PT'] = 200;
  step.start({ target: 1000, timeoutMs: 60000 });
  loop.set({ sensor: 'GN2-FILL-PT' });
  stand.readings['GN2-FILL-PT'] = 1001;
  tick(step.active.startedAt + 100);
  assert.equal(step.last.reason, 'target reached');
  assert.equal(step.last.sensor, 'GN2-FILL-PT');
});

test('refuses what it cannot run or judge, before anything moves', () => {
  const { stand, step, wire } = fixture();
  assert.equal(step.start({ target: 4600, timeoutMs: 1000 }).ok, false, 'over setpointMax');
  assert.equal(step.start({ target: 4590, timeoutMs: 1000 }).ok, false, 'band would reach the overpressure close');
  assert.equal(step.start({ target: 0, timeoutMs: 1000 }).ok, false, 'no target');
  assert.equal(step.start({ target: 900, timeoutMs: 0 }).ok, false, 'no timeout');
  assert.equal(step.start({ target: 900, timeoutMs: MAX_STEP_MS + 1 }).ok, false, 'over the per-step cap');
  stand.readings[SENSOR] = undefined;
  assert.equal(step.start({ target: 900, timeoutMs: 1000 }).ok, false, 'no reading');
  assert.deepEqual(wire, [], 'nothing went out');
});

test('a loop that refuses shuts the isolation valve the step just opened', () => {
  const { stand, step, wire } = fixture({ p: 4700 });   // over the overpressure close
  const res = step.start({ target: 1000, timeoutMs: 1000, force: true });
  assert.equal(res.ok, false);
  // Refused at the isolation valve itself: the overpressure close holds it.
  assert.deepEqual(wire, []);
  assert.equal(stand.valveStates[ISOLATION], 'closed');

  const disarmed = fixture({ armed: false });
  assert.equal(disarmed.step.start({ target: 1000, timeoutMs: 1000 }).ok, false);
  assert.equal(disarmed.stand.valveStates[ISOLATION], 'closed');
});

test('GN2 VENT open is the tool\'s advice, not a server block', () => {
  const { step } = fixture({ vent: 'open' });
  assert.equal(step.start({ target: 1000, timeoutMs: 1000 }).ok, true);
});

test('one step at a time; a target already reached ends at once', () => {
  const { step, tick } = fixture({ p: 1200 });
  assert.equal(step.start({ target: 1000, timeoutMs: 5000 }).ok, true);
  assert.equal(step.start({ target: 1000, timeoutMs: 5000 }).ok, false);
  tick(step.active.startedAt + 20);
  assert.equal(step.last.reason, 'target reached');
});

test('stop turns the loop off and shuts isolation, with or without a step', () => {
  const { stand, step, loop, tick } = fixture();
  step.start({ target: 1000, timeoutMs: 60000 });
  stand.readings[SENSOR] = 1001;
  tick(step.active.startedAt + 100);   // reached; holding
  assert.equal(loop.enabled, true);

  assert.equal(step.stop().ok, true);
  assert.equal(loop.enabled, false);
  assert.equal(stand.valveStates[SOLENOID], 'closed');
  assert.equal(stand.valveStates[ISOLATION], 'closed');
});

test('vent stops, then opens GN2 VENT — even disarmed', () => {
  const { stand, step, wire, tick } = fixture();
  step.start({ target: 1000, timeoutMs: 60000 });
  tick(step.active.startedAt);
  stand.armed = false;
  wire.length = 0;
  assert.equal(step.vent().ok, true);
  assert.deepEqual(wire, [`${SOLENOID}=closed`, `${ISOLATION}=closed`, `${VENT_VALVE}=open`]);
  assert.equal(step.last.reason, 'vent');
});

test('a stand without a GN2 loop has no tool', () => {
  const { stand, step } = fixture();
  stand.config.gn2Press = null;
  stand.gn2Press.sync();
  const res = step.start({ target: 1000, timeoutMs: 1000 });
  assert.equal(res.ok, false);
  assert.match(res.error, /no GN2 press loop/);
  assert.equal(step.snapshot().available, false);
});
