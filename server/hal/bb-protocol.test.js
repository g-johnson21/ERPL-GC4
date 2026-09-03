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
  encodePredictive,
  encodeHeartbeat, encodeCfgPush,
  encodePtTare, encodePtTareClear, encodePtOffset,
  parseLine, parseHeartbeat, parseCfgPush, parseCommand, parsePtTare,
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

// --------------------------------------------------------- LINK: watchdog ---

test('LINK: is classified by prefix, not as telemetry', () => {
  const msg = parseLine('LINK:1:0:120');
  assert.equal(msg.kind, 'link');
  assert.equal(msg.armed, true);
  assert.equal(msg.lost, false);
  assert.equal(msg.silentMs, 120);
});

test('LINK: reports an unarmed watchdog as unarmed', () => {
  const msg = parseLine('LINK:0:0:0');
  assert.equal(msg.kind, 'link');
  assert.equal(msg.armed, false);
});

test('LINK: carries the board-side loss flag', () => {
  const msg = parseLine('LINK:1:1:750');
  assert.equal(msg.lost, true);
  assert.equal(msg.silentMs, 750);
});

test('a malformed LINK: line is rejected rather than read as armed', () => {
  // The failure direction that matters: nothing garbled may parse as
  // "armed: true", because that would report protection the board is not
  // providing. Every one of these must come back as unknown.
  for (const line of ['LINK:', 'LINK:1', 'LINK:1:0', 'LINK:x:0:0', 'LINK:1:x:0',
                      'LINK:1:0:abc', 'LINK:2:0:0', 'LINK:1:0:-5']) {
    const msg = parseLine(line);
    assert.equal(msg.kind, 'unknown', `"${line}" should not parse`);
    assert.notEqual(msg.armed, true);
  }
});

// ------------------------------------------------------------- PT tare ---
//
// Four commands in one verb with two different ways of naming a channel:
// `TL`/`TF` by side, `T0,`/`T1,` by number, and `Tz` by neither. The decoder
// has to reach all four without the side lookup that every other command
// starts with.

test('PT tare encodes by side', () => {
  assert.equal(encodePtTare('L'), 'TL');
  assert.equal(encodePtTare('F'), 'TF');
  assert.equal(encodePtTare('l'), 'TL');      // normalised to the command case
});

test('PT tare clear is the bare Tz, with no side', () => {
  assert.equal(encodePtTareClear(), 'Tz');
});

test('an explicit offset maps the side to the board channel number', () => {
  // LOX is channel 0 and fuel is channel 1. Callers speak sides everywhere
  // else in this module, so getting this backwards would zero the wrong tank.
  assert.equal(encodePtOffset('L', 12.5), 'T0,12.5');
  assert.equal(encodePtOffset('F', 12.5), 'T1,12.5');
  assert.equal(encodePtOffset('L', 0), 'T0,0.0');
  assert.equal(encodePtOffset('F', -3.25), 'T1,-3.3');   // %.1f, like every psi
});

test('an unknown side is refused rather than encoded', () => {
  for (const bad of ['', 'X', 'z', '0', null]) {
    assert.throws(() => encodePtTare(bad), /side/i, `encodePtTare(${bad})`);
    assert.throws(() => encodePtOffset(bad, 1), /side/i, `encodePtOffset(${bad})`);
  }
});

test('every PT command round-trips through the decoder', () => {
  assert.deepEqual(parseCommand('TL'), { kind: 'ptTare', side: 'L' });
  assert.deepEqual(parseCommand('TF'), { kind: 'ptTare', side: 'F' });
  assert.deepEqual(parseCommand('Tz'), { kind: 'ptTareClear' });
  assert.deepEqual(parseCommand('T0,12.5'), { kind: 'ptOffset', side: 'L', channel: 0, offset: 12.5 });
  assert.deepEqual(parseCommand('T1,-3.3'), { kind: 'ptOffset', side: 'F', channel: 1, offset: -3.3 });
  assert.deepEqual(parseCommand(encodePtOffset('F', 0)), { kind: 'ptOffset', side: 'F', channel: 1, offset: 0 });
});

test('a malformed T command decodes to nothing, not to a tare', () => {
  // The direction that matters: a garbled line must never come back as a
  // command to zero a transducer the regulator is running on.
  for (const bad of ['T', 'TX', 'T2,5', 'T0', 'T0,', 'T,5', 'TZZ', 'T0,abc', 'Tz,1']) {
    assert.equal(parseCommand(bad), null, `"${bad}" should not decode`);
  }
});

test('PT_ERROR is classified as an error, not swallowed as telemetry', () => {
  // It has no comma and does not start with a digit, so before it was added
  // to the error prefixes it fell all the way through to "unknown" and was
  // logged at info level — a refused tare that looked like chatter.
  for (const line of ['PT_ERROR:no_data', 'PT_ERROR:parse']) {
    assert.equal(parseLine(line).kind, 'error');
    assert.equal(parseLine(line).message, line);
  }
});

test('a PT_TARE event parses as an event, keeping its category', () => {
  const msg = parseLine('EVT:1234:PT_TARE:l:12.5');
  assert.equal(msg.kind, 'event');
  assert.equal(msg.category, 'PT_TARE');
  assert.equal(msg.side, 'l');
  assert.equal(msg.detail, '12.5');
});

test('the PT_TARE detail parser accepts both plausible shapes, and neither blindly', () => {
  // The firmware note does not say what the detail carries, so this reads
  // k=v pairs and bare numbers-in-channel-order, and returns nothing at all
  // rather than a guess when it recognises neither.
  assert.deepEqual(parsePtTare('L=12.5,F=-3.0'), { L: 12.5, F: -3 });
  assert.deepEqual(parsePtTare('0=12.5,1=-3.0'), { L: 12.5, F: -3 });
  assert.deepEqual(parsePtTare('12.5,-3.0'), { L: 12.5, F: -3 });
  assert.deepEqual(parsePtTare(''), {});
  assert.deepEqual(parsePtTare('ok'), {});
  assert.deepEqual(parsePtTare('saved to eeprom'), {});
});

test('predictive shutoff encodes as e<side><0|1>', () => {
  assert.equal(encodePredictive('L', true), 'eL1');
  assert.equal(encodePredictive('F', false), 'eF0');
  // Lowercase verb: it actuates a board behaviour rather than storing a
  // configured number, so it belongs with b/v/x and not with B/V/M.
  assert.equal(encodePredictive('l', true)[0], 'e', 'the verb stays lowercase whatever case the side arrives in');
  assert.equal(encodePredictive('f', true), 'eF1', 'the side is upper-cased into command form');
  assert.throws(() => encodePredictive('X', true), /side must be/);
});

test('predictive shutoff round-trips through parseCommand', () => {
  assert.deepEqual(parseCommand(encodePredictive('L', true)), { kind: 'predictive', side: 'L', on: true });
  assert.deepEqual(parseCommand(encodePredictive('F', false)), { kind: 'predictive', side: 'F', on: false });
});

test('a malformed predictive command is rejected rather than defaulted', () => {
  // Anything but an exact 0 or 1 is null. Reading a garbled argument as
  // "enable" would turn on a valve behaviour nobody asked for; reading it as
  // "disable" would silently drop one someone did.
  assert.equal(parseCommand('eL'), null, 'no argument');
  assert.equal(parseCommand('eL2'), null, 'out of range');
  assert.equal(parseCommand('eL01'), null, 'trailing junk');
  assert.equal(parseCommand('eX1'), null, 'unknown side');
  assert.equal(parseCommand('EL1'), null, 'uppercase E is not this command');
});
