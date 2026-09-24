/**
 * Tests for the NI-DAQ driver's sensor <-> channel addressing.
 *
 *   node --test server/hal/nidaq.test.js
 *
 * These cover the part of taring whose mistakes are silent: a tare that lands
 * on the wrong channel zeroes a transducer nobody was looking at and leaves
 * the one the operator meant reading as before. Nothing on screen says so.
 *
 * `init()` spawns the Python sidecar, so none of this calls it — the mapping
 * is built from the constructor's `channelMap` and `command()` is stubbed to
 * record what would have gone down the pipe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NiDaqDriver } from './nidaq.js';

const CHANNEL_MAP = {
  pt2: 'PT1', pt4: 'PT4', pt8: 'PT14',
  lc0: 'LC1',
  tc0: 'TC1',
};

/** A driver with the pipe replaced by a recorder. */
function makeDriver({ channelMap = CHANNEL_MAP, sensors = [], writable = true } = {}) {
  const driver = new NiDaqDriver({ channelMap });
  driver.config = { sensors };
  driver.sent = [];
  driver.command = (obj) => {
    if (!writable) return false;
    driver.sent.push(obj);
    return true;
  };
  return driver;
}

test('a sensor id resolves to the card and channel that measures it', () => {
  const d = makeDriver();
  assert.deepEqual(d.channelForSensor('PT4'), { card: 'pt', channel: 4 });
  assert.deepEqual(d.channelForSensor('PT14'), { card: 'pt', channel: 8 });
  assert.deepEqual(d.channelForSensor('LC1'), { card: 'lc', channel: 0 });
  assert.deepEqual(d.channelForSensor('TC1'), { card: 'tc', channel: 0 });
});

test('a sensor this device does not read resolves to nothing', () => {
  // PT14 is the DAQ's pt8. A sensor id that merely LOOKS like a channel key
  // must not be guessed at.
  const d = makeDriver();
  assert.equal(d.channelForSensor('PT99'), null);
  assert.equal(d.channelForSensor('pt4'), null, 'lookup is by sensor id, not by key');
});

test('tareSensors addresses each channel individually', () => {
  const d = makeDriver();
  const res = d.tareSensors(['PT4', 'LC1']);

  assert.equal(res.ok, true);
  assert.deepEqual(res.tared, ['PT4', 'LC1']);
  assert.deepEqual(d.sent, [
    { action: 'tare', card: 'pt', channel: 4, clear: false },
    { action: 'tare', card: 'lc', channel: 0, clear: false },
  ]);
});

test('unmapped sensors come back as unsupported, and are not guessed at', () => {
  // A composite stand hands the same list to every device, so "not mine" has
  // to be an ordinary answer rather than a failure.
  const d = makeDriver();
  const res = d.tareSensors(['PT4', 'PT-NOT-ON-THIS-CARD']);

  assert.equal(res.ok, true);
  assert.deepEqual(res.tared, ['PT4']);
  assert.deepEqual(res.unsupported, ['PT-NOT-ON-THIS-CARD']);
  assert.equal(d.sent.length, 1, 'nothing sent for the unmapped sensor');
});

test('clear is passed through rather than being a second kind of command', () => {
  const d = makeDriver();
  d.tareSensors(['PT1'], { clear: true });
  assert.deepEqual(d.sent, [{ action: 'tare', card: 'pt', channel: 2, clear: true }]);
});

test('a dead sidecar fails the request instead of reporting success', () => {
  // The worst outcome is an operator believing a channel is zeroed when the
  // command never left the host.
  const d = makeDriver({ writable: false });
  const res = d.tareSensors(['PT1', 'PT4']);

  assert.equal(res.ok, false);
  assert.match(res.error, /not running/);
  assert.deepEqual(res.tared, []);
});

test('tareStatus reports only channels telemetry has confirmed', () => {
  const d = makeDriver();
  assert.deepEqual(d.tareStatus(), {}, 'nothing known before the first frame');

  d.onStdout(JSON.stringify({
    type: 'data',
    channels: [
      { card: 'pt', channel: 2, status: 'ok', pressure_psi: 100, tare: 12.5 },
      { card: 'pt', channel: 4, status: 'ok', pressure_psi: 50, tare: 0 },
    ],
  }) + '\n');

  // pt8/lc0/tc0 said nothing, so they offer no tare — a card that is down
  // must not present a button that cannot work.
  assert.deepEqual(d.tareStatus(), { PT1: 12.5, PT4: 0 });
});

test('the reported offset is scaled into the sensor units the UI shows', () => {
  // The sidecar zeroes BEFORE stand.json's calibration is applied, so a slope
  // other than 1 changes how big the shift looks on screen. Reporting the raw
  // number would put a figure on the button that does not match the change in
  // the reading beside it.
  const d = makeDriver({
    sensors: [{ id: 'PT1', calibration: { slope: 2, offset: 30 } }],
  });
  d.onStdout(JSON.stringify({
    type: 'data',
    channels: [{ card: 'pt', channel: 2, status: 'ok', pressure_psi: 0, tare: 10 }],
  }) + '\n');

  assert.equal(d.tareStatus().PT1, 20, 'slope scales it; the offset term cancels');
});

test('a tare that skipped channels is surfaced, not swallowed', () => {
  const events = [];
  const d = makeDriver();
  d.onEvent = (message, level) => events.push([level, message]);

  d.onStdout(JSON.stringify({
    type: 'ack', action: 'tare', ok: false, tared: ['pt2'], skipped: ['pt4'],
  }) + '\n');

  assert.equal(events.length, 1);
  // ERROR, not warn. The stand has already logged "*** TARE *** PT4" by the
  // time this arrives -- tareSensors() returns when the command is written and
  // the sidecar answers milliseconds later -- so this line has to overrule a
  // success the operator has already read, not sit quietly beneath it.
  assert.equal(events[0][0], 'error');
  assert.match(events[0][1], /Disregard the TARE line above/);
});

test('a refused tare names the sensor, not just the card channel', () => {
  // The operator tared PT4. The sidecar speaks in card and channel because
  // that is how the hardware is addressed, and reporting "pt4" asks them to
  // do the lookup from memory while something is wrong.
  const events = [];
  const d = makeDriver();
  d.onEvent = (message, level) => events.push([level, message]);

  d.onStdout(JSON.stringify({
    type: 'ack', action: 'tare', ok: false, tared: [], skipped: ['pt4', 'pt2', 'pt9'],
  }) + '\n');

  const [, message] = events[0];
  assert.match(message, /PT4 \(pt4\)/);
  assert.match(message, /PT1 \(pt2\)/);
  // An unmapped channel still appears: an unexpected channel in a refusal is
  // worth seeing, not worth dropping for having no name.
  assert.match(message, /pt9/);
  assert.match(message, /these channels/, 'plural when more than one refused');
});

test('sensorForLabel is the exact inverse of channelForSensor', () => {
  const d = makeDriver();
  for (const [label, id] of Object.entries(CHANNEL_MAP)) {
    const target = d.channelForSensor(id);
    assert.equal(`${target.card}${target.channel}`, label);
    assert.equal(d.sensorForLabel(label), `${id} (${label})`);
  }
  assert.equal(d.sensorForLabel('pt15'), 'pt15', 'unmapped falls back to the label');
  assert.equal(d.sensorForLabel('garbage'), 'garbage');
});

// ------------------------------------------------------- measured rx rate --

/**
 * Feed frames at a fixed spacing, controlling the clock the driver stamps
 * them with. `noteRx` reads `lastFrameAt`, so setting it directly is the whole
 * of the time travel needed — no fake timers.
 */
function feed(driver, { startMs, count, periodMs, samples }) {
  for (let i = 0; i < count; i++) {
    driver.lastFrameAt = startMs + i * periodMs;
    driver.noteRx({ channels: [{ card: 'pt', samples: new Array(samples).fill(0) }] });
  }
}

test('the receive rate is measured from arrivals, not from the configured clock', () => {
  const d = makeDriver();
  // 10 frames/s carrying 10 samples each — a 100 Hz sample clock, keeping up.
  feed(d, { startMs: 1_000_000, count: 21, periodMs: 100, samples: 10 });

  const rx = d.rxRates();
  assert.equal(rx.frameHz, 10);
  assert.equal(rx.sampleHz, 100);
});

test('a link running at half rate reports half, not the nameplate', () => {
  const d = makeDriver();
  d.performance = { sample_rate_hz: 100 };
  feed(d, { startMs: 1_000_000, count: 11, periodMs: 200, samples: 10 });

  d.connected = true;
  const status = d.status;
  assert.equal(status.rxSampleHz, 50);
  assert.equal(status.rxFrameHz, 5);
  // The configured clock is still reported, so the header can name the gap.
  assert.equal(status.sampleClockHz, 100);
});

test('short reads lower the rate, because that is what a starved DAQ does', () => {
  const d = makeDriver();
  // Frames arrive on time but carry 4 samples instead of 10.
  feed(d, { startMs: 1_000_000, count: 21, periodMs: 100, samples: 4 });

  const rx = d.rxRates();
  assert.equal(rx.frameHz, 10);
  assert.equal(rx.sampleHz, 40);
});

test('each card is measured on its own, and the slowest clocked card headlines', () => {
  const d = makeDriver();
  d.performance = { sample_rate_hz: 100, card_rates_hz: { pt: 100, lc: 1612.9 } };
  // PT at 100 Hz, the 9237 coerced to ~1.6 kHz, TC converting every ~300 ms.
  for (let i = 0; i < 21; i++) {
    d.lastFrameAt = 1_000_000 + i * 100;
    d.noteRx({ channels: [
      { card: 'pt', samples: new Array(10).fill(0) },
      { card: 'pt', samples: new Array(10).fill(0) },
      { card: 'lc', samples: new Array(160).fill(0) },
      { card: 'tc', samples: i % 3 === 0 ? [0] : [] },
    ] });
  }
  d.connected = true;
  const rx = d.rxRates();
  assert.equal(rx.cards.pt, 100, 'channels on one card are not summed');
  assert.equal(rx.cards.lc, 1600);
  assert.ok(Math.abs(rx.cards.tc - 3) < 0.6, `tc ${rx.cards.tc}`);
  // The fast 9237 must not stand in for the whole DAQ.
  assert.equal(d.status.rxSampleHz, 100);
  assert.equal(d.status.sampleClockHz, 100);
});

test('frames with no samples report zero, not the frame rate', () => {
  const d = makeDriver();
  for (let i = 0; i < 21; i++) {
    d.lastFrameAt = 1_000_000 + i * 100;
    d.noteRx({ channels: [] });
  }
  d.connected = true;
  assert.equal(d.rxRates().frameHz, 10);
  assert.equal(d.status.rxSampleHz, 0);
});

test('a stalled PT card shows even while the load cells stream', () => {
  const d = makeDriver();
  for (let i = 0; i < 21; i++) {
    d.lastFrameAt = 1_000_000 + i * 100;
    d.noteRx({ channels: [
      { card: 'pt', samples: [] },
      { card: 'lc', samples: new Array(160).fill(0) },
    ] });
  }
  assert.equal(d.rxRates().sampleHz, 0);
  assert.equal(d.rxRates().headCard, 'pt');
});

test('thermocouples headline only when nothing clocked is reporting', () => {
  const d = makeDriver();
  for (let i = 0; i < 21; i++) {
    d.lastFrameAt = 1_000_000 + i * 100;
    d.noteRx({ channels: [{ card: 'tc', samples: i % 4 === 0 ? [0] : [] }] });
  }
  d.connected = true;
  assert.equal(d.status.rxSampleHz, 2.5);
  // The 9211 has no sample clock, so there is no nameplate to fall short of.
  assert.equal(d.status.sampleClockHz, null);
});

test('the window forgets old frames, so a rate that drops is seen dropping', () => {
  const d = makeDriver();
  feed(d, { startMs: 1_000_000, count: 21, periodMs: 100, samples: 10 });
  assert.equal(d.rxRates().sampleHz, 100);

  // Ten seconds later the link comes back at a quarter rate. The earlier
  // fast frames are long outside the window and must not prop the number up.
  feed(d, { startMs: 1_011_000, count: 13, periodMs: 400, samples: 10 });
  assert.equal(d.rxRates().sampleHz, 25);
});

test('no rate is claimed from a single frame', () => {
  const d = makeDriver();
  feed(d, { startMs: 1_000_000, count: 1, periodMs: 100, samples: 10 });
  assert.equal(d.rxRates(), null);

  // Nor from a span too short to divide by without amplifying the jitter.
  feed(d, { startMs: 1_000_100, count: 2, periodMs: 100, samples: 10 });
  assert.equal(d.rxRates(), null);
});

test('a disconnected device reports no rate at all', () => {
  const d = makeDriver();
  feed(d, { startMs: 1_000_000, count: 21, periodMs: 100, samples: 10 });
  d.connected = false;

  // The last measurement is still in the window, but printing it beside
  // "NO LINK" would be a rate for a link that is not delivering anything.
  assert.equal(d.status.rxSampleHz, null);
  assert.equal(d.status.rxFrameHz, null);
});

// ------------------------------------------------------------- link state --

/** Push one telemetry line through the real stdout parser. */
function frame(driver, channels) {
  driver.onStdout(JSON.stringify({ type: 'data', channels }) + '\n');
}

function withEvents(d) {
  d.events = [];
  d.onEvent = (message, level) => d.events.push({ message, level });
  return d;
}

test('frames that carry no samples do not make the DAQ connected', () => {
  const d = withEvents(makeDriver());
  frame(d, []);
  frame(d, [{ card: 'tc', channel: 0, status: 'ok', temp_f: 70, samples: [] }]);
  assert.equal(d.connected, false);
  assert.equal(d.lastRxAt, 0, 'the header ages from the last DATA, not the last frame');

  frame(d, [{ card: 'pt', channel: 2, status: 'ok', pressure_psi: 10, samples: [0.01] }]);
  assert.equal(d.connected, true);
});

test('data stopping while frames keep coming is reported as a disconnect', () => {
  const d = withEvents(makeDriver());
  frame(d, [{ card: 'pt', channel: 2, status: 'ok', pressure_psi: 10, samples: [0.01] }]);
  const t0 = d.lastRxAt;

  // The sidecar is still talking, just with nothing in it.
  d.lastFrameAt = t0 + 2500;
  d.checkData(t0 + 2500);
  assert.equal(d.connected, false);
  assert.match(d.status.lostReason, /no card is returning samples/);
  assert.match(d.status.detail, /NO DATA/);
  assert.equal(d.events.length, 1);
  assert.equal(d.events[0].level, 'error');
  assert.match(d.events[0].message, /DISCONNECTED/);

  // The loss is logged once, not on every watchdog pass.
  d.checkData(t0 + 5000);
  assert.equal(d.events.length, 1);

  frame(d, [{ card: 'pt', channel: 2, status: 'ok', pressure_psi: 10, samples: [0.01] }]);
  assert.equal(d.connected, true);
  assert.equal(d.status.lostReason, null);
  assert.match(d.events.at(-1).message, /restored/);
});

test('a silent sidecar is told apart from silent cards', () => {
  const d = withEvents(makeDriver());
  frame(d, [{ card: 'pt', channel: 2, status: 'ok', pressure_psi: 10, samples: [0.01] }]);
  d.checkData(d.lastRxAt + 2500);
  assert.match(d.status.lostReason, /stopped responding/);
});

test('waitingSince is reported only until the first data arrives', () => {
  const d = withEvents(makeDriver());
  d.startedAt = 1_000_000;
  assert.equal(d.status.waitingSince, 1_000_000);

  frame(d, [{ card: 'pt', channel: 2, status: 'ok', pressure_psi: 10, samples: [0.01] }]);
  assert.equal(d.status.waitingSince, null);

  // Losing the link later ages from the last data, not from startup.
  d.checkData(d.lastRxAt + 2500);
  assert.equal(d.status.waitingSince, null);
});
