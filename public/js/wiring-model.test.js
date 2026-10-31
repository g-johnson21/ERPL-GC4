/**
 * Tests for the channel editor's wiring rules.
 *
 *   node --test public/js/wiring-model.test.js
 *
 * Run against the real stand and wiring files, because the thing worth
 * catching is an edit that leaves stand.json and hardware.json disagreeing —
 * a gauge reading another transducer, a coil sensed under another valve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inventory, sourceOf, setSensorSource, setValveChannel, renameInWiring,
  removeFromWiring, validateWiring, valveWiringChanged, niSpan, syncNiSpan,
  inputsFor, suits, tcType, setTcType, niModules, addNiModule, removeNiModule, canAddNiModule,
} from './wiring-model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8'));
const draco = () => ({ cfg: load('stand.json'), hw: load('hardware.json') });

test('every tracked wiring file agrees with its stand config', () => {
  assert.deepEqual(validateWiring(load('hardware.json'), load('stand.json')), []);
  assert.deepEqual(validateWiring(load('hardware-moe.json'), load('moe.json')), []);
});

test('the inventory counts each NI card, modules included, and the PANDA inputs', () => {
  const [nidaq, panda] = inventory(load('hardware.json'));
  const count = (card) => nidaq.inputs.filter((i) => i.card === card).length;
  assert.equal(count('pt'), 16);
  assert.equal(count('lc'), 4);
  assert.equal(count('tc'), 8);   // two 4-channel 9211 modules
  assert.ok(panda.inputs.some((i) => i.key === 'bbpt1'));
});

test('wiring a sensor to a taken input moves it there and unwires the other', () => {
  const { cfg, hw } = draco();
  const displaced = setSensorSource(cfg, hw, 'PT1', { device: 'nidaq', key: 'pt3' });
  assert.equal(displaced, 'PT2');
  assert.deepEqual(sourceOf(hw, 'PT1'), { device: 'nidaq', key: 'pt3' });
  assert.equal(sourceOf(hw, 'PT2'), null);
  // Its old input is free, not still pointing at it.
  assert.equal(hw.nidaq.channelMap.pt2, undefined);
  // The NI span follows the transducer: PT1 is a 10,000 psi gauge.
  assert.equal(hw.nidaq.cards.pt.channelMeta['3'].maxPsi, 10000);
  // The display number follows the input, unless another sensor holds it.
  assert.equal(cfg.sensors.find((s) => s.id === 'PT1').channel, 1000);
  // Unwired PT2 is the one left to fix, and the validator does not mind that.
  assert.deepEqual(validateWiring(hw, cfg), []);
});

test('moving a sensor between devices leaves it on exactly one', () => {
  const { cfg, hw } = draco();
  setSensorSource(cfg, hw, 'PT4', { device: 'panda', key: 'pt2' });
  assert.equal(Object.values(hw.nidaq.channelMap).includes('PT4'), false);
  assert.equal(hw.panda.channelMap.pt2, 'PT4');
  assert.equal(cfg.sensors.find((s) => s.id === 'PT4').channel, 302);
});

test('a range edit reaches the NI span, and only for an NI PT input', () => {
  const { cfg, hw } = draco();
  const pt2 = cfg.sensors.find((s) => s.id === 'PT2');
  pt2.max = 2000;
  syncNiSpan(hw, pt2);
  assert.equal(niSpan(hw, 'PT2').maxPsi, 2000);
  assert.equal(niSpan(hw, 'PT2').zeroMa, 4);
  const lc1 = cfg.sensors.find((s) => s.id === 'LC1');
  const before = JSON.stringify(hw.nidaq.cards.lc);
  lc1.max = 5000;
  syncNiSpan(hw, lc1);
  assert.equal(JSON.stringify(hw.nidaq.cards.lc), before);
});

test('putting a valve on an occupied DC channel swaps the two, current sense included', () => {
  const { cfg, hw } = draco();
  const other = setValveChannel(cfg, hw, 'SV-FBB', 2);
  assert.equal(other, 'SV-LOXBB');
  assert.equal(cfg.valves.find((v) => v.id === 'SV-FBB').channel, 2);
  assert.equal(cfg.valves.find((v) => v.id === 'SV-LOXBB').channel, 1);
  assert.equal(hw.panda.dcChannels['1'].valve, 'SV-FBB');
  assert.equal(hw.panda.dcChannels['0'].valve, 'SV-LOXBB');
  assert.deepEqual(validateWiring(hw, cfg), []);
});

test('a valve moved to a free channel gets a current-sense entry there', () => {
  const { cfg, hw } = draco();
  setValveChannel(cfg, hw, 'SV-MBV', 14);
  assert.equal(hw.panda.dcChannels['13'].valve, 'SV-MBV');
  assert.equal(hw.panda.dcChannels['8'].valve, undefined);
  assert.deepEqual(validateWiring(hw, cfg), []);
});

test('the validator catches a coil sensed under the wrong valve', () => {
  const { cfg, hw } = draco();
  cfg.valves.find((v) => v.id === 'SV-FBB').channel = 15;   // edited in stand.json alone
  assert.match(validateWiring(hw, cfg).join('\n'), /senses SV-FBB as DC1, but SV-FBB is on DC15/);
});

test('the validator catches a map entry for a sensor that no longer exists', () => {
  const { cfg, hw } = draco();
  cfg.sensors = cfg.sensors.filter((s) => s.id !== 'PT5');
  assert.match(validateWiring(hw, cfg).join('\n'), /pt5 -> "PT5" is not a defined sensor/);
  removeFromWiring(hw, 'PT5');
  assert.deepEqual(validateWiring(hw, cfg), []);
});

test('a rename follows the id through every map', () => {
  const { cfg, hw } = draco();
  cfg.valves.find((v) => v.id === 'MV-F').id = 'MV-FUEL';
  renameInWiring(hw, 'MV-F', 'MV-FUEL');
  cfg.sensors.find((s) => s.id === 'PT11').id = 'PT11B';
  renameInWiring(hw, 'PT11', 'PT11B');
  assert.equal(hw.panda.dcChannels['4'].valve, 'MV-FUEL');
  assert.equal(hw.nidaq.channelMap.pt6, 'PT11B');
});

test('valve wiring change: channel and coil sense count, a rename of the label does not', () => {
  const a = load('stand.json');
  const b = structuredClone(a);
  b.valves[0].name = 'Something else';
  assert.equal(valveWiringChanged(a, b), false);
  b.valves[0].normallyOpen = !b.valves[0].normallyOpen;
  assert.equal(valveWiringChanged(a, b), true);
});

test('each kind is offered only the inputs that can carry it', () => {
  const devices = inventory(load('hardware.json'));
  const cards = (kind) => inputsFor(devices, kind)
    .flatMap((d) => d.inputs.map((i) => `${d.device}:${i.card}`))
    .filter((v, i, a) => a.indexOf(v) === i);
  assert.deepEqual(cards('temperature'), ['nidaq:tc']);
  assert.deepEqual(cards('force'), ['nidaq:lc']);
  assert.deepEqual(cards('pressure'), ['nidaq:pt', 'panda:pt', 'panda:bbpt']);
  // A flowmeter may be 4-20 mA or anything else: no narrowing.
  assert.equal(inputsFor(devices, 'flow').reduce((n, d) => n + d.inputs.length, 0),
    devices.reduce((n, d) => n + d.inputs.length, 0));
  assert.equal(suits('tc3', 'pressure'), false);
  assert.equal(suits('tc3', 'temperature'), true);
});

test('a thermocouple type is read from and written to its NI TC channel', () => {
  const { cfg, hw } = draco();
  assert.equal(tcType(hw, 'TC2'), 'K');
  setTcType(hw, 'TC2', 'T');
  assert.equal(hw.nidaq.cards.tc.channelMeta['1'].type, 'T');
  assert.equal(hw.nidaq.cards.tc.channelMeta['1'].offset, 0);
  // Not on a TC input: nothing to read, nothing written.
  assert.equal(tcType(hw, 'PT1'), null);
  setSensorSource(cfg, hw, 'TC2', { device: 'nidaq', key: 'tc7' });
  assert.equal(tcType(hw, 'TC2'), 'K');
});

test('a stand with no 9211 offers no thermocouple input until one is added', () => {
  const hw = load('hardware-moe.json');
  const cfg = load('moe.json');
  assert.deepEqual(inputsFor(inventory(hw), 'temperature'), []);
  assert.equal(canAddNiModule(hw, 'pt'), false);   // the sidecar runs one 9208
  const first = addNiModule(hw, 'tc');
  assert.equal(first, 0);
  assert.equal(hw.nidaq.cards.tc.modules[0].slot, 3);
  assert.equal(addNiModule(hw, 'tc'), 4);           // a second one chains on
  assert.deepEqual(hw.nidaq.cards.tc.modules.map((m) => m.slot), [3, 4]);
  const tcs = inputsFor(inventory(hw), 'temperature')[0].inputs.map((i) => i.key);
  assert.deepEqual(tcs, ['tc0', 'tc1', 'tc2', 'tc3', 'tc4', 'tc5', 'tc6', 'tc7']);
  assert.deepEqual(validateWiring(hw, cfg), []);
});

test('removing a chained 9211 unwires its sensors and closes the gap', () => {
  const { cfg, hw } = draco();
  setSensorSource(cfg, hw, 'TC2', { device: 'nidaq', key: 'tc1' });
  setSensorSource(cfg, hw, 'PT1', { device: 'nidaq', key: 'tc5' });
  setTcType(hw, 'PT1', 'T');
  const unwired = removeNiModule(hw, 'tc', 0);
  assert.ok(unwired.includes('TC2'));
  // What was tc5 on the second module is tc1 now, type and all.
  assert.equal(hw.nidaq.channelMap.tc1, 'PT1');
  assert.equal(hw.nidaq.cards.tc.channelMeta['1'].type, 'T');
  assert.deepEqual(hw.nidaq.cards.tc.modules, [{ slot: 4, channels: 4 }]);
  assert.equal(inventory(hw)[0].inputs.filter((i) => i.card === 'tc').length, 4);
  // Removing the last one takes the card away entirely.
  removeNiModule(hw, 'tc', 0);
  assert.equal(hw.nidaq.cards.tc, undefined);
  assert.deepEqual(validateWiring(hw, cfg), []);
});

test('two modules in one slot are refused', () => {
  const { cfg, hw } = draco();
  hw.nidaq.cards.tc.modules[1].slot = 2;
  assert.match(validateWiring(hw, cfg).join('\n'), /both in slot 2/);
  assert.equal(niModules(hw).length, 4);
});
