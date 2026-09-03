/**
 * Tests for the formatters whose failure mode is a plausible-looking number.
 *
 *   node --test public/js/util.test.js
 *
 * fmtCurrent exists because its predecessor rendered every real solenoid
 * channel as a frozen "0.00 A". The board reports idle leakage of about
 * 0.4 mA and a pulled-in coil at several hundred, and two decimals of amps
 * cannot show both — so a live board and a dead one looked identical, on
 * every channel, permanently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtCurrent, coilState } from './util.js';

// --- coil indicator ----------------------------------------------------------

const NC = { id: 'SV-MBV', normallyOpen: false };   // energize to OPEN
const NO = { id: 'SV-LOXV', normallyOpen: true };   // energize to CLOSE
const on = { energized: true, amps: 0.62 };
const off = { energized: false, amps: 0.0004 };

test('a normally-closed valve is green open, grey closed', () => {
  assert.equal(coilState(NC, 'open', on), 'on');
  assert.equal(coilState(NC, 'closed', off), 'off');
});

test('a normally-open valve is the mirror image, and still not a fault', () => {
  // The case that matters most. A NO vent is energized to CLOSE, so sitting
  // open with no current is correct. Comparing against flow state instead
  // would paint every NO valve on the stand red, permanently.
  assert.equal(coilState(NO, 'closed', on), 'on', 'commanded shut, coil pulled in');
  assert.equal(coilState(NO, 'open', off), 'off', 'commanded open, coil released');
});

test('a coil that did not do what it was told is a fault, either direction', () => {
  assert.equal(coilState(NC, 'open', off), 'fault', 'told to open, drew nothing');
  assert.equal(coilState(NC, 'closed', on), 'fault', 'told to close, still drawing');
  assert.equal(coilState(NO, 'closed', off), 'fault', 'told to shut, coil released');
  assert.equal(coilState(NO, 'open', on), 'fault', 'told to open, still holding shut');
});

test('no current sense claims nothing rather than reporting de-energized', () => {
  // 'unknown' hides the dot. Returning 'off' would state, in grey, that a
  // channel nobody measures is confirmed de-energized.
  assert.equal(coilState(NC, 'closed', undefined), 'unknown');
  assert.equal(coilState(NC, 'closed', null), 'unknown');
  assert.equal(coilState(NC, 'closed', { amps: 0.5 }), 'unknown', 'no energized field');
});

test('idle leakage is legible, and visibly moves', () => {
  // Straight from a real capture: s0.00049,s0.00039,s0.00038,...
  assert.equal(fmtCurrent(0.00049), '0.49 mA');
  assert.equal(fmtCurrent(0.00039), '0.39 mA');
  assert.equal(fmtCurrent(0.00038), '0.38 mA');
  // The point of the whole change: adjacent samples must render differently.
  assert.notEqual(fmtCurrent(0.00049), fmtCurrent(0.00038));
});

test('an energized coil reads in whole milliamps', () => {
  assert.equal(fmtCurrent(0.62), '620 mA');
  assert.equal(fmtCurrent(0.21), '210 mA');
  assert.equal(fmtCurrent(0.0105), '11 mA');
});

test('inrush crosses into amps rather than reading four digits', () => {
  assert.equal(fmtCurrent(1.2), '1.20 A');
  assert.equal(fmtCurrent(2.5), '2.50 A');
});

test('the unit switches exactly at the documented boundaries', () => {
  assert.equal(fmtCurrent(0.00999), '9.99 mA');   // just under 10 mA: 2 dp
  assert.equal(fmtCurrent(0.01), '10 mA');        // at 10 mA: whole mA
  assert.equal(fmtCurrent(0.999), '999 mA');      // just under 1 A
  assert.equal(fmtCurrent(1), '1.00 A');          // at 1 A
});

test('a dead channel is zero, not a rounding artefact', () => {
  assert.equal(fmtCurrent(0), '0.00 mA');
});

test('a missing reading says so instead of printing zero', () => {
  // "no measurement" and "measured zero" are different claims, and only one
  // of them means the coil is not drawing current.
  assert.equal(fmtCurrent(undefined), '--');
  assert.equal(fmtCurrent(null), '--');
  assert.equal(fmtCurrent(NaN), '--');
});

test('a negative reading is shown, not hidden', () => {
  // Sense amplifiers can read slightly negative at zero. Clamping it to 0
  // would disguise an offset worth calibrating out.
  assert.equal(fmtCurrent(-0.0004), '-0.40 mA');
  assert.equal(fmtCurrent(-1.5), '-1.50 A');
});
