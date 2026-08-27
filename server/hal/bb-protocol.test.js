/**
 * Tests for the PANDA bang-bang wire format.
 *
 *   node --test server/hal/bb-protocol.test.js
 *
 * This is the part we cannot check against hardware until we are at the pad,
 * so it is checked against the spec instead — HANDOVER_COMMS.md §5 — byte for
 * byte. Two properties get the most attention:
 *
 *   - the dispatch ORDER, because a comma test placed before the prefix checks
 *     silently files every config confirmation as telemetry, and
 *   - the OPTIONAL pressure field, because a parser that requires it turns a
 *     legal heartbeat into a dropped one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeConfig, encodeVent, encodeMdot, encodeEnable, encodeManualVent, encodeAbort,
  encodeHeartbeat, encodeCfgPush,
  parseLine, parseHeartbeat, parseCfgPush, parseCommand,
  commandSide, heartbeatSide,
} from './bb-protocol.js';

// ---------------------------------------------------------------- encoding ---

test('B encodes exactly as the spec example', () => {
  assert.equal(
    encodeConfig('L', { setpoint: 200, deadbandFull: 10, waitMs: 500, maxOpenMs: 0 }),
    'BL200.0,10.0,500,0'
  );
});

test('a fractional setpoint survives — %.1f, not int()', () => {
  // The other reference implementation truncates with int(), so a 200.5 psi
  // target silently becomes 200. Nothing anywhere reports that it happened.
  const line = encodeConfig('F', { setpoint: 200.5, deadbandFull: 7.5, waitMs: 250, maxOpenMs: 500 });
  assert.equal(line, 'BF200.5,7.5,250,500');
  assert.equal(parseCommand(line).setpoint, 200.5);
});

test('V and M encode as the spec examples', () => {
  assert.equal(encodeVent('L', { trigger: 250, auto: true }), 'VL250.0,1');
  assert.equal(
    encodeMdot('L', { target: 0.85, spMin: 150, spMax: 400, gain: 0.025, rho: 1141, enabled: true }),
    'ML0.850,150.000,400.000,0.02500,1141.000,1'
  );
});

test('actuation commands are lowercase, configuration is uppercase', () => {
  assert.equal(encodeEnable('L', true), 'bL1');
  assert.equal(encodeEnable('F', false), 'bF0');
  assert.equal(encodeManualVent('L', true), 'vL1');
  assert.equal(encodeAbort('F'), 'xF');
});

test('a side is normalised, and a bad one throws rather than shipping', () => {
  assert.equal(encodeEnable('l', true), 'bL1');       // lowercase accepted, sent uppercase
  assert.equal(commandSide('f'), 'F');
  assert.equal(heartbeatSide('L'), 'l');
  assert.equal(commandSide('X'), null);
  // A malformed side must never reach the wire as a command for some other
  // side, so this is an exception rather than a default.
  assert.throws(() => encodeEnable('X', true), /must be "L" or "F"/);
});

// ---------------------------------------------------------------- decoding ---

test('a heartbeat parses, and the state enum is validated', () => {
  const hb = parseLine('BB:l:SUS:1:0:312.4');
  assert.equal(hb.kind, 'heartbeat');
  assert.deepEqual(
    { side: hb.side, state: hb.state, press: hb.press, vent: hb.vent, pressure: hb.pressure },
    { side: 'l', state: 'SUS', press: true, vent: false, pressure: 312.4 }
  );
  assert.equal(hb.stateValid, true);

  // An unrecognised state must be flagged. A client deriving `enabled` from
  // `state != "OFF"` reads garbage as ENABLED, which is the wrong direction
  // for this particular field to fail in.
  assert.equal(parseLine('BB:l:WAT:0:0').stateValid, false);
});

test('the pressure field is optional — a 5-field heartbeat is legal', () => {
  const hb = parseLine('BB:f:OFF:0:1');
  assert.equal(hb.kind, 'heartbeat');
  assert.equal(hb.vent, true);
  // Absent, not zero. "The board said nothing" and "the board said 0 psi" are
  // different claims, and only one of them means the tank is empty.
  assert.equal(hb.pressure, undefined);
});

test('a truncated heartbeat is not silently half-parsed', () => {
  assert.equal(parseHeartbeat('BB:l:SUS:1'), null);
  assert.equal(parseLine('BB:l:SUS:1').kind, 'unknown');
  assert.equal(parseHeartbeat('BB:x:SUS:1:0'), null, 'unknown side');
});

test('CFG_PUSH is classified as an event, NOT as telemetry', () => {
  // The whole reason prefix checks precede the comma test. Get this backwards
  // and every config confirmation lands in the CSV branch and never reaches
  // the operator — which is the bug in the reference implementation.
  const line = 'EVT:184320:CFG_PUSH:l:sp=200.0,db=10.0,wait=500,maxOpen=0,ventTrig=250.0,ventAuto=1';
  const msg = parseLine(line);
  assert.equal(msg.kind, 'event');
  assert.equal(msg.category, 'CFG_PUSH');
  assert.equal(msg.side, 'l');
  assert.deepEqual(msg.config.fields, {
    setpoint: 200, deadbandFull: 10, waitMs: 500, maxOpenMs: 0,
    ventTrigger: 250, ventAuto: true,
  });
});

test('an event detail keeps its own colons', () => {
  const msg = parseLine('EVT:900:BB_STATE:l:OFF->SUS:extra:bits');
  assert.equal(msg.detail, 'OFF->SUS:extra:bits');
});

test('unknown CFG_PUSH keys are surfaced, not dropped', () => {
  // This is not a nicety. The board's real vent keys turned out to be spelled
  // differently from the handover doc, and the "unrecognised key(s)" warning
  // is the only reason anyone found out rather than watching auto-vent
  // silently never confirm.
  const { fields, unknown } = parseCfgPush('sp=200.0,rho=1141.0');
  assert.deepEqual(fields, { setpoint: 200 });
  assert.deepEqual(unknown, { rho: '1141.0' });
});

test('the vent echo is read under the spelling the hardware actually sends', () => {
  // Observed 2026-08-27: PandaV2 sends avTrig/avAuto ("auto-vent", matching
  // the AV state), not the ventTrig/ventAuto of §5.5.
  const hw = parseCfgPush('avTrig=650.0,avAuto=0');
  assert.deepEqual(hw.fields, { ventTrigger: 650, ventAuto: false });
  assert.deepEqual(hw.unknown, {}, 'must not warn about keys the board really sends');

  // The documented spelling still parses, for any firmware that uses it.
  const doc = parseCfgPush('ventTrig=250.0,ventAuto=1');
  assert.deepEqual(doc.fields, { ventTrigger: 250, ventAuto: true });
});

test('a config split across two echoes assembles into one', () => {
  // The board echoes per command, so neither line is the whole config and the
  // host has to accumulate. Exactly the traffic the logs showed.
  const lines = [
    'EVT:184320:CFG_PUSH:f:sp=50.0,db=2.0,wait=250,maxOpen=500',
    'EVT:184321:CFG_PUSH:f:avTrig=650.0,avAuto=0',
  ];
  const confirmed = {};
  for (const line of lines) Object.assign(confirmed, parseLine(line).config.fields);
  assert.deepEqual(confirmed, {
    setpoint: 50, deadbandFull: 2, waitMs: 250, maxOpenMs: 500,
    ventTrigger: 650, ventAuto: false,
  });
});

test('errors and acks are classified before anything else looks at them', () => {
  assert.equal(parseLine('BB_ERROR: bad side').kind, 'error');
  assert.equal(parseLine('CMD_ERROR: nope').kind, 'error');
  assert.equal(parseLine('Arming!').kind, 'ack');
  assert.equal(parseLine('Disarming!').kind, 'ack');
  assert.equal(parseLine('SEQ_START').kind, 'ack');
  assert.equal(parseLine('Panda Initialized!').kind, 'ack');
});

test('telemetry still classifies, with or without a comma', () => {
  assert.deepEqual(
    { kind: parseLine('p0.712,0.698').kind, id: parseLine('p0.712,0.698').id },
    { kind: 'telemetry', id: 'p' }
  );
  // A board reporting a single channel sends no comma at all. Treating that
  // as a status line drops the reading with no complaint.
  assert.equal(parseLine('p0.188').kind, 'telemetry');
});

// ------------------------------------------------------------- round trips ---

test('every command encodes and decodes back to the same values', () => {
  const cfg = { setpoint: 470, deadbandFull: 30, waitMs: 250, maxOpenMs: 500 };
  assert.deepEqual(parseCommand(encodeConfig('L', cfg)), { kind: 'config', side: 'L', ...cfg });

  assert.deepEqual(parseCommand(encodeVent('F', { trigger: 650, auto: false })),
    { kind: 'vent', side: 'F', trigger: 650, auto: false });

  assert.deepEqual(parseCommand(encodeEnable('L', true)), { kind: 'enable', side: 'L', on: true });
  assert.deepEqual(parseCommand(encodeManualVent('F', false)), { kind: 'manualVent', side: 'F', open: false });
  assert.deepEqual(parseCommand(encodeAbort('L')), { kind: 'abort', side: 'L' });
});

test('a heartbeat and a CFG_PUSH survive their own round trip', () => {
  const line = encodeHeartbeat('l', { state: 'SUS', press: true, vent: false, pressure: 312.44 });
  assert.equal(line, 'BB:l:SUS:1:0:312.4');
  assert.equal(parseLine(line).pressure, 312.4);

  const echo = encodeCfgPush(184320, 'f', { sp: '450.0', db: '30.0', wait: 250, maxOpen: 500, ventAuto: false });
  assert.deepEqual(parseLine(echo).config.fields, {
    setpoint: 450, deadbandFull: 30, waitMs: 250, maxOpenMs: 500, ventAuto: false,
  });
});

test('a line that is not a bang-bang command is refused, not guessed at', () => {
  assert.equal(parseCommand('S31'), null, 'solenoid command');
  assert.equal(parseCommand('a'), null, 'arm');
  assert.equal(parseCommand('r'), null, 'disarm');
  assert.equal(parseCommand('bL'), null, 'enable with no argument');
  assert.equal(parseCommand('xL0'), null, 'abort takes no argument');
  assert.equal(parseCommand('BL200.0'), null, 'config missing the deadband');
});
