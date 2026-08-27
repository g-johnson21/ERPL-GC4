/**
 * Tests for the composite driver's routing and degraded-mode behaviour.
 *
 *   node --test server/hal/composite.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CompositeDriver } from './composite.js';

function fakeDevice(name, { connected = true, actuates = false, readings = {}, failInit = false, lastRxAt = 0 } = {}) {
  return {
    name,
    valves: [],
    safed: 0,
    armed: null,
    closed: false,
    async init() { if (failInit) throw new Error(`${name} unavailable`); },
    setValve(v, s) { this.valves.push(`${v.id}=${s}`); },
    setArmed(a) { this.armed = a; },
    safeAll() { this.safed++; },
    read() { return readings; },
    get status() { return { name, connected, lastRxAt, detail: name }; },
    async close() { this.closed = true; },
  };
}

const CONFIG = { sensors: [], valves: [] };

test('readings from every device are merged', async () => {
  const a = fakeDevice('a', { readings: { 'PT-1': 10 } });
  const b = fakeDevice('b', { readings: { 'PT-2': 20 } });
  const c = new CompositeDriver({
    devices: [{ key: 'a', driver: a }, { key: 'b', driver: b }],
  });
  await c.init(CONFIG);
  assert.deepEqual(c.read(), { 'PT-1': 10, 'PT-2': 20 });
});

test('later devices win on a conflicting sensor id', async () => {
  const a = fakeDevice('a', { readings: { 'PT-1': 10 } });
  const b = fakeDevice('b', { readings: { 'PT-1': 99 } });
  const c = new CompositeDriver({
    devices: [{ key: 'a', driver: a }, { key: 'b', driver: b }],
  });
  await c.init(CONFIG);
  assert.equal(c.read()['PT-1'], 99);
});

test('valves route to the first actuation-capable device by default', async () => {
  const daq = fakeDevice('daq', { actuates: false });
  const panda = fakeDevice('panda', { actuates: true });
  const c = new CompositeDriver({
    devices: [
      { key: 'daq', driver: daq, actuates: false },
      { key: 'panda', driver: panda, actuates: true },
    ],
  });
  await c.init(CONFIG);
  c.setValve({ id: 'SV-FP', channel: 2 }, 'open');
  assert.deepEqual(panda.valves, ['SV-FP=open']);
  assert.deepEqual(daq.valves, []);
});

test('valveDevice overrides routing per valve', async () => {
  const one = fakeDevice('one', { actuates: true });
  const two = fakeDevice('two', { actuates: true });
  const c = new CompositeDriver({
    devices: [
      { key: 'one', driver: one, actuates: true },
      { key: 'two', driver: two, actuates: true },
    ],
    valveDevice: { 'MV-O': 'two' },
  });
  await c.init(CONFIG);
  c.setValve({ id: 'MV-O' }, 'open');
  c.setValve({ id: 'SV-FP' }, 'open');
  assert.deepEqual(two.valves, ['MV-O=open']);
  assert.deepEqual(one.valves, ['SV-FP=open']);
});

test('a valve mapped to an unknown device is an error, not a silent default', async () => {
  const one = fakeDevice('one', { actuates: true });
  const c = new CompositeDriver({
    devices: [{ key: 'one', driver: one, actuates: true }],
    valveDevice: { 'MV-O': 'typo' },
  });
  await c.init(CONFIG);
  assert.throws(() => c.setValve({ id: 'MV-O' }, 'open'), /unknown device "typo"/);
});

test('a failed REQUIRED device aborts startup', async () => {
  const c = new CompositeDriver({
    devices: [{ key: 'daq', driver: fakeDevice('daq', { failInit: true }), required: true }],
  });
  await assert.rejects(() => c.init(CONFIG), /daq: daq unavailable/);
});

test('a failed OPTIONAL device is skipped, not fatal', async () => {
  const bad = fakeDevice('bad', { failInit: true });
  const good = fakeDevice('good', { readings: { 'PT-1': 1 }, actuates: true });
  const c = new CompositeDriver({
    devices: [
      { key: 'bad', driver: bad, required: false },
      { key: 'good', driver: good, required: true, actuates: true },
    ],
  });
  await c.init(CONFIG);
  assert.deepEqual(c.read(), { 'PT-1': 1 });   // failed device is not read
  c.safeAll();
  assert.equal(good.safed, 1);
  assert.equal(bad.safed, 0);
});

test('connected reflects REQUIRED devices only', async () => {
  const up = fakeDevice('up', { connected: true });
  const down = fakeDevice('down', { connected: false });

  const optionalDown = new CompositeDriver({
    devices: [
      { key: 'up', driver: up, required: true },
      { key: 'down', driver: down, required: false },
    ],
  });
  await optionalDown.init(CONFIG);
  assert.equal(optionalDown.status.connected, true);

  const requiredDown = new CompositeDriver({
    devices: [
      { key: 'up', driver: up, required: true },
      { key: 'down', driver: down, required: true },
    ],
  });
  await requiredDown.init(CONFIG);
  assert.equal(requiredDown.status.connected, false);
  assert.match(requiredDown.status.detail, /down:DOWN/);
});

test('one device refusing to safe does not stop the others', async () => {
  const bad = fakeDevice('bad', { actuates: true });
  bad.safeAll = () => { throw new Error('port closed'); };
  const good = fakeDevice('good', { actuates: true });
  const c = new CompositeDriver({
    devices: [{ key: 'bad', driver: bad }, { key: 'good', driver: good }],
  });
  await c.init(CONFIG);
  c.safeAll();                       // must not throw
  assert.equal(good.safed, 1);
});

test('arm state is mirrored to every device that tracks it', async () => {
  const a = fakeDevice('a');
  const b = fakeDevice('b');
  const c = new CompositeDriver({
    devices: [{ key: 'a', driver: a }, { key: 'b', driver: b }],
  });
  await c.init(CONFIG);
  c.setArmed(true);
  assert.equal(a.armed, true);
  assert.equal(b.armed, true);
});

test('close shuts down every device', async () => {
  const a = fakeDevice('a');
  const b = fakeDevice('b');
  const c = new CompositeDriver({
    devices: [{ key: 'a', driver: a }, { key: 'b', driver: b }],
  });
  await c.init(CONFIG);
  await c.close();
  assert.ok(a.closed && b.closed);
});

test('status carries per-device link state for the header indicators', async () => {
  // "composite: DOWN" sends an operator to the wrong rack. The DAQ and the
  // valve board fail for different reasons and are fixed in different places,
  // so the UI has to be told which one went quiet, and when it last spoke.
  const daq = fakeDevice('nidaq', { connected: true, lastRxAt: 1_000_000 });
  const panda = fakeDevice('panda', { connected: false, actuates: true, lastRxAt: 990_000 });
  const c = new CompositeDriver({
    devices: [
      { key: 'nidaq', driver: daq, required: true },
      { key: 'panda', driver: panda, required: true, actuates: true },
    ],
  });
  await c.init(CONFIG);

  const { devices } = c.status;
  assert.deepEqual(devices.map((d) => d.key), ['nidaq', 'panda']);
  assert.deepEqual(devices.map((d) => d.connected), [true, false]);
  assert.deepEqual(devices.map((d) => d.lastRxAt), [1_000_000, 990_000]);
  assert.equal(devices.every((d) => d.required), true);
  // The composite's own lastRxAt is the most recent of any device.
  assert.equal(c.status.lastRxAt, 1_000_000);
});

test('a device that has never sent anything reports lastRxAt 0, not a guess', async () => {
  // 0 is how the UI tells "never came up" from "dropped a moment ago"; a
  // defaulted timestamp would render a dead board as freshly stale.
  const silent = fakeDevice('panda', { connected: false });
  delete silent.status;
  Object.defineProperty(silent, 'status', {
    get: () => ({ name: 'panda', connected: false, detail: 'no port' }),   // no lastRxAt at all
  });
  const c = new CompositeDriver({ devices: [{ key: 'panda', driver: silent, required: true }] });
  await c.init(CONFIG);

  assert.equal(c.status.devices[0].lastRxAt, 0);
});

test('a tare is routed to the device that measures the sensor', async () => {
  // Split responsibilities are the whole reason this driver exists: the DAQ
  // can zero its channels, the valve board cannot. A tare must reach the one
  // that can, and must not be reported as done by the one that cannot.
  const daq = fakeDevice('nidaq');
  daq.tareSensors = (ids) => {
    const mine = ids.filter((id) => id.startsWith('PT'));
    daq.tareCalls = (daq.tareCalls || []).concat([mine]);
    return { ok: true, tared: mine, unsupported: ids.filter((id) => !mine.includes(id)) };
  };
  daq.tareStatus = () => ({ 'PT-1': 4.5 });

  const panda = fakeDevice('panda', { actuates: true });   // no tare support
  const c = new CompositeDriver({
    devices: [{ key: 'nidaq', driver: daq }, { key: 'panda', driver: panda, actuates: true }],
  });
  await c.init(CONFIG);

  const res = c.tareSensors(['PT-1', 'DC-3'], { clear: false });
  assert.deepEqual(daq.tareCalls, [['PT-1']]);
  assert.deepEqual(res.tared, ['PT-1']);
  assert.deepEqual(res.unsupported, ['DC-3'], 'a sensor nothing can zero says so');
  assert.deepEqual(c.tareStatus(), { 'PT-1': 4.5 });
});

test('a sensor two devices read is tared once, by the first that owns it', async () => {
  const first = fakeDevice('first');
  const second = fakeDevice('second');
  for (const dev of [first, second]) {
    dev.seen = [];
    dev.tareSensors = (ids) => { dev.seen.push(...ids); return { ok: true, tared: ids, unsupported: [] }; };
  }
  const c = new CompositeDriver({
    devices: [{ key: 'first', driver: first }, { key: 'second', driver: second }],
  });
  await c.init(CONFIG);

  c.tareSensors(['PT-1']);
  assert.deepEqual(first.seen, ['PT-1']);
  assert.deepEqual(second.seen, [], 'never offered an id already claimed');
});

test('a device that cannot reach its hardware fails the tare', async () => {
  const daq = fakeDevice('nidaq');
  daq.tareSensors = () => ({ ok: false, error: 'acquisition is not running', tared: [], unsupported: [] });
  const c = new CompositeDriver({ devices: [{ key: 'nidaq', driver: daq }] });
  await c.init(CONFIG);

  const res = c.tareSensors(['PT-1']);
  assert.equal(res.ok, false);
  assert.match(res.error, /nidaq: acquisition is not running/);
});
