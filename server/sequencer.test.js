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

// ---------------------------------------------------------------- gates ---

function gateFixture(steps, more = []) {
  const valves = ['V1', 'V2', 'V3'].map((id) => ({ id, safeState: 'closed' }));
  const cfg = { id: 'fire', name: 'Fire', requiresArm: true, abortConditions: [], steps };
  const safe = { id: 'safe', name: 'Safe', requiresArm: false, abortConditions: [], steps: [
    { t: 0, action: 'valve', target: 'V3', state: 'open' }] };
  const abortSeq = { id: 'abort', name: 'Abort', requiresArm: false, abortConditions: [], steps: [
    { t: 0, action: 'safeAll' }] };
  const seqs = [cfg, safe, abortSeq, ...more];
  const logs = [];
  const commanded = [];
  const stand = {
    driver: {}, armed: true, abortState: { active: false }, config: { valves, safety: { abortSequenceId: 'abort' } },
    configStore: { sequence: (id) => seqs.find((s) => s.id === id) },
    bangbang: { ownedValves: () => new Map() }, valveStates: {}, valveMeta: {},
    log(kind, msg) { logs.push(`${kind}: ${msg}`); }, emit() {},
    commandValve(id, state) { commanded.push(`${id}:${state}`); return { ok: true }; },
    safeAll() { commanded.push('safeAll'); },
    forceValves(list) { for (const { valve, state } of list) commanded.push(`force ${valve}:${state}`); return []; },
    abort(reason) {
      if (this.abortState.active) return;
      this.abortState = { active: true, reason };
      if (this.sequencer.running) this.sequencer.stop('abort', 'abort');
      this.sequencer.start('abort', 'abort');
    },
  };
  const seq = stand.sequencer = new Sequencer(stand);
  return { seq, stand, logs, commanded, cfg };
}

const LOX_OPEN = { t: 0, action: 'valve', target: 'V1', state: 'open' };
const FUEL_OPEN = { t: 0.5, action: 'valve', target: 'V2', state: 'open' };

test('a passing gate lets the sequence run on', () => {
  const { seq, commanded, logs } = gateFixture([LOX_OPEN,
    { t: 0.2, action: 'gate', conditions: [{ sensor: 'PT1', op: 'between', min: 10, max: 20 }], onFail: 'abort' },
    FUEL_OPEN]);
  assert.equal(seq.start('fire').ok, true);
  const t0 = seq.active.startedAt;
  seq.update({ PT1: 15 }, t0);
  seq.update({ PT1: 15 }, t0 + 250);
  seq.update({ PT1: 15 }, t0 + 600);
  assert.deepEqual(commanded, ['V1:open', 'V2:open']);
  assert.ok(logs.some((l) => l.includes('GATE PASS')));
  assert.equal(seq.running, false, 'completes');
});

test('a gate out of range runs its fail sequence and nothing after it', () => {
  const { seq, stand, commanded, logs } = gateFixture([LOX_OPEN,
    { t: 0.2, action: 'gate', conditions: [{ sensor: 'PT1', op: '>', value: 100 }], onFail: 'sequence', failSequence: 'safe' },
    FUEL_OPEN]);
  seq.start('fire');
  const t0 = seq.active.startedAt;
  seq.update({ PT1: 50 }, t0);
  seq.update({ PT1: 50 }, t0 + 250);
  assert.equal(seq.active?.cfg.id, 'safe');
  seq.update({ PT1: 50 }, t0 + 260);
  assert.deepEqual(commanded, ['V1:open', 'V3:open'], 'fuel never opens; the fail sequence ran');
  assert.equal(stand.abortState.active, false);
  assert.ok(logs.some((l) => l.startsWith('error:') && l.includes('GATE FAIL') && l.includes('PT1=50.0')));
});

test('a blocking gate holds the clock until it passes; later steps slip', () => {
  const { seq, commanded } = gateFixture([LOX_OPEN,
    { t: 0.2, action: 'gate', conditions: [{ sensor: 'PT1', op: '>=', value: 100 }], timeout: 2 },
    FUEL_OPEN]);
  seq.start('fire');
  const t0 = seq.active.startedAt;
  seq.update({ PT1: 0 }, t0);
  seq.update({ PT1: 0 }, t0 + 200);
  seq.update({ PT1: 0 }, t0 + 1000);
  assert.ok(seq.snapshot().hold, 'reports the hold');
  assert.deepEqual(commanded, ['V1:open'], 'fuel waits for the gate');
  seq.update({ PT1: 120 }, t0 + 1200);      // passes; 1.0 s held
  seq.update({ PT1: 120 }, t0 + 1400);      // seq time 0.4
  assert.deepEqual(commanded, ['V1:open']);
  seq.update({ PT1: 120 }, t0 + 1550);      // seq time 0.55
  assert.deepEqual(commanded, ['V1:open', 'V2:open']);
});

test('a gate that never comes good within its timeout aborts by default', () => {
  const { seq, stand, commanded } = gateFixture([LOX_OPEN,
    { t: 0, action: 'gate', conditions: [{ sensor: 'PT1', op: '<', value: 5 }], timeout: 0.5 },
    FUEL_OPEN]);
  seq.start('fire');
  const t0 = seq.active.startedAt;
  seq.update({ PT1: 9 }, t0);
  seq.update({ PT1: 9 }, t0 + 400);
  assert.equal(stand.abortState.active, false, 'still inside the timeout');
  seq.update({ PT1: 9 }, t0 + 500);
  assert.equal(stand.abortState.active, true);
  assert.equal(seq.active?.cfg.id, 'abort');
  seq.update({}, t0 + 510);
  assert.deepEqual(commanded, ['V1:open', 'safeAll'], 'old steps are not replayed under the abort sequence');
});

test('hold requires the condition unbroken; a missing reading never passes', () => {
  const { seq, stand } = gateFixture([
    { t: 0, action: 'gate', conditions: [{ sensor: 'PT1', op: '>', value: 10 }], timeout: 1, hold: 0.3, onFail: 'stop' },
    FUEL_OPEN]);
  seq.start('fire');
  const t0 = seq.active.startedAt;
  seq.update({ PT1: 20 }, t0);
  seq.update({}, t0 + 200);                // dropout breaks the streak
  seq.update({ PT1: 20 }, t0 + 300);
  seq.update({ PT1: 20 }, t0 + 500);
  assert.ok(seq.snapshot().hold, 'not yet held 0.3 s');
  seq.update({ PT1: 20 }, t0 + 600);
  assert.equal(seq.snapshot().hold, null, 'passed');
  assert.equal(stand.abortState.active, false);
});

test('any/all, outside, continue and non-blocking gates', () => {
  const { seq, commanded, stand, logs } = gateFixture([LOX_OPEN,
    { t: 0, action: 'gate', match: 'any', blocking: false, timeout: 0, onFail: 'continue',
      conditions: [{ sensor: 'PT1', op: 'outside', min: 0, max: 10 }, { sensor: 'PT2', op: '<', value: 0 }] },
    FUEL_OPEN]);
  seq.start('fire');
  const t0 = seq.active.startedAt;
  seq.update({ PT1: 5, PT2: 5 }, t0);
  seq.update({ PT1: 5, PT2: 5 }, t0 + 600);
  assert.deepEqual(commanded, ['V1:open', 'V2:open']);
  assert.equal(stand.abortState.active, false);
  assert.ok(logs.some((l) => l.includes('GATE FAIL') && l.includes('CONTINUE')));
});

test('a fail sequence that cannot start falls back to ABORT', () => {
  const locked = { id: 'locked', name: 'Locked', requiresArm: true, abortConditions: [], steps: [] };
  const { seq, stand } = gateFixture([
    { t: 0, action: 'gate', conditions: [{ sensor: 'PT1', op: '>', value: 1 }], onFail: 'sequence', failSequence: 'locked' }], [locked]);
  seq.start('fire');
  stand.armed = false;
  seq.update({ PT1: 0 }, seq.active.startedAt);
  assert.equal(stand.abortState.active, true);
});

// ---------------------------------------------------------- gated valves ---

test('a gated valve opens only once its conditions are met, and the clock waits', () => {
  const { seq, commanded, logs } = gateFixture([LOX_OPEN,
    { t: 0.2, action: 'valve', target: 'V2', state: 'open',
      gate: { conditions: [{ sensor: 'PT1', op: '>', value: 100 }], timeout: 1 } },
    { t: 0.5, action: 'valve', target: 'V3', state: 'open' }]);
  seq.start('fire');
  const t0 = seq.active.startedAt;
  seq.update({ PT1: 0 }, t0);
  seq.update({ PT1: 0 }, t0 + 200);
  seq.update({ PT1: 0 }, t0 + 700);
  assert.deepEqual(commanded, ['V1:open'], 'V2 waits on its gate; V3 waits behind it');
  assert.match(seq.snapshot().hold.label, /V2 OPEN/);
  seq.update({ PT1: 150 }, t0 + 800);
  assert.deepEqual(commanded, ['V1:open', 'V2:open']);
  seq.update({ PT1: 150 }, t0 + 1050);     // seq time 0.45
  assert.deepEqual(commanded, ['V1:open', 'V2:open']);
  seq.update({ PT1: 150 }, t0 + 1150);
  assert.deepEqual(commanded, ['V1:open', 'V2:open', 'V3:open']);
  assert.ok(logs.some((l) => l.includes('before V2 OPEN')));
});

test('a gated valve whose gate fails is never actuated; the fail sequence runs', () => {
  const { seq, commanded, logs } = gateFixture([LOX_OPEN,
    { t: 0, action: 'valve', target: 'V2', state: 'open',
      gate: { conditions: [{ sensor: 'PT1', op: '>', value: 100 }], onFail: 'sequence', failSequence: 'safe' } }]);
  seq.start('fire');
  seq.update({ PT1: 5 }, seq.active.startedAt);
  assert.equal(seq.active?.cfg.id, 'safe');
  seq.update({ PT1: 5 }, seq.active.startedAt + 10);
  assert.deepEqual(commanded, ['V1:open', 'V3:open']);
  assert.ok(logs.some((l) => l.includes('V2 OPEN NOT DONE')));
});

test('continue skips a failed gated valve; a later step supersedes a waiting one', () => {
  const { seq, commanded, logs } = gateFixture([
    { t: 0, action: 'valve', target: 'V1', state: 'open',
      gate: { conditions: [{ sensor: 'PT1', op: '>', value: 1 }], onFail: 'continue' } },
    { t: 0, action: 'valve', target: 'V2', state: 'open',
      gate: { conditions: [{ sensor: 'PT1', op: '>', value: 1 }], timeout: 5, blocking: false } },
    { t: 0.5, action: 'valve', target: 'V2', state: 'closed' }]);
  seq.start('fire');
  const t0 = seq.active.startedAt;
  seq.update({ PT1: 0 }, t0);
  seq.update({ PT1: 0 }, t0 + 600);
  seq.update({ PT1: 9 }, t0 + 700);
  assert.deepEqual(commanded, ['V2:closed'], 'V1 skipped; the pending V2 open was dropped, not fired late');
  assert.ok(logs.some((l) => l.includes('GATE DROPPED')));
  assert.equal(seq.running, false);
});

test('setValves forces the chosen valves, then stops — or carries on with failStop false', () => {
  for (const failStop of [undefined, false]) {
    const { seq, commanded, stand } = gateFixture([
      { t: 0, action: 'valve', target: 'V1', state: 'open',
        gate: { conditions: [{ sensor: 'PT1', op: '>', value: 1 }], onFail: 'setValves', failStop,
          failValves: [{ valve: 'V2', state: 'closed' }, { valve: 'V3', state: 'open' }] } },
      { t: 0.5, action: 'valve', target: 'V2', state: 'open' }]);
    seq.start('fire');
    const t0 = seq.active.startedAt;
    seq.update({ PT1: 0 }, t0);
    seq.update({ PT1: 0 }, t0 + 600);
    const expect = ['force V2:closed', 'force V3:open'];
    if (failStop === false) expect.push('V2:open');
    assert.deepEqual(commanded, expect, `failStop ${failStop}`);
    assert.equal(stand.abortState.active, false);
    assert.equal(seq.running, false);
  }
});
