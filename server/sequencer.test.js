import test from 'node:test';
import assert from 'node:assert/strict';
import { Sequencer } from './sequencer.js';
import { PandaDriver } from './hal/panda.js';
import { CompositeDriver } from './hal/composite.js';

function fixture(composite = false) {
  const panda = new PandaDriver();
  const sent = [];
  panda.port = { writable: true, write: (line) => sent.push(line.trim()) };
  panda.onLine('p0.188');
  const cfg = { id: 'test', name: 'Test', usePandaAutosequencer: true, requiresArm: true,
    duration: 1, abortConditions: [], steps: [
      { t: 0, action: 'valve', target: 'V1', state: 'open' },
      { t: 1, action: 'valve', target: 'V1', state: 'closed' },
    ] };
  const valve = { id: 'V1', channel: 1, safeState: 'closed' };
  const driver = composite ? new CompositeDriver({ devices: [{ key: 'panda', driver: panda, actuates: true }] }) : panda;
  const stand = {
    driver, armed: true, abortState: { active: false }, config: { valves: [valve], safety: {} },
    configStore: { sequence: (id) => id === cfg.id ? cfg : null, valve: () => valve },
    bangbang: { ownedValves: () => new Map() }, valveStates: {}, valveMeta: {},
    log() {}, emit() {}, commandValve() { throw new Error('GC must not replay Panda valve steps'); },
    setArmed(armed) { this.armed = armed; driver.setArmed(armed); },
    safeAll() { driver.safeAll(); },
    abort(reason) { this.abortState = { active: true, reason }; this.sequencer.stop(reason); },
  };
  const seq = stand.sequencer = new Sequencer(stand);
  async function upload() {
    const result = seq.sendToPanda('test');
    const command = sent.at(-1);
    panda.onLine(`SEQ_ACK:count=${command.split(',').length},raw=${command}`);
    assert.equal((await result).ok, true);
    return command;
  }
  return { seq, panda, stand, sent, cfg, upload };
}

test('upload requires the complete matching firmware echo, and changed configs cannot run', async () => {
  const { seq, panda, cfg, sent, upload } = fixture();
  assert.equal(seq.start('test').ok, false);
  assert.equal(sent.length, 0);
  const pending = seq.sendToPanda('test');
  assert.equal(seq.start('test').ok, false);
  panda.onLine('SEQ_ACK:count=1,raw=s11.00000');
  assert.equal((await pending).ok, false);
  await upload();
  cfg.steps[1].t = 2;
  assert.equal(seq.start('test').ok, false);
  assert.ok(!sent.includes('f'));
});

for (const composite of [false, true]) test(`Panda runs through ${composite ? 'composite' : 'direct'} driver; board reports own progress`, async () => {
  const { seq, panda, stand, sent, upload } = fixture(composite);
  const command = await upload();
  assert.equal(seq.start('test').ok, true);
  assert.equal(sent.at(-1), 'f');
  seq.update({}, Date.now() + 1500);
  assert.equal(seq.running, true, 'elapsed duration is not completion');
  assert.equal(seq.snapshot().step, 0);
  panda.onLine(`SEQ_EXEC_START:count=2,raw=${command}`);
  panda.onLine('SEQ_STEP:index=0,chan=1,state=ON,duration=1000');
  seq.update({}, Date.now());
  assert.equal(stand.valveStates.V1, 'open');
  assert.equal(seq.snapshot().step, 1);
  panda.onLine('SEQ_EXEC_COMPLETE');
  seq.update({}, Date.now());
  assert.equal(seq.running, false);
  assert.equal(stand.valveStates.V1, 'closed');
  assert.deepEqual(sent, [command, 'f']);
});

test('stop disarms and cancels on Panda; uploads during execution are refused', async () => {
  const { seq, stand, sent, upload } = fixture();
  await upload();
  seq.start('test');
  assert.equal((await seq.sendToPanda('test')).ok, false);
  assert.equal(seq.stop().ok, true);
  assert.equal(stand.armed, false);
  assert.ok(sent.includes('r'));
});

test('firmware errors, missing start acknowledgment and stale telemetry abort the run', async () => {
  for (const fault of ['error', 'start-timeout', 'link']) {
    const { seq, panda, stand, upload } = fixture();
    await upload();
    seq.start('test');
    if (fault === 'error') panda.onLine('SEQ_ERROR: No sequence loaded');
    if (fault === 'link') panda.lastRxAt = Date.now() - 3000;
    seq.update({}, Date.now() + (fault === 'start-timeout' ? 3100 : 0));
    assert.equal(stand.abortState.active, true, fault);
    assert.equal(seq.running, false);
  }
});

test('ARM and bang-bang ownership guard board execution', async () => {
  const { seq, stand, sent, upload } = fixture();
  await upload();
  stand.armed = false;
  assert.equal(seq.start('test').ok, false);
  stand.armed = true;
  stand.bangbang.ownedValves = () => new Map([['V1', {}]]);
  assert.equal(seq.start('test').ok, false);
  assert.ok(!sent.includes('f'));
});

test('a reconnected Panda needs another confirmed upload', async () => {
  const { seq, panda, upload } = fixture();
  await upload();
  panda.lastRxAt = Date.now() - 3000;
  panda.onLine('p0.188');
  assert.equal(seq.start('test').ok, false);
});

test('abort conditions stay active while Panda owns the timeline', async () => {
  const { seq, stand, cfg, sent, upload } = fixture();
  cfg.abortConditions = [{ sensor: 'PT1', op: '>', value: 100 }];
  await upload();
  seq.start('test');
  seq.update({ PT1: 150 }, Date.now());
  assert.equal(stand.abortState.active, true);
  assert.equal(seq.running, false);
  assert.ok(sent.includes('r'));
});

test('failed serial writes do not leave Panda stuck in the starting state', async () => {
  const { seq, panda, upload } = fixture();
  await upload();
  panda.port.writable = false;
  assert.equal(seq.start('test').ok, false);
  assert.equal(panda.sequenceStatus().phase, 'idle');
  assert.equal(seq.running, false);
});

test('unacknowledged uploads time out without allowing Run', async () => {
  const { seq, panda } = fixture();
  const result = await seq.sendToPanda('test');
  assert.equal(result.ok, false);
  assert.match(result.error, /acknowledge/);
  assert.equal(panda.sequenceStatus().pending, false);
  assert.equal(seq.start('test').ok, false);
});
