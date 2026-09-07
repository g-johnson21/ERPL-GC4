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

// ------------------------------------------------- board transducers --

/** A stand shaped like the real one: a flow-ordered LOX column, one board PT. */
function standWithBoardPT() {
  bus.config = {
    sensorGroups: [{ id: 'lox', label: 'LOX', color: '#3b82f6' }],
    // Declared in the order fluid reaches them, which is NOT numeric order.
    sensors: [
      { id: 'PT1', group: 'lox' },
      { id: 'PT2', group: 'lox' },
      { id: 'PT4', group: 'lox' },
      { id: 'PT21', group: 'lox' },
      { id: 'PT22', group: 'lox' },
      { id: 'PT5', group: 'lox' },
    ],
    bangbang: [{
      id: 'bb-ox',
      side: 'L',
      boardSensor: { id: 'PT3', name: 'LOX Tank Upstream', group: 'lox', warnHigh: 1200, dangerHigh: 1380 },
    }],
  };
}

test('a board transducer lands at its tag number without reordering the column', () => {
  // The column is ordered by plumbing, not by number — PT21 and PT22 sit
  // between PT4 and PT5 because that is the order fluid reaches them. Sorting
  // the column to place PT3 would rewrite a layout an operator reads down.
  standWithBoardPT();
  const lox = bus.sensorGroups()[0];
  assert.deepEqual(lox.sensors.map((s) => s.id), ['PT1', 'PT2', 'PT3', 'PT4', 'PT21', 'PT22', 'PT5']);
  assert.equal(lox.sensors[2].board, true, 'and it is marked as the board own');
  assert.equal(lox.sensors[2].controller, 'bb-ox');
});

test('a tag that outranks the whole column goes last rather than nowhere', () => {
  const stand = (group) => ({
    sensorGroups: [{ id: 'lox', label: 'LOX' }],
    sensors: [{ id: 'PT1', group: 'lox' }, { id: 'PT2', group: 'lox' }],
    bangbang: [{ id: 'bb-ox', side: 'L', boardSensor: { id: 'PT9', group } }],
  });

  bus.config = stand('lox');
  assert.deepEqual(bus.sensorGroups()[0].sensors.map((s) => s.id), ['PT1', 'PT2', 'PT9']);

  // A group nobody declared is synthesized rather than the reading being lost,
  // exactly as it is for a DAQ channel.
  bus.config = stand('board');
  assert.deepEqual(bus.sensorGroups().map((g) => g.id), ['lox', 'board']);
});

test('a stale board reads blank, not the last pressure it sent', () => {
  // The board keeps regulating when the link drops, so a held number is not a
  // measurement — it is where the tank was when we stopped being told. The
  // bang-bang card makes the same call, and the two must not disagree.
  standWithBoardPT();
  bus.state = { controllers: { 'bb-ox': { board: { pressure: 451.2, stale: false } } } };
  assert.equal(bus.reading('PT3'), 451.2);
  assert.equal(bus.sensorStatus('PT3'), 'ok');

  bus.state.controllers['bb-ox'].board.stale = true;
  assert.equal(bus.reading('PT3'), null);
  assert.equal(bus.sensorStatus('PT3'), 'stale');

  // A driver that does not speak the board protocol reports no board at all.
  bus.state = { controllers: { 'bb-ox': { board: null } } };
  assert.equal(bus.reading('PT3'), null);
  assert.equal(bus.sensorStatus('PT3'), 'stale');
});

test('the board thresholds are applied here, because the server applies none', () => {
  // A DAQ channel arrives with its status already decided. A board PT arrives
  // as a bare pressure inside `controllers`, so a warn limit that is never
  // evaluated is a warn limit that never fires.
  standWithBoardPT();
  const at = (psi) => {
    bus.state = { controllers: { 'bb-ox': { board: { pressure: psi, stale: false } } } };
    return bus.sensorStatus('PT3');
  };
  assert.equal(at(450), 'ok');
  assert.equal(at(1200), 'warn');
  assert.equal(at(1380), 'danger');
});

test('the Data page is never offered a tare that would zero the wrong sensor', () => {
  // The board's zero lives in its own EEPROM, is refused while that side is
  // regulating, and /api/tare could not apply it. `null` is what keeps the
  // button from being drawn.
  standWithBoardPT();
  bus.state = {
    sensors: { PT4: { v: 1, status: 'ok', tare: 0 } },
    controllers: { 'bb-ox': { board: { pressure: 451.2, stale: false } } },
  };
  assert.equal(bus.tare('PT4'), 0, 'a DAQ channel the hardware can zero');
  assert.equal(bus.canTare('PT4'), true);
  assert.equal(bus.tare('PT3'), null);
  assert.equal(bus.canTare('PT3'), false);
});

test('board pressures reach the history, so they get a trace like anything else', () => {
  standWithBoardPT();
  bus.history.clear();
  bus.state = { controllers: { 'bb-ox': { board: { pressure: 450, stale: false } } } };

  bus.pushHistory({ t: 1000, sensors: { PT4: { v: 12 } }, controllers: bus.state.controllers });
  bus.pushHistory({ t: 1050, sensors: { PT4: { v: 13 } }, controllers: bus.state.controllers });
  assert.deepEqual(bus.history.get('PT3').v, [450, 450]);

  // A stale board contributes no sample rather than a flat line that never
  // happened — a sparkline is read as evidence the number is live.
  bus.pushHistory({ t: 1100, sensors: {}, controllers: { 'bb-ox': { board: { pressure: 450, stale: true } } } });
  assert.deepEqual(bus.history.get('PT3').t, [1000, 1050]);
  bus.history.clear();
});

test('a stand with no bang-bang controllers is unaffected', () => {
  bus.config = { sensorGroups: [], sensors: [{ id: 'PT1', group: 'lox' }] };
  assert.deepEqual(bus.boardSensors(), []);
  assert.equal(bus.boardSensor('PT1'), null);
  assert.deepEqual(bus.sensorGroups()[0].sensors.map((s) => s.id), ['PT1']);
});

test('a spectator page refuses to send a command instead of sending one that fails', async () => {
  // The server is the enforcement — the spectator port has no mutating route
  // at all. This is the second half: a page that knows it cannot command must
  // not put a request on the wire, because "it was rejected" and "it was never
  // sent" look identical to a viewer and only one of them is honest about the
  // window they are looking at.
  bus.config = { ui: { spectator: true } };
  assert.equal(bus.spectator, true);

  const res = await bus.post('/api/arm', { armed: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /read-only/i);

  // And an operator station is unaffected: absence of the flag is not the flag.
  bus.config = { ui: {} };
  assert.equal(bus.spectator, false);
});
