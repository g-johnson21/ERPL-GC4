/**
 * Tests for the COPV Press Tool's step on the GN2 bang-bang controller.
 *
 *   node --test server/press-step.test.js
 *
 * The properties that matter: a step only ever asks BangBangBank for a
 * setpoint (it never drives the press solenoid), the SERVER ends it on target
 * or timeout whatever the browser does, a reached target leaves the board
 * holding, and Stop / Vent go out in an order the board will accept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PressStep, ISOLATION_VALVE, VENT_VALVE, MAX_STEP_MS } from './press-step.js';

const SENSOR = 'GN2-BUS-PT';

function fixture({ armed = true, p = 100, vent = 'closed', refuse = null } = {}) {
  const cfg = {
    id: 'bb-gn2', side: 'G', name: 'GN2 COPV Press', sensor: SENSOR, valve: 'GN2-BB-PRESS',
    setpointMin: 0, setpointMax: 4500,
  };
  const valves = {
    [ISOLATION_VALVE]: { id: ISOLATION_VALVE, name: 'Ground GN2 Press', safeState: 'closed' },
    [VENT_VALVE]: { id: VENT_VALVE, name: 'GN2 Vent', safeState: 'open' },
    'GN2-BB-PRESS': { id: 'GN2-BB-PRESS', name: 'GN2 Bang-Bang Press', safeState: 'closed' },
  };
  const wire = [];   // valve commands and controller patches, in order
  const rt = { id: cfg.id, enabled: false, setpoint: 500, deadband: 25, fault: null };
  const stand = {
    armed,
    readings: { [SENSOR]: p },
    valveStates: { [ISOLATION_VALVE]: 'closed', [VENT_VALVE]: vent, 'GN2-BB-PRESS': 'closed' },
    config: { bangbang: [cfg] },
    configStore: { valve: (id) => valves[id] ?? null },
    bangbang: {
      get: (id) => (id === cfg.id ? rt : undefined),
      set(id, patch) {
        if (refuse) return { ok: false, error: refuse };
        if (patch.enabled && !stand.armed) return { ok: false, error: 'requires ARM' };
        wire.push(`bb ${JSON.stringify(patch)}`);
        if (patch.setpoint !== undefined) rt.setpoint = patch.setpoint;
        if (patch.enabled !== undefined) rt.enabled = patch.enabled;
        return { ok: true };
      },
    },
    commandValve(id, state, opts = {}) {
      if (state === 'open' && id !== VENT_VALVE && !this.armed) return { ok: false, error: 'requires ARM' };
      wire.push(`${id}=${state}`);
      this.valveStates[id] = state;
      return { ok: true };
    },
    log() {}, emit() {}, snapshot() { return {}; },
  };
  const step = new PressStep(stand);
  return { stand, step, rt, wire };
}

test('opens the isolation valve, raises the setpoint, and never drives the solenoid', () => {
  const { stand, step, rt, wire } = fixture();
  assert.equal(step.start({ target: 1000, timeoutMs: 60000 }).ok, true);
  assert.deepEqual(wire, [`${ISOLATION_VALVE}=open`, 'bb {"setpoint":1000,"enabled":true}']);
  assert.equal(rt.enabled, true);
  assert.equal(stand.valveStates['GN2-BB-PRESS'], 'closed', 'the board drives the solenoid, not the host');
});

test('ends on target and leaves the controller holding', () => {
  const { stand, step, rt } = fixture();
  step.start({ target: 1000, timeoutMs: 60000 });
  const t0 = step.active.startedAt;

  stand.readings[SENSOR] = 950;
  step.update(stand.readings, t0 + 5000);
  assert.ok(step.active, 'short of target: still pressing');

  stand.readings[SENSOR] = 1004;
  step.update(stand.readings, t0 + 6000);
  assert.equal(step.active, null);
  assert.equal(step.last.reason, 'target reached');
  assert.equal(step.last.startP, 100);
  assert.equal(step.last.endP, 1004);
  assert.equal(rt.enabled, true, 'holding the bus at the target');
  assert.equal(stand.valveStates[ISOLATION_VALVE], 'open');

  // The next step raises the same running controller; nothing is re-opened.
  const res = step.start({ target: 2000, timeoutMs: 60000 });
  assert.equal(res.ok, true);
  assert.equal(rt.setpoint, 2000);
});

test('the timeout disables the controller', () => {
  const { stand, step, rt } = fixture();
  step.start({ target: 1000, timeoutMs: 2000 });
  const t0 = step.active.startedAt;
  stand.readings[SENSOR] = 400;
  step.update(stand.readings, t0 + 1999);
  assert.ok(step.active);
  step.update(stand.readings, t0 + 2000);
  assert.equal(step.active, null);
  assert.equal(step.last.reason, 'step timeout');
  assert.equal(rt.enabled, false);
});

test('a controller dropped elsewhere ends the step, with its fault', () => {
  const { stand, step, rt } = fixture();
  step.start({ target: 1000, timeoutMs: 60000 });
  rt.enabled = false;
  rt.fault = 'Disarmed';
  step.update(stand.readings, step.active.startedAt + 100);
  assert.equal(step.active, null);
  assert.equal(step.last.reason, 'controller stopped (Disarmed)');
});

test('a lost reading does not end the step — the board regulates on its own PT', () => {
  const { stand, step } = fixture();
  step.start({ target: 1000, timeoutMs: 2000 });
  const t0 = step.active.startedAt;
  stand.readings[SENSOR] = null;
  step.update(stand.readings, t0 + 100);
  assert.ok(step.active);
  step.update(stand.readings, t0 + 2000);
  assert.equal(step.last.reason, 'step timeout', 'the timeout still bounds it');
});

test('refuses what it cannot run or judge', () => {
  const { stand, step, wire } = fixture();
  assert.equal(step.start({ target: 4600, timeoutMs: 1000 }).ok, false, 'over the controller setpoint limit');
  assert.equal(step.start({ target: 0, timeoutMs: 1000 }).ok, false, 'no target');
  assert.equal(step.start({ target: 900, timeoutMs: 0 }).ok, false, 'no timeout');
  assert.equal(step.start({ target: 900, timeoutMs: MAX_STEP_MS + 1 }).ok, false, 'over the per-step cap');
  stand.readings[SENSOR] = undefined;
  assert.equal(step.start({ target: 900, timeoutMs: 1000 }).ok, false, 'no reading');
  assert.deepEqual(wire, [], 'nothing went out');

  const vented = fixture({ vent: 'open' });
  const res = vented.step.start({ target: 900, timeoutMs: 1000 });
  assert.equal(res.ok, false, 'GN2 VENT open: the board would seal it behind our back');
  assert.match(res.error, /seal it first/);
  assert.deepEqual(vented.wire, []);
});

test('a controller that refuses shuts the isolation valve it just opened', () => {
  const { stand, step, wire } = fixture({ refuse: 'side G is latched in ABORT on the board' });
  const res = step.start({ target: 900, timeoutMs: 1000 });
  assert.equal(res.ok, false);
  assert.equal(stand.valveStates[ISOLATION_VALVE], 'closed');
  assert.deepEqual(wire, [`${ISOLATION_VALVE}=open`, `${ISOLATION_VALVE}=closed`]);
  assert.equal(step.active, null);
});

test('one step at a time; a target already reached ends at once', () => {
  const { stand, step } = fixture({ p: 1200 });
  assert.equal(step.start({ target: 1000, timeoutMs: 5000 }).ok, true);
  assert.equal(step.start({ target: 1000, timeoutMs: 5000 }).ok, false);
  step.update(stand.readings, step.active.startedAt + 20);
  assert.equal(step.last.reason, 'target reached');
});

test('stop turns the loop off and shuts isolation, with or without a step', () => {
  const { stand, step, rt } = fixture();
  step.start({ target: 1000, timeoutMs: 60000 });
  stand.readings[SENSOR] = 1001;
  step.update(stand.readings, step.active.startedAt + 100);   // reached; holding
  assert.equal(rt.enabled, true);

  assert.equal(step.stop().ok, true);
  assert.equal(rt.enabled, false);
  assert.equal(stand.valveStates[ISOLATION_VALVE], 'closed');
});

test('vent disables the loop BEFORE opening its vent, even disarmed', () => {
  const { stand, step, wire } = fixture();
  step.start({ target: 1000, timeoutMs: 60000 });
  stand.armed = false;
  wire.length = 0;
  assert.equal(step.vent().ok, true);
  assert.deepEqual(wire, ['bb {"enabled":false}', `${ISOLATION_VALVE}=closed`, `${VENT_VALVE}=open`]);
  assert.equal(step.last.reason, 'vent');
  assert.equal(stand.valveStates[VENT_VALVE], 'open');
});

test('a stand without a GN2 side has no tool', () => {
  const { stand, step } = fixture();
  stand.config.bangbang = [{ id: 'bb-ox', side: 'L' }];
  const res = step.start({ target: 1000, timeoutMs: 1000 });
  assert.equal(res.ok, false);
  assert.match(res.error, /no GN2 bang-bang controller/);
  assert.equal(step.snapshot().controller, null);
});
