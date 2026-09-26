/**
 * Tests for the config store's section diff and the armed-edit policy.
 *
 *   node --test server/config-store.test.js
 *
 * `changedSections` is the load-bearing part. Two different things read it,
 * and it fails in two different directions:
 *
 *   - a FALSE POSITIVE refuses a legitimate save, or reloads every control
 *     screen mid-test for a file that did not actually change;
 *   - a FALSE NEGATIVE lets a rewired valve or a new calibration reach the
 *     server while every browser keeps the DOM it built from the old one --
 *     a button whose label has quietly stopped matching the valve it commands.
 *
 * The second is the one worth being paranoid about, so most of what is below
 * is about the diff telling the truth rather than about the policy on top.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigStore } from './config-store.js';

const REAL_CONFIG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../config/stand.json');

/**
 * A store over a throwaway copy of the real stand file.
 *
 * The real one, not a fixture: this code's whole job is comparing configs that
 * have been through `normalizeConfig`, and a hand-written stub would be
 * missing exactly the defaults that make a naive diff report phantom changes.
 */
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc4-cfg-'));
  const file = path.join(dir, 'stand.json');
  fs.copyFileSync(REAL_CONFIG, file);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { store: new ConfigStore(file), file };
}

/** The file as it sits on disk — the shape a browser would PUT back. */
const raw = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ------------------------------------------------------------------ diff --

test('a config that has not changed reports no changed sections', (t) => {
  // The Config page PUTs back a full document every time, re-serialized from a
  // structuredClone. If that round trip looked like an edit, every save would
  // read as structural and bounce every station through a reload.
  const { store, file } = tempStore(t);
  assert.deepEqual(store.changedSections(raw(file)), []);
});

test('the defaults the store fills in are not mistaken for edits', (t) => {
  // A browser saves the NORMALIZED config it was served, so the file on disk
  // and the document coming back differ by every `??=` in normalizeConfig.
  // Comparing normalized-to-normalized is what makes that a non-event.
  const { store } = tempStore(t);
  assert.deepEqual(store.changedSections(store.get()), []);

  // And the reverse: a sparse config that omits an optional field entirely
  // still matches once the default is filled back in.
  const sparse = structuredClone(store.get());
  delete sparse.safety.requireDisarmToEditConfig;
  delete sparse.safety.autoDisarmAfterSeconds;
  assert.deepEqual(store.changedSections(sparse), []);
});

test('key order is not a change, but array order is', (t) => {
  const { store } = tempStore(t);

  const reordered = structuredClone(store.get());
  reordered.meta = Object.fromEntries(Object.entries(reordered.meta).reverse());
  assert.deepEqual(store.changedSections(reordered), [],
    're-serializing a file must not read as an edit');

  // Step order inside a sequence, and valve order inside a group, are
  // meaningful — a diff that ignored them would let a reordered countdown
  // through as "nothing changed".
  const swapped = structuredClone(store.get());
  [swapped.valves[0], swapped.valves[1]] = [swapped.valves[1], swapped.valves[0]];
  assert.deepEqual(store.changedSections(swapped), ['valves']);
});

test('a real edit is reported, and only in the section it touched', (t) => {
  const { store } = tempStore(t);

  const next = structuredClone(store.get());
  next.autosequences[0].description = 'retimed between attempts';
  assert.deepEqual(store.changedSections(next), ['autosequences']);

  // The one that matters most: rewiring a valve channel must never be able to
  // pass as an autosequence edit.
  const rewired = structuredClone(store.get());
  rewired.valves[0].channel = rewired.valves[0].channel + 90;
  assert.deepEqual(store.changedSections(rewired), ['valves']);

  const both = structuredClone(store.get());
  both.autosequences[0].description = 'x';
  both.sensors[0].calibration.slope = 2;
  assert.deepEqual(store.changedSections(both).sort(), ['autosequences', 'sensors']);
});

test('an added or removed section is a change in both directions', (t) => {
  const { store } = tempStore(t);

  const dropped = structuredClone(store.get());
  delete dropped.pid;
  assert.ok(store.changedSections(dropped).includes('pid'));
});

// ----------------------------------------------------------------- events --

test('the reload event carries what moved, so a browser can decide', (t) => {
  // Without this the client cannot tell "the countdown was retimed" from "the
  // valve list changed underneath you", and it has to assume the worse of the
  // two on every save.
  const { store } = tempStore(t);

  const seen = [];
  store.on('reload', (cfg, changed) => seen.push({ name: cfg.meta.standName, changed }));

  const next = structuredClone(store.get());
  next.autosequences[0].description = 'retimed';
  const result = store.save(next);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ['autosequences']);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].changed, ['autosequences']);
});

test('a file reload carries the diff too, not just a save', (t) => {
  // A hand edit picked up by POST /api/config/reload has to reach the stations
  // with the same information a Save & Apply does, or editing stand.json in a
  // text editor becomes the way to leave every screen stale.
  const { store, file } = tempStore(t);

  const onDisk = raw(file);
  onDisk.ui.sparklineSeconds = (onDisk.ui.sparklineSeconds ?? 60) + 15;
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));

  const seen = [];
  store.on('reload', (_cfg, changed) => seen.push(changed));
  store.reload();

  assert.deepEqual(seen, [['ui']]);
});

test('a rejected save changes nothing and emits nothing', (t) => {
  const { store } = tempStore(t);
  const before = JSON.stringify(store.get());

  let emitted = 0;
  store.on('reload', () => { emitted++; });

  const bad = structuredClone(store.get());
  bad.valves[0].channel = -1;                     // must be a non-negative int
  const result = store.save(bad);

  assert.equal(result.ok, false);
  assert.ok(result.errors.length);
  assert.equal(emitted, 0, 'a refused save must not announce a reload');
  assert.equal(JSON.stringify(store.get()), before, 'nor swap the running config');
});

// ----------------------------------------------------------------- policy --

test('editing while armed is allowed unless the stand asks for the interlock', (t) => {
  // The route reads this field; the default is what decides whether a stand
  // that has never heard of the setting can be reconfigured mid-test.
  const { store } = tempStore(t);
  assert.equal(store.get().safety.requireDisarmToEditConfig, false);

  const locked = structuredClone(store.get());
  locked.safety.requireDisarmToEditConfig = true;
  store.save(locked);
  assert.equal(store.get().safety.requireDisarmToEditConfig, true,
    'an explicit opt-in survives normalization');
});

test('backups are named and pruned per config file, so two stands keep their own', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc4-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const moeSource = path.resolve(path.dirname(REAL_CONFIG), 'moe.json');
  fs.copyFileSync(REAL_CONFIG, path.join(dir, 'stand.json'));
  fs.copyFileSync(moeSource, path.join(dir, 'moe.json'));
  const draco = new ConfigStore(path.join(dir, 'stand.json'));
  const moe = new ConfigStore(path.join(dir, 'moe.json'));

  // One Draco save, then more MOE saves than the keep limit.
  assert.equal(draco.save(draco.get()).ok, true);
  for (let i = 0; i < 22; i++) {
    const cfg = structuredClone(moe.get());
    cfg.meta.configVersion = `1.0.${i}`;
    assert.equal(moe.save(cfg).ok, true);
  }

  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.filter((f) => f.startsWith('stand.')).length, 1, 'the Draco backup survives MOE\'s pruning');
  assert.equal(backups.filter((f) => f.startsWith('moe.')).length, 20, 'MOE keeps its own twenty');
});

// ---------------------------------------------------------- alert bounds --

test('a threshold-only edit is reported as alertBounds, not as sensors', (t) => {
  // Retuning an alert mid-test must not reload every control screen, and it
  // is only safe not to because nothing but the thresholds moved.
  const { store } = tempStore(t);
  const next = structuredClone(store.get());
  const pt = next.sensors.find((s) => s.kind === 'pressure');
  pt.warnHigh = 123;
  pt.dangerHigh = 456;
  assert.deepEqual(store.changedSections(next), ['alertBounds']);

  // A board sensor's thresholds are in `bangbang`, and the same rule holds.
  const bs = next.bangbang.find((b) => b.boardSensor);
  if (bs) {
    bs.boardSensor.warnHigh = 111;
    assert.deepEqual(store.changedSections(next), ['alertBounds']);
  }
});

test('a threshold edit riding with a real sensor change is still structural', (t) => {
  const { store } = tempStore(t);
  const next = structuredClone(store.get());
  next.sensors[0].warnHigh = 1;
  next.sensors[0].decimals = (next.sensors[0].decimals ?? 1) + 1;
  assert.deepEqual(store.changedSections(next), ['sensors']);
});

test('alert thresholds must nest minor inside major', (t) => {
  const { store } = tempStore(t);
  const bad = structuredClone(store.get());
  const pt = bad.sensors.find((s) => s.kind === 'pressure');
  pt.warnHigh = 500;
  pt.dangerHigh = 400;
  const result = store.save(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /warnHigh \(500\) must be <= dangerHigh \(400\)/.test(e)), result.errors.join('\n'));

  const clean = structuredClone(store.get());
  const pt2 = clean.sensors.find((s) => s.kind === 'pressure');
  pt2.warnLow = null;
  pt2.dangerLow = null;
  pt2.warnHigh = 100;
  pt2.dangerHigh = 200;
  assert.equal(store.save(clean).ok, true, 'null means "no bound"');
});

test('valve alert rules are validated and apply as the alerts section', (t) => {
  const { store } = tempStore(t);
  const valve = store.get().valves[0].id;

  const good = structuredClone(store.get());
  good.alerts.valves = [{ valve, state: 'open', afterSeconds: 120, level: 'major', message: 'vent it' }];
  assert.deepEqual(store.changedSections(good), ['alerts'], 'a rule edit reloads no station');
  assert.equal(store.save(good).ok, true);

  const bad = structuredClone(store.get());
  bad.alerts.valves = [
    { valve: 'NOPE', state: 'open', afterSeconds: 1 },
    { valve, state: 'ajar', afterSeconds: -1, level: 'huge' },
  ];
  const result = store.save(bad);
  assert.equal(result.ok, false);
  for (const re of [/"NOPE" is not a defined valve/, /state must be one of/, /afterSeconds must be/, /level must be/]) {
    assert.ok(result.errors.some((e) => re.test(e)), `${re} in:\n${result.errors.join('\n')}`);
  }
});

test('the alerts section defaults on, and is its own section', (t) => {
  const { store } = tempStore(t);
  assert.deepEqual(store.get().alerts, { enabled: true, sound: true, valves: [] });
  const next = structuredClone(store.get());
  next.alerts.sound = false;
  assert.deepEqual(store.changedSections(next), ['alerts']);
});
