/**
 * Tests for Draco's GOX purge controller.
 *
 *   node --test server/gox-purge.test.js
 *
 * What matters most: starting an autosequence turns the controller off and
 * closes PB6 BEFORE the sequence can run, and a PB6 that will not close stops
 * the sequence from starting at all. The fixture uses the real Sequencer, so
 * that is asserted through Sequencer.start rather than against a stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GoxPurge, GOX_VALVE, GOX_SENSOR } from './gox-purge.js';
import { Sequencer } from './sequencer.js';

const SETTINGS = { openAt: -250, closeAt: -280, maxOpenMs: 3000, dwellMs: 2000 };

function fixture({ t = -290 } = {}) {
  const valve = { id: GOX_VALVE, name: 'GOX Purge', safeState: 'closed' };
  const sequences = {
    'seq-hotfire': { id: 'seq-hotfire', name: 'HOT FIRE', requiresArm: true, abortConditions: [], steps: [] },
    'seq-abort': { id: 'seq-abort', name: 'ABORT', requiresArm: false, abortConditions: [], steps: [] },
  };
  const commands = [];
  const stand = {
    armed: true,
    abortState: { active: false },
    readings: { [GOX_SENSOR]: t },
    valveStates: { [GOX_VALVE]: 'closed' },
    failClose: false,
    config: { sensors: [{ id: GOX_SENSOR, kind: 'temperature' }], valves: [valve], safety: { abortSequenceId: 'seq-abort' } },
    configStore: {
      valve: (id) => (id === GOX_VALVE ? valve : null),
      sequence: (id) => sequences[id] || null,
    },
    driver: {},
    bangbang: { ownedValves: () => new Map() },
    commandValve(id, state, opts = {}) {
      if (state === 'closed' && this.failClose) return { ok: false, error: 'driver fault' };
      if (state === 'open' && (!this.armed || this.abortState.active)) return { ok: false, error: 'interlock' };
      commands.push({ id, state, source: opts.source });
      this.valveStates[id] = state;
      return { ok: true };
    },
    log() {}, emit() {}, snapshot() { return {}; },
  };
  stand.sequencer = new Sequencer(stand);
  stand.goxPurge = new GoxPurge(stand);
  return { stand, purge: stand.goxPurge, commands };
}

function on(purge) {
  const res = purge.set({ enable: true, ...SETTINGS });
  assert.equal(res.ok, true, res.error);
}

test('holds PB6 on the Dragon band: open warm, close cold, deadband between', () => {
  const { stand, purge } = fixture();
  on(purge);
  const r = stand.readings;
  purge.update(r, 1000);
  assert.equal(stand.valveStates[GOX_VALVE], 'closed', 'cold: stays closed');

  r[GOX_SENSOR] = -265;   // in the deadband
  purge.update(r, 1100);
  assert.equal(stand.valveStates[GOX_VALVE], 'closed');

  r[GOX_SENSOR] = -248;   // GOX pocket
  purge.update(r, 1200);
  assert.equal(stand.valveStates[GOX_VALVE], 'open');

  r[GOX_SENSOR] = -270;   // cooling, still in the deadband
  purge.update(r, 1500);
  assert.equal(stand.valveStates[GOX_VALVE], 'open');

  r[GOX_SENSOR] = -282;   // liquid back
  purge.update(r, 1800);
  assert.equal(stand.valveStates[GOX_VALVE], 'closed');
  assert.equal(purge.enabled, true);
});

test('max open time closes PB6 and stays on; the dwell holds it closed', () => {
  const { stand, purge } = fixture({ t: -240 });
  on(purge);
  purge.update(stand.readings, 1000);
  assert.equal(stand.valveStates[GOX_VALVE], 'open');
  purge.update(stand.readings, 3999);
  assert.equal(stand.valveStates[GOX_VALVE], 'open');
  purge.update(stand.readings, 4000);
  assert.equal(stand.valveStates[GOX_VALVE], 'closed', 'max open time closes it');
  assert.equal(purge.enabled, true, 'and the controller stays on');

  purge.update(stand.readings, 5999);
  assert.equal(stand.valveStates[GOX_VALVE], 'closed', 'still warm, but dwelling');
  purge.update(stand.readings, 6000);
  assert.equal(stand.valveStates[GOX_VALVE], 'open', 'dwell over, still warm: reopens');
});

test('the dwell follows a temperature close too, but not the first opening', () => {
  const { stand, purge } = fixture({ t: -240 });
  on(purge);
  purge.update(stand.readings, 1000);
  assert.equal(stand.valveStates[GOX_VALVE], 'open', 'first opening does not wait');

  stand.readings[GOX_SENSOR] = -285;
  purge.update(stand.readings, 1500);
  assert.equal(stand.valveStates[GOX_VALVE], 'closed');

  stand.readings[GOX_SENSOR] = -240;
  purge.update(stand.readings, 2000);
  assert.equal(stand.valveStates[GOX_VALVE], 'closed', 'warm again inside the dwell');
  assert.equal(purge.dwellLeft(2000), 1500);
  purge.update(stand.readings, 3500);
  assert.equal(stand.valveStates[GOX_VALVE], 'open');
});

test('starting the hot fire turns the controller off and closes PB6 first', () => {
  const { stand, purge, commands } = fixture({ t: -240 });
  on(purge);
  purge.update(stand.readings, 1000);
  assert.equal(stand.valveStates[GOX_VALVE], 'open');

  const res = stand.sequencer.start('seq-hotfire');
  assert.equal(res.ok, true);
  assert.equal(purge.enabled, false);
  assert.equal(stand.valveStates[GOX_VALVE], 'closed');
  assert.equal(stand.sequencer.running, true);
  assert.deepEqual(commands.at(-1), { id: GOX_VALVE, state: 'closed', source: 'operator' });

  // And it cannot come back on while the sequence runs.
  assert.equal(purge.set({ enable: true }).ok, false);
});

test('a PB6 that will not close stops the hot fire from starting — never the abort', () => {
  const { stand, purge } = fixture();
  on(purge);
  stand.failClose = true;
  const res = stand.sequencer.start('seq-hotfire');
  assert.equal(res.ok, false);
  assert.match(res.error, /PB6/);
  assert.equal(stand.sequencer.running, false);

  on(purge);
  assert.equal(stand.sequencer.start('seq-abort').ok, true, 'the abort sequence is never refused');
});

test('goes off on disarm, abort and a lost TC', () => {
  for (const kill of [
    (s) => { s.armed = false; },
    (s) => { s.abortState = { active: true }; },
    (s) => { s.readings[GOX_SENSOR] = null; },
  ]) {
    const { stand, purge } = fixture({ t: -240 });
    on(purge);
    purge.update(stand.readings, 1000);
    assert.equal(stand.valveStates[GOX_VALVE], 'open');
    kill(stand);
    purge.update(stand.readings, 1100);
    assert.equal(purge.enabled, false);
    assert.equal(stand.valveStates[GOX_VALVE], 'closed');
  }
});

test('hand commands: open refused while on, close turns it off', () => {
  const { purge } = fixture();
  on(purge);
  assert.equal(purge.handCommand(GOX_VALVE, 'open', 'operator').ok, false);
  assert.equal(purge.handCommand(GOX_VALVE, 'closed', 'operator').ok, true);
  assert.equal(purge.enabled, false);
  assert.equal(purge.handCommand(GOX_VALVE, 'open', 'operator').ok, true, 'off: PB6 is the operator\'s');
});

test('refuses a band that is upside down, and turning on disarmed or blind', () => {
  const { stand, purge } = fixture();
  assert.equal(purge.set({ enable: true, openAt: -280, closeAt: -250, maxOpenMs: 1000 }).ok, false);
  assert.equal(purge.set({ enable: true, ...SETTINGS, maxOpenMs: 120000 }).ok, false);
  assert.equal(purge.set({ enable: true, ...SETTINGS, dwellMs: -1 }).ok, false);
  assert.equal(purge.set({ enable: true, openAt: -250, closeAt: -280, maxOpenMs: 3000 }).ok, false, 'dwell is required');
  stand.armed = false;
  assert.equal(purge.set({ enable: true, ...SETTINGS }).ok, false);
  stand.armed = true;
  stand.readings[GOX_SENSOR] = undefined;
  assert.equal(purge.set({ enable: true }).ok, false);
  assert.equal(purge.enabled, false);
});
