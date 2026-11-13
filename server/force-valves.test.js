import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config-store.js';
import { StandController } from './state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function controller(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc4-force-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, 'config/stand.json'), path.join(dir, 'stand.json'));
  const sent = [];
  const driver = {
    status: { name: 'fake', detail: 'fake' },
    async init() {}, async close() {},
    setValve(valve, state) { sent.push(`${valve.id}:${state}`); },
    read() { return {}; },
  };
  const stand = new StandController(new ConfigStore(path.join(dir, 'stand.json')), driver, dir);
  return { stand, sent };
}

test('forceValves sets valves past ARM and ABORT, which a plain command cannot', (t) => {
  const { stand, sent } = controller(t);
  stand.armed = false;
  assert.equal(stand.commandValve('SV-LOXBB', 'open').ok, false, 'needs ARM by hand');
  stand.abortState = { active: true, reason: 'test' };
  const failures = stand.forceValves([{ valve: 'SV-LOXBB', state: 'open' }, { valve: 'SV-LOXV', state: 'closed' }], 'test');
  assert.deepEqual(failures, []);
  assert.equal(stand.valveStates['SV-LOXBB'], 'open');
  assert.equal(stand.valveStates['SV-LOXV'], 'closed');
  assert.ok(sent.includes('SV-LOXBB:open') && sent.includes('SV-LOXV:closed'));
});

test('forceValves turns off a loop that holds a chosen valve before setting it', (t) => {
  const { stand } = controller(t);
  const turnedOff = [];
  const valve = stand.config.bangbang[0].valve;
  stand.bangbang.ownedValves = () => new Map([[valve, stand.config.bangbang[0]]]);
  stand.bangbang.set = (id, patch) => { turnedOff.push([id, patch.enabled]); return { ok: true }; };
  stand.forceValves([{ valve, state: 'closed' }], 'test');
  assert.deepEqual(turnedOff, [[stand.config.bangbang[0].id, false]]);
  assert.equal(stand.valveStates[valve], 'closed');
});

test('bang-bang entries turn loops off first and on last, around the valves', (t) => {
  const { stand, sent } = controller(t);
  const [a, b] = stand.config.bangbang;
  const order = [];
  stand.bangbang.set = (id, patch) => { order.push(`${id} ${patch.enabled ? 'on' : 'off'}`); return { ok: true }; };
  const realCommand = stand.commandValve.bind(stand);
  stand.commandValve = (id, state, opts) => { order.push(`${id} ${state}`); return realCommand(id, state, opts); };
  const failures = stand.forceValves([
    { bangbang: a.id, enabled: true },
    { valve: 'SV-LOXV', state: 'closed' },
    { bangbang: b.id, enabled: false },
  ], 'test');
  assert.deepEqual(failures, []);
  assert.deepEqual(order, [`${b.id} off`, 'SV-LOXV closed', `${a.id} on`]);
  assert.ok(!sent.some((x) => x.startsWith(`${a.valve}:`)), 'the enabled loop valve is not commanded by hand');
  stand.bangbang.set = () => ({ ok: false, error: 'requires ARM' });
  assert.match(stand.forceValves([{ bangbang: a.id, enabled: true }], 'test')[0], /not turned on — requires ARM/);
});
