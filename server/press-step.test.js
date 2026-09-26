/**
 * Tests for the COPV Press Tool's one-shot actuation.
 *
 *   node --test server/press-step.test.js
 *
 * The property that matters: once GROUND GN2 PRESS is open, the SERVER closes
 * it — on target, on max time, on a lost PT — and nothing a browser does or
 * fails to do can keep it open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PressStep, PRESS_VALVE, PRESS_SENSOR } from './press-step.js';

function fixture({ armed = true, p = 100 } = {}) {
  const valve = { id: PRESS_VALVE, name: 'Ground GN2 Press', safeState: 'closed' };
  const commands = [];
  const stand = {
    armed,
    readings: { [PRESS_SENSOR]: p },
    valveStates: { [PRESS_VALVE]: 'closed' },
    config: { sensors: [{ id: PRESS_SENSOR }, { id: 'COPV-PT', kind: 'pressure' }, { id: 'TC1', kind: 'temperature' }] },
    configStore: { valve: (id) => (id === PRESS_VALVE ? valve : null) },
    commandValve(id, state, opts = {}) {
      if (state === 'open' && !this.armed) return { ok: false, error: 'requires ARM' };
      commands.push({ id, state, internal: Boolean(opts.internal) });
      this.valveStates[id] = state;
      return { ok: true };
    },
    log() {}, emit() {}, snapshot() { return {}; },
  };
  const step = new PressStep(stand);
  return { stand, step, commands };
}

test('closes on target and records the step', () => {
  const { stand, step, commands } = fixture();
  assert.equal(step.start({ target: 500, maxMs: 5000 }).ok, true);
  assert.equal(stand.valveStates[PRESS_VALVE], 'open');
  const t0 = step.active.startedAt;

  stand.readings[PRESS_SENSOR] = 450;
  step.update(stand.readings, t0 + 1000);
  assert.equal(stand.valveStates[PRESS_VALVE], 'open');

  stand.readings[PRESS_SENSOR] = 505;
  step.update(stand.readings, t0 + 1500);
  assert.equal(stand.valveStates[PRESS_VALVE], 'closed');
  assert.equal(step.active, null);
  assert.equal(step.last.reason, 'target reached');
  assert.equal(step.last.startP, 100);
  assert.equal(step.last.endP, 505);
  assert.deepEqual(commands.map((c) => c.state), ['open', 'closed']);
});

test('closes on max actuation time short of target', () => {
  const { stand, step } = fixture();
  step.start({ target: 500, maxMs: 2000 });
  const t0 = step.active.startedAt;
  stand.readings[PRESS_SENSOR] = 300;
  step.update(stand.readings, t0 + 1999);
  assert.equal(stand.valveStates[PRESS_VALVE], 'open');
  step.update(stand.readings, t0 + 2000);
  assert.equal(stand.valveStates[PRESS_VALVE], 'closed');
  assert.equal(step.last.reason, 'max actuation time');
});

test('closes when the PT goes stale', () => {
  const { stand, step } = fixture();
  step.start({ target: 500, maxMs: 5000 });
  stand.readings[PRESS_SENSOR] = null;
  step.update(stand.readings, step.active.startedAt + 100);
  assert.equal(stand.valveStates[PRESS_VALVE], 'closed');
});

test('a valve closed by anyone else ends the step without re-commanding', () => {
  const { stand, step, commands } = fixture();
  step.start({ target: 500, maxMs: 5000 });
  stand.valveStates[PRESS_VALVE] = 'closed';   // abort, safe-all, a hand close
  step.update(stand.readings, step.active.startedAt + 100);
  assert.equal(step.active, null);
  assert.equal(step.last.reason, 'valve closed elsewhere');
  assert.equal(commands.length, 1);
});

test('refuses what it cannot finish safely', () => {
  const { stand, step } = fixture({ p: 600 });
  assert.equal(step.start({ target: 500, maxMs: 1000 }).ok, false, 'already above target');
  assert.equal(step.start({ target: 900, maxMs: 0 }).ok, false, 'no max time');
  assert.equal(step.start({ target: 900, maxMs: 10 * 60 * 1000 }).ok, false, 'over the per-step cap');
  stand.readings[PRESS_SENSOR] = undefined;
  assert.equal(step.start({ target: 900, maxMs: 1000 }).ok, false, 'no reading');
  assert.equal(stand.valveStates[PRESS_VALVE], 'closed');

  const disarmed = fixture({ armed: false });
  assert.equal(disarmed.step.start({ target: 500, maxMs: 1000 }).ok, false);
  assert.equal(disarmed.step.active, null);
});

test('only one step at a time; stop closes it', () => {
  const { stand, step } = fixture();
  assert.equal(step.start({ target: 500, maxMs: 5000 }).ok, true);
  assert.equal(step.start({ target: 500, maxMs: 5000 }).ok, false);
  assert.equal(step.stop('vent').ok, true);
  assert.equal(stand.valveStates[PRESS_VALVE], 'closed');
  assert.equal(step.last.reason, 'vent');
});

test('SHIFT override presses a bus already over target, for max time only', () => {
  const { stand, step } = fixture({ p: 600 });
  assert.equal(step.start({ target: 500, maxMs: 1000 }).ok, false);
  assert.equal(step.start({ target: 500, maxMs: 1000, force: true }).ok, true);
  const t0 = step.active.startedAt;
  step.update(stand.readings, t0 + 500);
  assert.equal(stand.valveStates[PRESS_VALVE], 'open', 'the target cannot end a forced step');
  step.update(stand.readings, t0 + 1000);
  assert.equal(stand.valveStates[PRESS_VALVE], 'closed');
  assert.equal(step.last.reason, 'max actuation time');

  stand.readings[PRESS_SENSOR] = null;
  assert.equal(step.start({ target: 500, maxMs: 1000, force: true }).ok, false, 'never blind');
});

test('a step can close on another PT, but only a pressure one with a reading', () => {
  const { stand, step } = fixture();
  stand.readings['COPV-PT'] = 50;
  stand.readings.TC1 = 20;
  assert.equal(step.start({ target: 500, maxMs: 5000, sensor: 'TC1' }).ok, false, 'not a PT');
  assert.equal(step.start({ target: 500, maxMs: 5000, sensor: 'NOPE' }).ok, false, 'unknown');
  assert.equal(step.start({ target: 500, maxMs: 5000, sensor: 'COPV-PT' }).ok, true);
  const t0 = step.active.startedAt;

  stand.readings[PRESS_SENSOR] = 900;   // the default PT is not the one watched
  step.update(stand.readings, t0 + 100);
  assert.equal(stand.valveStates[PRESS_VALVE], 'open');

  stand.readings['COPV-PT'] = 510;
  step.update(stand.readings, t0 + 200);
  assert.equal(stand.valveStates[PRESS_VALVE], 'closed');
  assert.equal(step.last.sensor, 'COPV-PT');
  assert.equal(step.last.endP, 510);
});
