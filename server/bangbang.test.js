/**
 * Tests for the ground station's half of the board-resident bang-bang loop.
 *
 *   node --test server/bangbang.test.js
 *
 * The regulator itself runs on the PANDA, so the properties worth asserting
 * here are not "does the band work" — that is the board's job, and
 * bb-firmware.test.js covers the emulation of it. What matters here is the
 * boundary:
 *
 *   1. THE HOST NEVER COMMANDS THE VALVE. Not on a trip, not on a disarm, not
 *      on an abort. The strongest thing it may do is tell the board to stop.
 *      Two controllers on one solenoid is the hazard §5.7 documents.
 *   2. THE DEADBAND IS DOUBLED ON THE WIRE. GC-4 speaks ± half-bands, the
 *      board's `B` takes the full width.
 *   3. NOTHING IS ENABLED ON UNCONFIRMED CONFIG (§5.6), and
 *   4. NOTHING EVER GATES A STOP.
 *
 * The fake board below is the real BangBangFirmware driven over the real wire
 * format, so these are end-to-end through the protocol rather than against a
 * mock that agrees with us by construction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BangBangBank, boardConfig, echoMatches } from './bangbang.js';
import { BangBangFirmware } from './hal/bb-firmware.js';
import { parseLine } from './hal/bb-protocol.js';

/**
 * A stand-in for the PANDA that records every byte it is sent and answers in
 * the board's own language. `echoes` off simulates firmware that never sends
 * CFG_PUSH, which the enable gate has to cope with.
 */
class FakeBoard {
  constructor({ echoes = true } = {}) {
    this.status = { name: 'fake-panda' };
    this.sent = [];
    this.echoes = echoes;
    this.seenEcho = false;
    this.sides = { l: fresh(), f: fresh() };
    this.fw = new BangBangFirmware({ onLine: (line) => this.receive(line), now: 0 });
  }

  receive(line) {
    const msg = parseLine(line);
    if (msg.kind === 'heartbeat') {
      Object.assign(this.sides[msg.side], {
        state: msg.state, stateValid: msg.stateValid,
        press: msg.press, vent: msg.vent, lastBeatAt: Date.now(),
      });
      if (msg.pressure !== undefined) this.sides[msg.side].pressure = msg.pressure;
    } else if (msg.kind === 'event' && msg.category === 'CFG_PUSH' && this.echoes) {
      this.seenEcho = true;
      Object.assign(this.sides[msg.side].confirmed, msg.config.fields);
    }
  }

  /** Every bb* method funnels here, so `sent` is the literal wire traffic. */
  wire(line) { this.sent.push(line); this.fw.command(line); return { ok: true, command: line }; }

  bbConfig(side, cfg) { return this.wire(`B${side}${cfg.setpoint.toFixed(1)},${cfg.deadbandFull.toFixed(1)},${Math.round(cfg.waitMs)},${Math.round(cfg.maxOpenMs)}`); }
  bbVent(side, cfg) { return this.wire(`V${side}${cfg.trigger.toFixed(1)},${cfg.auto ? 1 : 0}`); }
  bbEnable(side, on) { return this.wire(`b${side}${on ? 1 : 0}`); }
  bbManualVent(side, open) { return this.wire(`v${side}${open ? 1 : 0}`); }
  bbAbort(side) { return this.wire(`x${side}`); }

  /** Set by BangBangBank.attach(), exactly as the real drivers expose it. */
  onBbError = null;

  bbStatus() {
    const out = {};
    for (const [k, s] of Object.entries(this.sides)) {
      out[k] = { ...s, stale: false, confirmed: { ...s.confirmed }, echoes: this.seenEcho };
    }
    return out;
  }

  /** Advance the emulated board, so heartbeats and state changes happen. */
  tick(pressures, now) { this.fw.update(pressures, now); }
}

function fresh() {
  return { state: 'OFF', stateValid: true, press: false, vent: false, pressure: null, lastBeatAt: 0, confirmed: {} };
}

/** Minimal StandController stand-in. Records anything aimed at a valve. */
function makeStand(overrides = {}, driverOpts = {}) {
  const bb = {
    id: 'bb-ox', name: 'Ox Press', side: 'L', sensor: 'PT4',
    valve: 'SV-LOXBB', ventValve: 'SV-LOXV',
    setpoint: 100, deadband: 10,
    setpointMin: 0, setpointMax: 1000, deadbandMin: 1, deadbandMax: 100,
    enabled: false, requiresArm: false,
    maxOpenSeconds: 0, maxOpenMs: 0, minIntervalMs: 0,
    ventTrigger: null, ventAuto: false,
    ...overrides,
  };
  const valves = [
    { id: 'SV-LOXBB', name: 'LOx Tank BB', safeState: 'closed', normallyOpen: false },
    { id: 'SV-LOXV', name: 'LOx GN2 Vent', safeState: 'open', normallyOpen: true },
  ];
  const stand = {
    armed: true,
    driver: new FakeBoard(driverOpts),
    config: { bangbang: [bb] },
    configStore: {
      controller: (id) => (id === bb.id ? bb : null),
      valve: (id) => valves.find((v) => v.id === id) || null,
    },
    valveStates: { 'SV-LOXBB': 'closed', 'SV-LOXV': 'open' },
    valveMeta: {},
    commands: [],
    logs: [],
    aborts: [],
    // If anything ever calls this, the host is driving a valve and the whole
    // architecture has regressed.
    commandValve(id, state) { this.commands.push(`${id}=${state}`); return { ok: true }; },
    log(level, message) { this.logs.push(`${level}: ${message}`); },
    abort(reason) { this.aborts.push(reason); },
    emit() {},
  };
  stand.cfg = bb;
  return stand;
}

/** Bring a controller all the way up: push config, confirm, enable, running. */
function bringUp(bank, stand, pressure = 50, t = 0) {
  bank.set('bb-ox', { enabled: true });
  stand.driver.tick({ l: pressure }, t);
  bank.update({ PT4: pressure }, t);            // sends bL1 once confirmed
  stand.driver.tick({ l: pressure }, t + 10);
  bank.update({ PT4: pressure }, t + 10);
  return stand.driver.sent;
}

// ------------------------------------------------------- the wire contract ---

test('the deadband is doubled on the way to the board', () => {
  // GC-4 says "±15". The board's B takes the FULL band width. Half or twice
  // the intended band is exactly the kind of error that reads as plausible
  // right up until the tank is 15 psi past where anyone expects.
  const stand = makeStand({ setpoint: 470, deadband: 15, minIntervalMs: 250, maxOpenMs: 500 });
  const bank = new BangBangBank(stand);
  bank.pushAll('test');

  assert.equal(stand.driver.sent[0], 'BL470.0,30.0,250,500');
  assert.deepEqual(boardConfig(bank.get('bb-ox')), {
    setpoint: 470, deadbandFull: 30, waitMs: 250, maxOpenMs: 500,
  });
});

test('a vent config is only pushed when a trigger is set', () => {
  const plain = makeStand();
  new BangBangBank(plain).pushAll('test');
  assert.deepEqual(plain.driver.sent, ['BL100.0,20.0,0,0']);

  const vented = makeStand({ ventTrigger: 650, ventAuto: true });
  new BangBangBank(vented).pushAll('test');
  assert.deepEqual(vented.driver.sent, ['BL100.0,20.0,0,0', 'VL650.0,1']);
});

test('changing a setpoint re-pushes it, mid-run', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);
  stand.driver.sent.length = 0;

  bank.set('bb-ox', { setpoint: 120 });
  assert.deepEqual(stand.driver.sent, ['BL120.0,20.0,0,0']);

  // A no-op edit is not traffic. The board is on a shared serial link with
  // the telemetry stream; re-pushing an unchanged config on every UI keypress
  // is bytes taken from the thing we actually need to arrive.
  stand.driver.sent.length = 0;
  bank.set('bb-ox', { setpoint: 120 });
  assert.deepEqual(stand.driver.sent, []);
});

// --------------------------------------------------- the host drives nothing ---

test('the host never commands the valve — not once, in a full run', () => {
  const stand = makeStand({ maxOpenSeconds: 5, abortAbove: 900 });
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);

  for (let t = 0; t < 3000; t += 100) {
    stand.driver.tick({ l: 50 + t / 30 }, t);
    bank.update({ PT4: 50 + t / 30 }, t);
  }

  assert.deepEqual(stand.commands, [],
    'the ground station must not actuate a valve the board is regulating');
  assert.ok(stand.driver.sent.every((c) => /^[BVMbvx][LF]/.test(c)),
    `only bang-bang commands should have been sent, got ${stand.driver.sent}`);
});

test('the board owns its valves, so manual commands can be refused', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  assert.equal(bank.ownedValves().size, 0, 'nothing owned while OFF');

  bringUp(bank, stand);
  const owned = bank.ownedValves();
  assert.deepEqual([...owned.keys()].sort(), ['SV-LOXBB', 'SV-LOXV']);
  assert.equal(bank.isLive('bb-ox'), true);
});

// ------------------------------------------------------- the enable handshake ---

test('b<side>1 is not sent until the board echoes the config', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  // This board DOES echo — we have seen one before — but this particular echo
  // is swallowed, so the gate must hold rather than fall through.
  stand.driver.echoes = false;
  stand.driver.seenEcho = true;

  bank.set('bb-ox', { enabled: true });
  assert.deepEqual(stand.driver.sent, ['BL100.0,20.0,0,0'], 'config only, so far');

  bank.update({ PT4: 50 }, 100);
  assert.deepEqual(stand.driver.sent, ['BL100.0,20.0,0,0'], 'still waiting on the echo');
});

test('once confirmed, the enable goes out and the board starts', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);

  assert.deepEqual(stand.driver.sent, ['BL100.0,20.0,0,0', 'bL1']);
  assert.equal(bank.snapshot()['bb-ox'].board.state, 'SUS');
  assert.equal(bank.snapshot()['bb-ox'].confirmed, true);
  assert.equal(bank.snapshot()['bb-ox'].awaiting, null);
});

test('an echo that never arrives drops the request rather than guessing', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  stand.driver.echoes = false;
  stand.driver.seenEcho = true;         // this board DOES echo — so silence is a fault

  bank.set('bb-ox', { enabled: true });
  bank.update({ PT4: 50 }, 100);
  assert.equal(bank.get('bb-ox').enabled, true, 'still inside the window');

  bank.update({ PT4: 50 }, 5000);
  assert.equal(bank.get('bb-ox').enabled, false);
  assert.equal(bank.get('bb-ox').fault, 'Config not confirmed');
  assert.ok(!stand.driver.sent.includes('bL1'),
    'must never enable on a setpoint the board has not confirmed');
});

test('a board that has never echoed is enabled, loudly', () => {
  // §5.6 applied literally would make firmware without CFG_PUSH impossible to
  // use at all. It is enabled — with a warning naming what could not be
  // verified, so nobody discovers it from the pressure trace.
  const stand = makeStand({}, { echoes: false });
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);

  assert.ok(stand.driver.sent.includes('bL1'));
  assert.ok(stand.logs.some((l) => l.startsWith('warn:') && /never sent a CFG_PUSH/.test(l)),
    `expected a warning about the missing echo, got ${JSON.stringify(stand.logs)}`);
});

test('the echo is compared field by field, not merely counted', () => {
  const wire = { setpoint: 470, deadbandFull: 30, waitMs: 250, maxOpenMs: 500 };
  assert.equal(echoMatches(wire, { ...wire }), true);
  assert.equal(echoMatches(wire, { ...wire, deadbandFull: 15 }), false, 'half-band echoed back');
  assert.equal(echoMatches(wire, { setpoint: 470 }), false, 'partial echo');
  assert.equal(echoMatches(wire, {}), false);
  assert.equal(echoMatches(wire, null), false);
  // Float formatting round-trips through one decimal place, so exact equality
  // would reject a perfectly good echo.
  assert.equal(echoMatches({ ...wire, setpoint: 470.04 }, wire), true);
});

// -------------------------------------------------------------- stopping ---

test('a disable is never gated on anything', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);
  stand.driver.sent.length = 0;

  bank.set('bb-ox', { enabled: false });
  assert.deepEqual(stand.driver.sent, ['bL0'], 'straight out, no handshake');
});

test('disarming tells the board to stop, and does not touch a valve', () => {
  const stand = makeStand({ requiresArm: true });
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);
  stand.driver.sent.length = 0;

  stand.armed = false;
  bank.update({ PT4: 50 }, 1000);

  assert.deepEqual(stand.driver.sent, ['bL0']);
  assert.deepEqual(stand.commands, []);
  assert.equal(bank.get('bb-ox').fault, 'Disarmed');
});

test('a board that ignores a stop is retried, but not at the tick rate', () => {
  // The retry matters: the first bL0 may simply have been lost. The rate
  // limit matters more — fifty stop commands a second go down the same serial
  // link the board needs in order to answer, and bury the reason in the log.
  const stand = makeStand({ requiresArm: true });
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);
  stand.driver.sent.length = 0;
  stand.logs.length = 0;

  // A board that keeps reporting SUS: the disarm never took.
  stand.driver.bbStatus = () => ({ l: { ...fresh(), state: 'SUS', stale: false, echoes: true } });
  stand.armed = false;
  for (let t = 0; t < 3000; t += 20) bank.update({ PT4: 50 }, t);   // 150 ticks

  assert.ok(stand.driver.sent.every((c) => c === 'bL0'));
  assert.equal(stand.driver.sent.length, 3, 'once per second, not once per tick');
  assert.equal(stand.logs.length, 3);
});

test('the leak trip watches the board\'s press bit, then tells it to stop', () => {
  const stand = makeStand({ maxOpenSeconds: 2 });
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);
  stand.driver.sent.length = 0;

  // Pressure never rises, so the board holds the press valve open.
  for (let t = 100; t <= 2500; t += 100) {
    stand.driver.tick({ l: 10 }, t);
    bank.update({ PT4: 10 }, t);
  }

  assert.equal(bank.get('bb-ox').enabled, false);
  assert.match(bank.get('bb-ox').fault, /Valve open > 2s/);
  assert.deepEqual(stand.driver.sent, ['bL0']);
  assert.deepEqual(stand.commands, [], 'the trip stops the board; it does not close the valve');
});

test('a stale heartbeat is reported but does NOT stop the controller', () => {
  // The board keeps regulating when the link dies — that is the entire reason
  // the loop lives there. Losing the heartbeat means we stopped watching, not
  // that anything stopped happening.
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);

  const realStatus = stand.driver.bbStatus.bind(stand.driver);
  stand.driver.bbStatus = () => {
    const s = realStatus();
    s.l.stale = true;
    return s;
  };
  stand.driver.sent.length = 0;
  bank.update({ PT4: 50 }, 9000);

  assert.equal(bank.get('bb-ox').enabled, true, 'must not drop control on a lost link');
  assert.equal(bank.get('bb-ox').fault, 'No heartbeat from board');
  assert.deepEqual(stand.driver.sent, []);
});

// ----------------------------------------------------------- abort threshold ---

test('either transducer can trip the abort threshold', () => {
  // The board regulates on its own PT; the stand's process value comes from
  // the DAQ. If they disagree about an over-pressure, the one shouting wins.
  const hostSide = makeStand({ abortAbove: 200 });
  const bankA = new BangBangBank(hostSide);
  bringUp(bankA, hostSide);
  hostSide.driver.sent.length = 0;
  bankA.update({ PT4: 260 }, 1000);          // DAQ high, board reading 50
  assert.equal(hostSide.aborts.length, 1);
  assert.match(hostSide.aborts[0], /^PT4 = 260\.0 exceeded abort limit 200$/);
  assert.deepEqual(hostSide.driver.sent, ['bL0', 'xL']);

  const boardSide = makeStand({ abortAbove: 200 });
  const bankB = new BangBangBank(boardSide);
  bringUp(bankB, boardSide, 260);            // board PT high, DAQ quiet
  bankB.update({ PT4: 50 }, 1000);
  assert.equal(boardSide.aborts.length, 1);
  assert.match(boardSide.aborts[0], /^board PT \(side L\) = 260\.0 exceeded abort limit 200/);
});

test('a per-side abort is latched, and the board refuses to restart', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  bringUp(bank, stand);

  bank.set('bb-ox', { abort: true });
  stand.driver.tick({ l: 50 }, 2000);
  bank.update({ PT4: 50 }, 2000);
  assert.equal(bank.snapshot()['bb-ox'].board.state, 'ABT');

  const res = bank.set('bb-ox', { enabled: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /latched in ABORT/);
});

// ----------------------------------------------------- mirroring and display ---

test('the board\'s heartbeat drives what the P&ID shows', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  bringUp(bank, stand, 10);                   // low pressure -> the board presses

  assert.equal(stand.valveStates['SV-LOXBB'], 'open');
  assert.equal(stand.valveMeta['SV-LOXBB'].source, 'board');

  // A normally-open vent reports a COIL state, and coil-energised is
  // flow-closed. Reading the bit straight through would draw an open vent on
  // a tank that is sealed.
  assert.equal(stand.valveStates['SV-LOXV'], 'open', 'de-energised NO vent reads open');
});

test('nothing is mirrored while the board is OFF', () => {
  // In OFF the press bit reports the regulator's own demand, which says
  // nothing about a solenoid an operator has since driven by hand.
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  stand.valveStates['SV-LOXBB'] = 'open';     // opened manually
  bank.update({ PT4: 50 }, 0);
  assert.equal(stand.valveStates['SV-LOXBB'], 'open');
});

test('the snapshot separates what we asked for from what the board says', () => {
  const stand = makeStand({ setpoint: 470, deadband: 15 });
  const bank = new BangBangBank(stand);
  bringUp(bank, stand, 300);

  const snap = bank.snapshot()['bb-ox'];
  assert.equal(snap.side, 'L');
  assert.equal(snap.setpoint, 470, 'our request, in ± half-band units');
  assert.equal(snap.deadband, 15);
  assert.equal(snap.board.confirmed.deadbandFull, 30, 'the board echoes the full width');
  assert.equal(snap.board.state, 'SUS');
  assert.equal(snap.output, snap.board.press, 'output is now an observation');
});

// ------------------------------------------------------ validation, unchanged ---

test('a controller with no board side cannot be commanded at all', () => {
  const stand = makeStand({ side: undefined });
  const bank = new BangBangBank(stand);
  const res = bank.set('bb-ox', { enabled: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /no board side configured/);
});

test('a pulse at least as long as the leak trip is refused, and changes nothing', () => {
  const stand = makeStand({ maxOpenSeconds: 2, maxOpenMs: 500 });
  const bank = new BangBangBank(stand);
  stand.driver.sent.length = 0;

  const res = bank.set('bb-ox', { maxOpenMs: 2000 });
  assert.equal(res.ok, false);
  assert.match(res.error, /must be shorter than the leak trip/);
  assert.equal(bank.get('bb-ox').maxOpenMs, 500, 'rejected edits change nothing');
  assert.deepEqual(stand.driver.sent, [], 'and reach the board not at all');
});

test('the pulse/trip check judges the merged result, not one field at a time', () => {
  const stand = makeStand({ maxOpenSeconds: 2, maxOpenMs: 500 });
  const bank = new BangBangBank(stand);
  // Individually each half is illegal against the current other half; together
  // they land somewhere legal.
  assert.equal(bank.set('bb-ox', { maxOpenMs: 5000, maxOpenSeconds: 30 }).ok, true);
  assert.equal(bank.get('bb-ox').maxOpenMs, 5000);
});

test('auto-vent needs somewhere to vent at', () => {
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  assert.equal(bank.set('bb-ox', { ventAuto: true }).ok, false);
  assert.equal(bank.set('bb-ox', { ventAuto: true, ventTrigger: 650 }).ok, true);
  assert.ok(stand.driver.sent.includes('VL650.0,1'));
});

test('a config reload keeps runtime settings, including a threshold turned OFF', () => {
  const stand = makeStand({ abortAbove: 700 });
  const bank = new BangBangBank(stand);
  bank.set('bb-ox', { abortAbove: null, setpoint: 250 });

  bank.sync();      // as a hot-reload would

  assert.equal(bank.get('bb-ox').abortAbove, null,
    'a threshold an operator turned off must not be switched back on by a reload');
  assert.equal(bank.get('bb-ox').setpoint, 250);
});

test('a board rejection is attributed to whatever was in flight', () => {
  // BB_ERROR is free text and is never parsed, so a side cannot be read out of
  // it. Attribution is by what was waiting on an answer instead — and when
  // nothing was, the message stays stand-level rather than being pinned on a
  // controller that had nothing to do with it.
  const stand = makeStand();
  const bank = new BangBangBank(stand);
  bank.attach();

  stand.driver.onBbError('BB_ERROR: L deadband must be > 0');
  assert.equal(bank.get('bb-ox').lastError, null, 'nothing was in flight');

  stand.driver.echoes = false;
  stand.driver.seenEcho = true;
  bank.set('bb-ox', { enabled: true });
  bank.update({ PT4: 50 }, 0);                 // now mid-handshake
  stand.driver.onBbError('BB_ERROR: L deadband must be > 0');
  assert.equal(bank.get('bb-ox').lastError, 'BB_ERROR: L deadband must be > 0');
  assert.match(bank.snapshot()['bb-ox'].lastError, /deadband/);
});

test('setAll keeps going when one controller refuses', () => {
  const stand = makeStand({ requiresArm: true });
  stand.config.bangbang.push({ ...stand.cfg, id: 'bb-fuel', side: 'F', name: 'Fuel Press' });
  const byId = Object.fromEntries(stand.config.bangbang.map((c) => [c.id, c]));
  stand.configStore.controller = (id) => byId[id] || null;
  const bank = new BangBangBank(stand);
  stand.armed = false;

  const res = bank.setAll({ enabled: true }, 'test');
  assert.equal(res.ok, false);
  assert.match(res.error, /bb-ox/);
  assert.match(res.error, /bb-fuel/, 'both refusals are reported, not just the first');
});
