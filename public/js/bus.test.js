/**
 * Tests for the client-side lookups that have no visible failure mode.
 *
 *   node --test public/js/bus.test.js
 *
 * A rate of change is a number an operator acts on — "the tank is filling at
 * 50 psi/s" decides whether to close a valve — and a sign error or a botched
 * window reads as a plausible number rather than as a fault. Same for sensor
 * grouping: a mis-grouped channel simply appears in the wrong column, under
 * the wrong colour, with nothing to say it is wrong.
 *
 * bus.js touches the network only from methods, so importing it here is safe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bus } from './bus.js';

/** N seconds of samples at 20 Hz, ending now, on a straight line of `slope`. */
function ramp(slope, { seconds = 3, start = 500, hz = 20 } = {}) {
  const now = Date.now();
  const n = Math.round(seconds * hz);
  const t = [], v = [];
  for (let i = n; i >= 0; i--) {
    t.push(now - (i * 1000) / hz);
    v.push(start + slope * (-i / hz));
  }
  return { t, v };
}

function withHistory(id, series, fn) {
  bus.history.set(id, series);
  try { return fn(); } finally { bus.history.delete(id); }
}

// ------------------------------------------------------------------ rate --

test('a straight ramp reports its own slope', () => {
  withHistory('PT', ramp(50), () => {
    assert.ok(Math.abs(bus.rate('PT', 3) - 50) < 1e-6);
  });
  withHistory('PT', ramp(-12.5), () => {
    assert.ok(Math.abs(bus.rate('PT', 3) + 12.5) < 1e-6);
  });
});

test('a flat signal reports zero, not drift', () => {
  withHistory('PT', ramp(0), () => {
    assert.ok(Math.abs(bus.rate('PT', 3)) < 1e-9);
  });
});

test('noise averages out instead of being read off the last two samples', () => {
  // The reason this is a least-squares fit and not (last - first) / dt: a
  // two-point difference on a transducer with tens of psi of noise reports
  // the noise, not the trend.
  const series = ramp(10);
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  series.v = series.v.map((y) => y + rand() * 40);          // +/- 20 units

  withHistory('PT', series, () => {
    const fitted = bus.rate('PT', 3);
    const twoPoint = (series.v.at(-1) - series.v[0]) / 3;
    assert.ok(Math.abs(fitted - 10) < Math.abs(twoPoint - 10),
      `fit ${fitted.toFixed(1)} should beat the two-point ${twoPoint.toFixed(1)}`);
    assert.ok(Math.abs(fitted - 10) < 5, `fit was ${fitted.toFixed(1)}`);
  });
});

test('the window is honoured: older samples do not drag the answer', () => {
  // A long climb that has just levelled off must read as level, or an
  // operator watching for "it has stopped rising" never sees it.
  const now = Date.now();
  const t = [], v = [];
  for (let i = 200; i > 60; i--) { t.push(now - (i * 1000) / 20); v.push(1000 - i * 5); }  // steep
  for (let i = 60; i >= 0; i--) { t.push(now - (i * 1000) / 20); v.push(700); }            // flat
  withHistory('PT', { t, v }, () => {
    assert.ok(Math.abs(bus.rate('PT', 3)) < 1e-6, 'the last 3 s are flat');
    assert.ok(bus.rate('PT', 10) > 1, 'a wider window still sees the climb');
  });
});

test('too little history says nothing rather than guessing', () => {
  assert.equal(bus.rate('never-seen', 3), null);
  withHistory('PT', { t: [Date.now()], v: [500] }, () => {
    assert.equal(bus.rate('PT', 3), null);
  });
  // Every sample at one instant: a slope through a vertical line is not a
  // number, and Infinity on a control screen is worse than a blank.
  const now = Date.now();
  withHistory('PT', { t: [now, now, now, now, now], v: [1, 2, 3, 4, 5] }, () => {
    assert.equal(bus.rate('PT', 3), null);
  });
});

// ---------------------------------------------------------------- groups --

test('sensors are grouped in the order the config declares', () => {
  bus.config = {
    sensorGroups: [
      { id: 'lox', label: 'LOX', color: '#3b82f6' },
      { id: 'fuel', label: 'Fuel', color: '#ef4444' },
    ],
    sensors: [
      { id: 'PT11', group: 'fuel' },
      { id: 'PT1', group: 'lox' },
      { id: 'PT22', group: 'lox' },
    ],
  };

  const groups = bus.sensorGroups();
  assert.deepEqual(groups.map((g) => g.id), ['lox', 'fuel'], 'config order, not first-seen');
  assert.deepEqual(groups[0].sensors.map((s) => s.id), ['PT1', 'PT22']);
  assert.equal(groups[0].color, '#3b82f6');
  assert.equal(bus.sensorGroup('PT22').label, 'LOX');
});

test('a group nobody declared is synthesized rather than dropped', () => {
  // Losing a channel because its group is missing from the config would hide
  // an instrument entirely, which is the one outcome not worth risking.
  bus.config = {
    sensorGroups: [{ id: 'lox', label: 'LOX', color: '#3b82f6' }],
    sensors: [{ id: 'PT1', group: 'lox' }, { id: 'TC9', group: 'cryo' }],
  };

  const groups = bus.sensorGroups();
  assert.deepEqual(groups.map((g) => g.id), ['lox', 'cryo']);
  assert.deepEqual(groups[1].sensors.map((s) => s.id), ['TC9']);
  assert.ok(groups[1].color, 'synthesized groups still get a colour');
});

test('an empty declared group is not rendered as an empty column', () => {
  bus.config = {
    sensorGroups: [
      { id: 'lox', label: 'LOX' },
      { id: 'unused', label: 'Unused' },
    ],
    sensors: [{ id: 'PT1', group: 'lox' }],
  };
  assert.deepEqual(bus.sensorGroups().map((g) => g.id), ['lox']);
});
