import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLanes, simulate, stateAt, lint, niceStep, snapTime, shiftSteps,
  sortSteps, stopTime, isUnreachable, describe, fmtT, fmtDelta,
} from './seq-model.js';

const config = {
  valves: [
    { id: 'MV-LOX', safeState: 'closed', abortState: 'closed', requiresArm: true },
    { id: 'MV-F', safeState: 'closed', abortState: 'closed', requiresArm: true },
    { id: 'VENT', safeState: 'open', abortState: 'open', openLabel: 'VENT', closedLabel: 'SEALED' },
    { id: 'IGN', type: 'igniter', momentary: true, momentaryMs: 500, safeState: 'closed' },
  ],
  bangbang: [{ id: 'bb-ox' }, { id: 'bb-fuel' }],
};

const hotfire = () => ({
  steps: [
    { t: 0, action: 'log', message: 'START' },
    { t: 0, action: 'valve', target: 'MV-LOX', state: 'open' },
    { t: 0.5, action: 'valve', target: 'MV-F', state: 'open' },
    { t: 1, action: 'bangbang', target: '*', enabled: true, setpoint: 700 },
    { t: 5, action: 'valve', target: 'MV-LOX', state: 'closed' },
    { t: 5.5, action: 'valve', target: 'MV-F', state: 'closed' },
  ],
});

test('lanes follow first use, then controllers; * expands to every controller', () => {
  const lanes = buildLanes(hotfire(), config);
  assert.deepEqual(lanes.map((l) => l.key),
    ['events', 'valve:MV-LOX', 'valve:MV-F', 'bb:bb-ox', 'bb:bb-fuel']);
});

test('extra lanes appear even with no step on them', () => {
  const lanes = buildLanes(hotfire(), config, ['valve:VENT']);
  assert.ok(lanes.some((l) => l.key === 'valve:VENT'));
});

test('simulate: open window runs from the open step to the close step', () => {
  const sim = simulate(hotfire(), config);
  const lox = sim.valves.get('MV-LOX');
  assert.equal(lox.length, 2);
  assert.deepEqual([lox[0].from, lox[0].to, lox[0].state], [0, 5, 'open']);
  assert.deepEqual([lox[1].from, lox[1].to, lox[1].state], [5, 5.5, 'closed']);
  assert.equal(stateAt(sim, 'valve:MV-F', 0.2), null, 'before its first step the state is unknown');
  assert.equal(stateAt(sim, 'valve:MV-F', 0.5).state, 'open');
  assert.equal(stateAt(sim, 'bb:bb-fuel', 2).state.enabled, true);
});

test('simulate: SAFE ALL moves every valve already on the timeline', () => {
  const seq = hotfire();
  seq.steps.push({ t: 3, action: 'safeAll' });
  const sim = simulate(seq, config);
  const seg = stateAt(sim, 'valve:MV-LOX', 3.1);
  assert.equal(seg.state, 'closed');
  assert.equal(seg.implicit, true);
  // The explicit close at T+5 is now redundant.
  assert.ok(sim.redundant.has(seq.steps[4]));
});

test('simulate: a momentary valve closes itself after its pulse', () => {
  const sim = simulate({ steps: [{ t: 1, action: 'valve', target: 'IGN', state: 'open' }, { t: 4, action: 'log' }] }, config);
  const segs = sim.valves.get('IGN');
  assert.deepEqual(segs.map((s) => [s.from, s.state]), [[1, 'open'], [1.5, 'closed']]);
  assert.equal(segs[1].cause, 'pulse');
});

test('END cuts the sequence off; later steps are unreachable', () => {
  const seq = hotfire();
  seq.steps.splice(3, 0, { t: 2, action: 'end' });
  assert.equal(stopTime(seq), 2);
  assert.ok(isUnreachable(seq, seq.steps.find((s) => s.t === 5)));
  const sim = simulate(seq, config);
  assert.equal(sim.valves.get('MV-LOX').at(-1).to, 2);
  assert.ok(lint(seq, config).get(seq.steps.find((s) => s.t === 5)));
});

test('lint flags a bang-bang step that changes nothing and ARM mismatches', () => {
  const seq = { requiresArm: false, steps: [
    { t: 0, action: 'bangbang', target: 'bb-ox' },
    { t: 1, action: 'valve', target: 'MV-F', state: 'open' },
  ] };
  const found = lint(seq, config);
  assert.match(found.get(seq.steps[0])[0], /Changes nothing/);
  assert.match(found.get(seq.steps[1])[0], /ARMED/);
});

test('niceStep picks 1/2/5 spacings', () => {
  assert.equal(niceStep(10, 10), 1);
  assert.equal(niceStep(11.7, 8), 2);
  assert.equal(niceStep(0.8, 8), 0.1);
  assert.equal(niceStep(0), 1);
});

test('snapTime prefers magnets, then the grid, never below zero', () => {
  assert.equal(snapTime(1.23, { grid: 0.1 }), 1.2);
  assert.equal(snapTime(1.23, { grid: 0.1, magnets: [1.26], magnet: 0.05 }), 1.26);
  assert.equal(snapTime(-0.4, { grid: 0.1 }), 0);
  assert.equal(snapTime(0.333, {}), 0.333);
});

test('shiftSteps: plain move, ripple, and clamping at T+0', () => {
  const seq = hotfire();
  const orig = new Map(seq.steps.map((s) => [s, s.t]));
  const mf = seq.steps[2];

  shiftSteps(seq.steps, orig, [mf], 0.25);
  assert.equal(mf.t, 0.75);
  assert.equal(seq.steps[4].t, 5, 'without ripple later steps stay put');

  shiftSteps(seq.steps, orig, [mf], 0.25, true);
  assert.equal(seq.steps[4].t, 5.25, 'ripple carries later steps');
  assert.equal(seq.steps[1].t, 0, 'earlier steps never move');

  const d = shiftSteps(seq.steps, orig, [mf], -3);
  assert.equal(d, -0.5);
  assert.equal(mf.t, 0);
});

test('sortSteps is stable for equal times', () => {
  const a = { t: 1, id: 'a' }, b = { t: 0 }, c = { t: 1, id: 'c' };
  const seq = { steps: [a, b, c] };
  sortSteps(seq);
  assert.deepEqual(seq.steps, [b, a, c]);
});

test('describe and formatting', () => {
  assert.equal(describe({ action: 'valve', target: 'VENT', state: 'closed' }, config), 'VENT → SEALED');
  assert.equal(describe({ action: 'bangbang', target: '*', enabled: false }, config), 'All controllers: OFF');
  assert.equal(fmtT(1.5), 'T+1.50');
  assert.equal(fmtDelta(-0.1), '−0.10');
});
