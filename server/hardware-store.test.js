/**
 * Tests for finding and writing the wiring file, and for swapping the
 * hardware driver under a running controller.
 *
 *   node --test server/hardware-store.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HardwareStore, resolveHardwarePath } from './hardware-store.js';
import { ConfigStore } from './config-store.js';
import { StandController } from './state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc4-hw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('each stand finds its own wiring file', () => {
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  assert.equal(rel(resolveHardwarePath({ root: ROOT, standName: 'Draco' })), 'config/hardware.json');
  // config/hardware.json says it is Draco's, so MOE must not be handed it.
  assert.equal(rel(resolveHardwarePath({ root: ROOT, standName: 'MOE' })), 'config/hardware-moe.json');
  assert.equal(resolveHardwarePath({ root: ROOT, standName: 'Nobody' }), null);
  assert.equal(rel(resolveHardwarePath({ root: ROOT, explicit: 'config/hardware-moe.json', standName: 'Draco' })),
    'config/hardware-moe.json');
});

test('a save backs the file up and keeps its comments', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'hardware.json');
  fs.copyFileSync(path.join(ROOT, 'config/hardware.json'), file);
  const store = new HardwareStore(file);
  const next = structuredClone(store.hardware);
  next.nidaq.channelMap.pt0 = 'PT5';
  assert.equal(store.differs(next), true);
  store.save(next);

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.nidaq.channelMap.pt0, 'PT5');
  assert.ok(Array.isArray(written._comment) && written._comment.length > 5);
  assert.ok(written.nidaq.cards.lc._channelMeta, 'nested comment blocks survive');
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  assert.equal(store.differs(next), false);
});

/** Records what happened to it, in order, into a shared log. */
function fakeDriver(name, log, { failInit = false } = {}) {
  return {
    status: { name, detail: 'fake' },
    async init() { log.push(`${name}.init`); if (failInit) throw new Error(`${name} would not open`); },
    async close() { log.push(`${name}.close`); },
    setValve(valve, state) { log.push(`${name}.setValve ${valve.id} ${state}`); },
    read() { return {}; },
  };
}

function controller(t, driver) {
  const dir = tempDir(t);
  fs.copyFileSync(path.join(ROOT, 'config/stand.json'), path.join(dir, 'stand.json'));
  return new StandController(new ConfigStore(path.join(dir, 'stand.json')), driver, dir);
}

test('a driver swap closes the old one before opening the new, then safes every valve on it', async (t) => {
  const log = [];
  const stand = controller(t, fakeDriver('old', log));
  await stand.replaceDriver(fakeDriver('new', log), 'test');

  assert.deepEqual(log.slice(0, 2), ['old.close', 'new.init']);
  assert.equal(stand.driver.status.name, 'new');
  const safed = log.filter((l) => l.startsWith('new.setValve'));
  assert.equal(safed.length, stand.config.valves.length);
  assert.ok(!log.some((l) => l.startsWith('old.setValve')));
  assert.equal(stand.rewiring, false);
});

test('a driver that will not start is closed again and reported', async (t) => {
  const log = [];
  const stand = controller(t, fakeDriver('old', log));
  await assert.rejects(stand.replaceDriver(fakeDriver('bad', log, { failInit: true }), 'test'), /would not open/);
  assert.deepEqual(log, ['old.close', 'bad.init', 'bad.close']);
  assert.equal(stand.rewiring, false);
});

test('valve commands are refused while the hardware is reconnecting', (t) => {
  const stand = controller(t, fakeDriver('old', []));
  stand.rewiring = true;
  const valve = stand.config.valves.find((v) => !v.requiresArm) ?? stand.config.valves[0];
  const res = stand.commandValve(valve.id, valve.safeState, { internal: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /reconnecting/);
});
