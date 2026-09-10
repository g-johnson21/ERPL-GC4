import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSequence } from './sequence-protocol.js';

const valves = [{ id: 'V1', channel: 1 }, { id: 'V10', channel: 10, normallyOpen: true }];
const step = (t, target = 'V1', state = 'open') => ({ t, target, state, action: 'valve' });

test('Panda delays follow actions, use milliseconds, and invert normally-open coils', () => {
  const result = encodeSequence({ steps: [step(3, 'V10', 'closed'), step(0), step(1, 'V1', 'closed')] }, valves);
  assert.equal(result.command, 's11.01000,s10.02000,sA1.00000');
});

test('an initial delay uses a non-actuating channel-zero command', () => {
  assert.equal(encodeSequence({ steps: [step(2.125), step(2.125, 'V10')] }, valves).command,
    's00.02125,s11.00000,sA0.00000');
});

test('reject firmware truncation, invalid times and unsupported actions before sending', () => {
  for (const t of [-1, NaN, Infinity]) assert.throws(() => encodeSequence({ steps: [step(t)] }, valves), /time/);
  assert.throws(() => encodeSequence({ steps: [step(100)] }, valves), /99.999/);
  assert.throws(() => encodeSequence({ steps: Array.from({ length: 26 }, (_, i) => step(i)) }, valves), /255-byte/);
  assert.equal(encodeSequence({ steps: Array.from({ length: 25 }, (_, i) => step(i)) }, valves).command.length, 249);
  for (const action of ['bangbang', 'log', 'safeAll', 'abortStates', 'abort', 'end']) {
    assert.throws(() => encodeSequence({ steps: [{ ...step(0), action }] }, valves), /unsupported/);
  }
  assert.throws(() => encodeSequence({ steps: [step(0)] }, [{ ...valves[0], momentary: true }]), /momentary/);
  assert.throws(() => encodeSequence({ steps: [step(0)] }, [{ ...valves[0], channel: 13 }]), /1–12/);
});
