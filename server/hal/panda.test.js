/**
 * Tests for the PANDA line parser and command encoder.
 *
 * These cover the failure modes the hardware makes expensive to find: the
 * volts-vs-milliamps ambiguity on `p` lines, the normally-open coil polarity,
 * and the non-decimal solenoid channel tokens. All are silent when wrong.
 *
 *   node --test server/hal/panda.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PandaDriver } from './panda.js';

/** A driver with the serial layer stubbed out, capturing writes. */
function makeDriver(options = {}) {
  const d = new PandaDriver(options);
  d.sent = [];
  d.port = { writable: true, write: (line) => d.sent.push(line.trim()) };
  d.config = options.config || { sensors: [], valves: [] };
  return d;
}

test('p lines convert shunt volts through mA to psi', () => {
  const d = makeDriver({
    defaultShuntOhms: 47,
    channelMap: { pt0: 'PT-201' },
    config: { sensors: [{ id: 'PT-201', min: 0, max: 1000 }], valves: [] },
  });

  // 0.188 V across 47 ohm = 4.0 mA = bottom of range = 0 psi.
  d.onLine('p0.188');
  assert.equal(Math.round(d.raw.get('pt0_ma') * 100) / 100, 4);
  assert.equal(Math.round(d.raw.get('pt0')), 0);

  // 0.940 V = 20.0 mA = top of range = 1000 psi.
  d.onLine('p0.940');
  assert.equal(Math.round(d.raw.get('pt0_ma') * 10) / 10, 20);
  assert.equal(Math.round(d.raw.get('pt0')), 1000);

  // Midpoint: 12 mA -> 500 psi.
  d.onLine('p0.564');
  assert.equal(Math.round(d.raw.get('pt0')), 500);
});

test('psi is clamped to the channel range, so a pinned value is not saturation', () => {
  const d = makeDriver({
    defaultShuntOhms: 47,
    channelMap: { pt0: 'PT-201' },
    config: { sensors: [{ id: 'PT-201', min: 0, max: 1000 }], valves: [] },
  });
  d.onLine('p0.0');      // 0 mA, below the 4 mA floor
  assert.equal(d.raw.get('pt0'), 0);
  d.onLine('p2.0');      // far above 20 mA
  assert.equal(d.raw.get('pt0'), 1000);
});

test('ptInputMode "ma" passes values through without a shunt divide', () => {
  const d = makeDriver({
    ptInputMode: 'ma',
    channelMap: { pt0: 'PT-201' },
    config: { sensors: [{ id: 'PT-201', min: 0, max: 500 }], valves: [] },
  });
  d.onLine('p12.0');
  assert.equal(d.raw.get('pt0_ma'), 12);
  assert.equal(Math.round(d.raw.get('pt0')), 250);
});

test('numeric parsing tolerates the id prefix on the first token', () => {
  const d = makeDriver({ ptInputMode: 'ma' });
  d.onLine('p6.500,7.000');
  assert.equal(d.raw.get('pt0_ma'), 6.5);
  assert.equal(d.raw.get('pt1_ma'), 7);
});

test('EVERY token may carry the id letter, not just the first', () => {
  // Observed on hardware. The handover doc says only the first token carries
  // it; this board puts `s` on all twelve. The strip-non-numeric rule handles
  // it, which is why it must not be "optimised" into slicing off character
  // one — that would turn s0.00039 into .00039 on eleven of twelve channels.
  const d = makeDriver({ dcThresholdA: 0.1 });
  d.onLine('s0.00049,s0.00039,s0.00038,s0.00038,s0.00038,s0.00037,' +
           's0.00051,s0.00037,s0.00041,s0.00041,s0.00040,s0.00040');

  assert.equal(d.dc.currents.length, 12);
  assert.equal(d.dc.currents[0], 0.00049);
  assert.equal(d.dc.currents[6], 0.00051);
  assert.equal(d.dc.currents[11], 0.00040);
  assert.ok(d.dc.states.every((s) => s === false), 'sub-milliamp is not energized');
});

test('a single-channel line has no comma and must still parse', () => {
  // Dispatching on "does the line contain a comma" drops these silently.
  const d = makeDriver({ ptInputMode: 'ma' });
  d.onLine('p12.0');
  assert.equal(d.raw.get('pt0_ma'), 12);
});

test('status lines are never mistaken for telemetry', () => {
  const seen = [];
  const d = makeDriver({ onEvent: (m) => seen.push(m) });
  // 'Arming!' starts with a letter but carries no numeric payload; 'BB:...'
  // does contain digits but is not one of the telemetry identifiers.
  d.onLine('Arming!');
  d.onLine('SEQ_DONE');
  assert.deepEqual(seen, ['Arming!', 'SEQ_DONE']);
  assert.equal(d.raw.size, 0);
});

test('t lines split into 8 load cells then 8 thermocouples', () => {
  const d = makeDriver();
  const values = Array.from({ length: 16 }, (_, i) => i + 1);
  d.onLine('t' + values.join(','));
  assert.equal(d.raw.get('lc0'), 1);
  assert.equal(d.raw.get('lc7'), 8);
  assert.equal(d.raw.get('tc0'), 9);
  assert.equal(d.raw.get('tc7'), 16);
});

test('s lines set per-channel current and derive energized state', () => {
  const d = makeDriver({ dcThresholdA: 0.1 });
  d.onLine('s0.000,0.512,0.050');
  assert.deepEqual(d.dc.states, [false, true, false]);
  assert.equal(d.dc.currents[1], 0.512);
});

test('dcOrder remaps wire position to logical channel', () => {
  // dcOrder[i] is the logical index of the value at wire position i.
  const d = makeDriver({ dcOrder: [2, 0, 1] });
  d.onLine('s0.10,0.20,0.30');
  assert.deepEqual(d.dc.currents, [0.20, 0.30, 0.10]);
});

test('values past the end of dcOrder pass through rather than vanishing', () => {
  const d = makeDriver({ dcOrder: [1, 0] });
  d.onLine('s0.10,0.20,0.99');
  assert.equal(d.dc.currents[2], 0.99);
});

test('dcOrder omitted leaves the order untouched', () => {
  const d = makeDriver({ dcOrder: null });
  d.onLine('s0.10,0.20');
  assert.deepEqual(d.dc.currents, [0.10, 0.20]);
});

test('dcStatus keys current sense by the valve each channel watches', () => {
  const d = makeDriver({
    dcThresholdA: 0.1,
    dcOrder: null,
    dcChannels: {
      0: { id: 'DC1', valve: 'SV-FP' },
      1: { id: 'DC2', valve: 'SV-OP' },
      2: { id: 'DC3' },                     // no valve: diagnostics only
    },
  });
  d.onLine('s0.512,0.000,0.700');

  const s = d.dcStatus();
  assert.deepEqual(Object.keys(s).sort(), ['SV-FP', 'SV-OP']);
  assert.deepEqual(s['SV-FP'], { id: 'DC1', amps: 0.512, energized: true });
  assert.deepEqual(s['SV-OP'], { id: 'DC2', amps: 0, energized: false });
});

test('a channel declared unsensed shows nothing rather than a false reading', () => {
  // Observed on hardware: two positions sat at a fixed 0.38 A and 0.21 A with
  // every solenoid de-energized. Both are above the 0.1 A threshold, so the
  // stand called two closed purge valves ENERGIZED. A number that is not a
  // measurement is worse than a blank here, because nothing distinguishes it
  // from the reading that would matter.
  const d = makeDriver({
    dcThresholdA: 0.1,
    dcChannels: {
      0: { id: 'DC1', valve: 'SV-LOXBB' },
      4: { id: 'DC7', valve: 'SV-FPURGE', sensed: false },
      5: { id: 'DC8', valve: 'SV-LOXPURGE', sensed: false },
    },
  });
  d.onLine('s0.000,0,0,0,0.380,0.210');

  const s = d.dcStatus();
  assert.deepEqual(Object.keys(s), ['SV-LOXBB'], 'only the trustworthy channel reports');
  assert.equal(s['SV-FPURGE'], undefined);
  assert.equal(s['SV-LOXPURGE'], undefined);

  // The samples are still parsed and still logged — declaring a channel
  // unsensed hides it from the operator's valve card, not from the trace that
  // would show the fault coming back.
  assert.equal(d.dc.currents[4], 0.38);
});

test('sensed:false is not mistaken for a stale valve id', () => {
  const events = [];
  const d = makeDriver({
    dcChannels: { 4: { id: 'DC7', valve: 'SV-FPURGE', sensed: false } },
    onEvent: (message, level) => events.push([level, message]),
  });
  d.checkDcWiring({ valves: [{ id: 'SV-FPURGE' }] });
  assert.deepEqual(events, [], 'a deliberate declaration is not a wiring error');
});

test('a dc channel naming a valve the stand does not have is reported', () => {
  // This is how five of eleven current readings went missing: the stand's
  // valves were renamed, the wiring file was not, and dcByValve simply never
  // matched. Nothing said so -- the affected cards just showed no current, as
  // if the board were not sensing them.
  const events = [];
  const d = makeDriver({
    dcChannels: {
      0: { id: 'DC1', valve: 'SV-LOXBB' },     // current
      1: { id: 'DC2', valve: 'SV-FP' },        // stale, renamed to SV-FBB
      2: { id: 'DC3' },                        // no valve: diagnostics only
    },
    onEvent: (message, level) => events.push([level, message]),
  });

  d.checkDcWiring({ valves: [{ id: 'SV-LOXBB' }, { id: 'SV-FBB' }] });

  assert.equal(events.length, 1, 'one message, listing every orphan');
  const [level, message] = events[0];
  assert.equal(level, 'error');
  assert.match(message, /DC2→"SV-FP"/);
  assert.doesNotMatch(message, /DC1/, 'a channel that resolves is not complained about');
  assert.doesNotMatch(message, /DC3/, 'nor is one that deliberately names no valve');
});

test('wiring that fully resolves says nothing at all', () => {
  const events = [];
  const d = makeDriver({
    dcChannels: { 0: { id: 'DC1', valve: 'SV-LOXBB' } },
    onEvent: (message, level) => events.push([level, message]),
  });
  d.checkDcWiring({ valves: [{ id: 'SV-LOXBB' }] });
  assert.deepEqual(events, []);
});

test('a config with no valves is not treated as every channel being wrong', () => {
  // init() runs before anything guarantees a populated config. Warning here
  // would fire on every startup and train people to ignore the message.
  const events = [];
  const d = makeDriver({
    dcChannels: { 0: { id: 'DC1', valve: 'SV-LOXBB' } },
    onEvent: (message, level) => events.push([level, message]),
  });
  d.checkDcWiring({ valves: [] });
  d.checkDcWiring(undefined);
  assert.deepEqual(events, []);
});

test('dcStatus omits channels the board has not reported yet', () => {
  const d = makeDriver({
    dcChannels: { 0: { id: 'DC1', valve: 'SV-FP' }, 5: { id: 'DC6', valve: 'MV-O' } },
    dcOrder: null,
  });
  d.onLine('s0.512');
  assert.deepEqual(Object.keys(d.dcStatus()), ['SV-FP']);
});

test('P lines are ignored so psi is only ever derived from p', () => {
  const d = makeDriver({ channelMap: { pt0: 'PT-201' } });
  d.onLine('P999.0,888.0');
  assert.equal(d.raw.get('pt0'), undefined);
});

test('solenoid channels encode 1-9 then A,B,C', () => {
  assert.equal(PandaDriver.channelToken(1), '1');
  assert.equal(PandaDriver.channelToken(9), '9');
  assert.equal(PandaDriver.channelToken(10), 'A');
  assert.equal(PandaDriver.channelToken(12), 'C');
  assert.equal(PandaDriver.channelToken(0), null);
  assert.equal(PandaDriver.channelToken(13), null);
});

test('normally-open valves energize to CLOSE', () => {
  const d = makeDriver();
  const no = { id: 'SV-FV', channel: 4, normallyOpen: true };
  const nc = { id: 'SV-FP', channel: 2, normallyOpen: false };

  d.setValve(no, 'closed');
  d.setValve(no, 'open');
  d.setValve(nc, 'open');
  d.setValve(nc, 'closed');

  assert.deepEqual(d.sent, ['S41', 'S40', 'S21', 'S20']);
});

test('a valve outside the 1-12 range is refused, not silently dropped', () => {
  const d = makeDriver();
  assert.throws(
    () => d.setValve({ id: 'SV-X', channel: 20, normallyOpen: false }, 'open'),
    /outside the PANDA's 1-12 range/,
  );
});

test('BB heartbeats are mirrored rather than treated as telemetry', () => {
  const d = makeDriver();
  d.onLine('BB:l:SUS:1:0:312.4');
  const l = d.bbStatus().l;
  assert.deepEqual(
    { state: l.state, press: l.press, vent: l.vent, pressure: l.pressure },
    { state: 'SUS', press: true, vent: false, pressure: 312.4 }
  );
  assert.equal(l.stale, false);
});

test('a heartbeat with no pressure keeps the last one', () => {
  // The field is optional. Reading an absent value as 0 would report a
  // pressurised tank as empty for as long as the board omits it.
  const d = makeDriver();
  d.onLine('BB:l:SUS:1:0:312.4');
  d.onLine('BB:l:SUS:0:0');
  assert.equal(d.bbStatus().l.pressure, 312.4);
  assert.equal(d.bbStatus().l.press, false);
});

test('an unrecognised BB state is flagged, not adopted silently', () => {
  const seen = [];
  const d = makeDriver({ onEvent: (m, level) => seen.push([m, level]) });
  d.onLine('BB:l:SUSTAIN:1:0:312.4');
  assert.equal(d.bbStatus().l.stateValid, false);
  assert.ok(seen.some(([m, l]) => l === 'error' && /unrecognised state/.test(m)),
    'a client deriving "enabled" from state != OFF reads garbage as ENABLED');
});

test('CFG_PUSH is parsed structurally, commas and all', () => {
  // The comma in the detail is what the reference implementation trips over:
  // it tests for a comma before the prefix and files every config
  // confirmation as telemetry, so none of them ever reach the operator.
  const d = makeDriver();
  d.onLine('EVT:184320:CFG_PUSH:l:sp=200.0,db=10.0,wait=500,maxOpen=0');
  const l = d.bbStatus().l;
  assert.deepEqual(l.confirmed, {
    setpoint: 200, deadbandFull: 10, waitMs: 500, maxOpenMs: 0,
  });
  assert.equal(l.echoes, true, 'this board is now known to echo');
});

test('Disarming! clears the bang-bang mirror, as the board force-safes', () => {
  const d = makeDriver();
  d.onLine('BB:l:SUS:1:0:312.4');
  d.onLine('Disarming!');
  const l = d.bbStatus().l;
  assert.equal(l.state, 'OFF');
  assert.equal(l.press, false);
});

test("bang-bang commands go out in the board's grammar", () => {
  const d = makeDriver();
  d.bbConfig('L', { setpoint: 470, deadbandFull: 30, waitMs: 250, maxOpenMs: 500 });
  d.bbVent('L', { trigger: 650, auto: true });
  d.bbEnable('L', true);
  d.bbManualVent('F', false);
  d.bbAbort('F');
  assert.deepEqual(d.sent, ['BL470.0,30.0,250,500', 'VL650.0,1', 'bL1', 'vF0', 'xF']);
});

test('a bang-bang write reports only that the bytes left the host', () => {
  // Firmware acceptance arrives later and separately, as a CFG_PUSH echo or a
  // BB_ERROR. Confusing the two is how a stand ends up regulating to a
  // setpoint nobody confirmed.
  const d = makeDriver();
  const res = d.bbEnable('L', true);
  assert.deepEqual(res, { ok: true, command: 'bL1' });
  assert.equal(d.bbStatus().l.state, 'OFF', 'nothing changes until the board says so');

  d.port.writable = false;
  assert.equal(d.bbEnable('L', false).ok, false);
  assert.equal(d.bbAbort('X').ok, false, 'a bad side is refused, not sent to the other one');
});

test('a BB_ERROR rejection reaches the caller', () => {
  const rejections = [];
  const d = makeDriver({ onBbError: (m) => rejections.push(m) });
  d.onLine('BB_ERROR: L deadband must be > 0');
  assert.deepEqual(rejections, ['BB_ERROR: L deadband must be > 0']);
});

test('firmware status lines surface as events', () => {
  const seen = [];
  const d = makeDriver({ onEvent: (m) => seen.push(m) });
  d.onLine('SEQ_START');
  d.onLine('BB_ERROR:overpressure');
  assert.deepEqual(seen, ['SEQ_START', 'BB_ERROR:overpressure']);
});

test('routine board chatter is not raised as an error', () => {
  // The board narrates normal operation. Logging all of it at error level
  // trains operators to ignore the log, which is where real faults appear.
  const seen = [];
  const d = makeDriver({ onEvent: (m, level) => seen.push([m, level]) });
  d.onLine('Solenoid Command: 3 | 0');
  d.onLine('Disarming!');
  d.onLine('BB_ERROR:overpressure');
  d.onLine('CMD_ERROR:bad token');

  assert.deepEqual(seen.map(([, l]) => l), ['info', 'info', 'error', 'error']);
});

test('t lines split at tLcCount, so a 12-field frame is 8 LC + 4 TC', () => {
  // Observed firmware sends 12 fields, not the 8+8 the old docs describe.
  const d = makeDriver();
  const values = Array.from({ length: 12 }, (_, i) => i + 1);
  d.onLine('t' + values.join(','));
  assert.equal(d.raw.get('lc0'), 1);
  assert.equal(d.raw.get('lc7'), 8);
  assert.equal(d.raw.get('tc0'), 9);
  assert.equal(d.raw.get('tc3'), 12);
  assert.equal(d.raw.get('tc4'), undefined);
});

test('reads apply per-sensor calibration and only surface mapped channels', () => {
  const d = makeDriver({
    ptInputMode: 'ma',
    channelMap: { pt0: 'PT-201' },
    config: {
      sensors: [{ id: 'PT-201', min: 0, max: 1000, calibration: { slope: 2, offset: 5 } }],
      valves: [],
    },
  });
  d.onLine('p12.0,12.0');          // two channels reported, one mapped
  const out = d.read();
  assert.deepEqual(Object.keys(out), ['PT-201']);
  assert.equal(out['PT-201'], 500 * 2 + 5);
});

test('partial chunks reassemble across reads', () => {
  const d = makeDriver({ ptInputMode: 'ma' });
  d.onData(Buffer.from('p1'));
  d.onData(Buffer.from('2.5,13.5\np14'));
  assert.equal(d.raw.get('pt0_ma'), 12.5);
  assert.equal(d.raw.get('pt1_ma'), 13.5);
  d.onData(Buffer.from('.5\n'));
  assert.equal(d.raw.get('pt0_ma'), 14.5);
});

test('safeAll disarms the board and drives every valve to its safe state', () => {
  const d = makeDriver({
    config: {
      sensors: [],
      valves: [
        { id: 'SV-FV', channel: 4, normallyOpen: true, safeState: 'open' },
        { id: 'SV-FP', channel: 2, normallyOpen: false, safeState: 'closed' },
      ],
    },
  });
  d.safeAll();
  // Stop the regulator and return predictive shutoff to its default, THEN
  // disarm. A side left in SUS would resume the moment the board is re-armed,
  // and `e<side>1` is refused once the arm latch is down — so this is the last
  // moment either can be put back to a state the host knows.
  assert.deepEqual(d.sent.slice(0, 5), ['bL0', 'bF0', 'eL0', 'eF0', 'r']);
  assert.ok(d.sent.includes('S40'));       // NO vent de-energized => open
  assert.ok(d.sent.includes('S20'));       // NC press de-energized => closed
});

test('armHardware can be disabled for boards without an arm latch', () => {
  const on = makeDriver({ armHardware: true });
  on.setArmed(true);
  assert.deepEqual(on.sent, ['a']);

  const off = makeDriver({ armHardware: false });
  off.setArmed(true);
  assert.deepEqual(off.sent, []);
});

// ------------------------------------------------------ GC link heartbeat ---

test('the heartbeat goes out before the board has said anything', () => {
  // This is what arms the board's watchdog in the first place. With lastRxAt
  // still 0, a naive staleness check reads as infinitely stale and would
  // suppress the very first beat, leaving the watchdog dormant forever.
  const d = makeDriver();
  d.sendGcHeartbeat();
  assert.deepEqual(d.sent, ['h']);
});

test('the heartbeat keeps going while the board is talking', () => {
  const d = makeDriver();
  d.onLine('LINK:1:0:0');
  d.sent.length = 0;
  d.sendGcHeartbeat();
  d.sendGcHeartbeat();
  assert.deepEqual(d.sent, ['h', 'h']);
});

test('the heartbeat is WITHHELD once the board goes quiet', () => {
  // A one-way failure: our RX is dead, the port is still writable. Beating on
  // would hold the board's watchdog open on a stand we can no longer see.
  const d = makeDriver();
  d.onLine('LINK:1:0:0');
  d.lastRxAt = Date.now() - 5000;
  d.sent.length = 0;

  const events = [];
  d.onEvent = (message, level) => events.push({ message, level });
  d.sendGcHeartbeat();

  assert.deepEqual(d.sent, [], 'must not beat while deaf to the board');
  assert.equal(events.length, 1);
  assert.equal(events[0].level, 'error');
  assert.match(events[0].message, /withheld/);
});

test('withholding warns once, not once per beat', () => {
  const d = makeDriver();
  d.onLine('LINK:1:0:0');
  d.lastRxAt = Date.now() - 5000;
  const events = [];
  d.onEvent = (message, level) => events.push({ message, level });
  for (let i = 0; i < 20; i++) d.sendGcHeartbeat();
  assert.equal(events.length, 1);
});

test('the heartbeat resumes when the board comes back', () => {
  const d = makeDriver();
  d.onLine('LINK:1:0:0');
  d.lastRxAt = Date.now() - 5000;
  d.sendGcHeartbeat();
  d.sent.length = 0;

  d.onLine('LINK:1:0:0');          // board is talking again
  d.sendGcHeartbeat();
  assert.deepEqual(d.sent, ['h']);
});

test('a heartbeat is never sent to an unwritable port', () => {
  const d = makeDriver();
  d.port.writable = false;
  d.sendGcHeartbeat();
  assert.deepEqual(d.sent, []);
});

// -------------------------------------------------- link watchdog mirror ---

test('an unarmed board watchdog is reported as an error, not a note', () => {
  const d = makeDriver();
  const events = [];
  d.onEvent = (message, level) => events.push({ message, level });

  // Held back at first: at startup armed=0 only means our first beat has not
  // been processed yet.
  for (let i = 0; i < 50; i++) d.onLine('LINK:0:0:0');
  assert.equal(events.filter((e) => /NOT ARMED/.test(e.message)).length, 0);

  for (let i = 0; i < 80; i++) d.onLine('LINK:0:0:0');
  const alarm = events.filter((e) => /NOT ARMED/.test(e.message));
  assert.equal(alarm.length, 1, 'exactly one alarm, not one per line');
  assert.equal(alarm[0].level, 'error');
});

test('the watchdog arming is reported, and re-arms the alarm', () => {
  const d = makeDriver();
  const events = [];
  d.onEvent = (message, level) => events.push({ message, level });

  for (let i = 0; i < 130; i++) d.onLine('LINK:0:0:0');
  d.onLine('LINK:1:0:100');
  assert.ok(events.some((e) => /watchdog armed/.test(e.message)));
  assert.equal(d.link.armed, true);
});

test('board-reported link loss surfaces once per outage', () => {
  const d = makeDriver();
  const events = [];
  d.onEvent = (message, level) => events.push({ message, level });

  d.onLine('LINK:1:0:100');
  d.onLine('LINK:1:1:700');
  d.onLine('LINK:1:1:900');
  let loss = events.filter((e) => /link loss/.test(e.message));
  assert.equal(loss.length, 1);
  assert.equal(loss[0].level, 'error');

  d.onLine('LINK:1:0:100');       // recovered
  d.onLine('LINK:1:1:700');       // and lost again
  loss = events.filter((e) => /link loss/.test(e.message));
  assert.equal(loss.length, 2);
});

test('a malformed LINK line never reports the watchdog as armed', () => {
  const d = makeDriver();
  d.onLine('LINK:1:0:100');
  assert.equal(d.link.armed, true);
  d.onLine('LINK:x:0:0');          // garbage
  assert.equal(d.link.armed, true, 'garbage must not flip state either way');
  assert.match(d.status.detail, /watchdog armed/);
});

test('status surfaces the watchdog state, so an unarmed one is visible', () => {
  const d = makeDriver();
  d.detail = 'COM5 @ 460800';
  assert.match(d.status.detail, /NO LINK/);

  d.onLine('LINK:0:0:0');
  assert.match(d.status.detail, /WATCHDOG UNARMED/);
  assert.equal(d.status.link.armed, false);

  d.onLine('LINK:1:0:0');
  assert.match(d.status.detail, /watchdog armed/);

  d.onLine('LINK:1:1:800');
  assert.match(d.status.detail, /BOARD SEES LINK LOSS/);
});

test('firmware with no watchdog at all is called out, not left silent', () => {
  // The absence of a LINK: line cannot raise its own alarm, so this is the
  // one unprotected case that would otherwise pass unnoticed.
  const d = makeDriver();
  const events = [];
  d.onEvent = (message, level) => events.push({ message, level });

  d.onLine('p0.188');
  d.checkWatchdogPresence();
  assert.equal(events.length, 0, 'not before the grace period');

  d.firstRxAt = Date.now() - 15000;
  d.checkWatchdogPresence();
  d.checkWatchdogPresence();

  assert.equal(events.length, 1, 'exactly one warning');
  assert.equal(events[0].level, 'error');
  assert.match(events[0].message, /no comms watchdog/);
  assert.match(d.status.detail, /NO WATCHDOG IN FIRMWARE/);
});

test('a board that does send LINK: never trips the no-watchdog warning', () => {
  const d = makeDriver();
  const events = [];
  d.onEvent = (message, level) => events.push({ message, level });

  d.onLine('LINK:1:0:0');
  d.firstRxAt = Date.now() - 60000;
  d.checkWatchdogPresence();
  assert.equal(events.filter((e) => /no comms watchdog/.test(e.message)).length, 0);
});

test('a silent board does not trip the no-watchdog warning', () => {
  // Nothing arriving is a link fault, already reported as NO LINK. Blaming the
  // firmware for it would send someone to reflash a board that is fine.
  const d = makeDriver();
  const events = [];
  d.onEvent = (message, level) => events.push({ message, level });

  d.onLine('p0.188');
  d.firstRxAt = Date.now() - 60000;
  d.connected = false;
  d.checkWatchdogPresence();
  assert.equal(events.length, 0);
});

