/**
 * Tests for the emulated PANDA bang-bang regulator.
 *
 *   node --test server/hal/bb-firmware.test.js
 *
 * This is a stand-in for the board, so what is asserted here is what the board
 * is BELIEVED to do — §5 of HANDOVER_COMMS.md — not what it has been observed
 * to do. Where the spec is silent the emulation had to choose, and those
 * choices are called out both here and in bb-firmware.js. Treat a failure here
 * as "the emulation drifted from the spec", and treat a disagreement with real
 * hardware as "the spec was wrong", not as a reason to change these.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BangBangFirmware } from './bb-firmware.js';
import { parseLine } from './bb-protocol.js';

/** A firmware plus a transcript of everything it said. */
function board(opts = {}) {
  const lines = [];
  const fw = new BangBangFirmware({ onLine: (l) => lines.push(l), now: 0, ...opts });
  return {
    fw,
    lines,
    /** Configure side L at 100 psi ± 10 (a 20 psi full band) and start it. */
    start(extra = '') {
      fw.command(`BL100.0,20.0,${extra || '0,0'}`);
      fw.command('bL1');
      return this;
    },
    beats: () => lines.filter((l) => l.startsWith('BB:')).map(parseLine),
    last: () => lines.filter((l) => l.startsWith('BB:l')).map(parseLine).pop(),
  };
}

test('a config command is echoed back as CFG_PUSH', () => {
  const b = board();
  b.fw.command('BL450.0,30.0,250,500');

  const echo = b.lines.map(parseLine).find((m) => m.category === 'CFG_PUSH');
  assert.ok(echo, 'the board must confirm what it stored');
  assert.equal(echo.side, 'l');
  assert.deepEqual(
    { sp: echo.config.fields.setpoint, db: echo.config.fields.deadbandFull,
      wait: echo.config.fields.waitMs, max: echo.config.fields.maxOpenMs },
    { sp: 450, db: 30, wait: 250, max: 500 }
  );
});

test('the echo is per command, and uses the board\'s own key spellings', () => {
  // Observed on hardware 2026-08-27. A B followed by a V produces TWO
  // CFG_PUSH lines carrying only their own fields, and the vent keys are
  // avTrig/avAuto rather than the ventTrig/ventAuto §5.5 documents. Both
  // details matter: the host has to accumulate echoes to know the full
  // config, and it has to recognise the keys to accumulate anything at all.
  const b = board();
  b.fw.command('BL450.0,30.0,250,500');
  b.fw.command('VL650.0,1');

  const echoes = b.lines.filter((l) => l.includes('CFG_PUSH'));
  assert.equal(echoes.length, 2, 'one echo per command, not one for everything');
  assert.match(echoes[0], /:sp=450\.0,db=30\.0,wait=250,maxOpen=500$/);
  assert.match(echoes[1], /:avTrig=650\.0,avAuto=1$/);

  // Neither line alone is the whole config; assembling it is the host's job.
  const parsed = echoes.map((l) => parseLine(l).config);
  assert.equal(parsed[0].fields.ventTrigger, undefined);
  assert.deepEqual(Object.assign({}, ...parsed.map((p) => p.fields)), {
    setpoint: 450, deadbandFull: 30, waitMs: 250, maxOpenMs: 500,
    ventTrigger: 650, ventAuto: true,
  });
  assert.deepEqual(parsed.flatMap((p) => Object.keys(p.unknown)), [],
    'the emulation must not emit keys the parser does not know');
});

test('a deadband of zero is refused, not silently accepted', () => {
  const b = board();
  b.fw.command('BL100.0,0.0,0,0');
  assert.ok(b.lines.some((l) => l.startsWith('BB_ERROR:')),
    'a zero band makes the valve chatter at the setpoint; say so');
});

test('the hysteresis band opens low and closes high', () => {
  const b = board().start();

  b.fw.update({ l: 85 }, 100);          // below 100 - 10
  assert.equal(b.last().press, true);

  b.fw.update({ l: 95 }, 200);          // inside the band: no change
  assert.equal(b.last().press, true);

  b.fw.update({ l: 115 }, 300);         // above 100 + 10
  assert.equal(b.last().press, false);
});

test('max_open_ms cuts the pulse but leaves the loop running', () => {
  const b = board();
  b.fw.command('BL100.0,20.0,0,500');
  b.fw.command('bL1');

  b.fw.update({ l: 50 }, 0);            // opens
  assert.equal(b.last().press, true);
  b.fw.update({ l: 50 }, 600);          // 600 ms open, limit is 500
  assert.equal(b.last().press, false);
  assert.equal(b.last().state, 'SUS', 'cut short, not stopped');
});

test('wait_ms delays a reopen but never a close', () => {
  // The one property worth the most here. A dwell timer that can hold a
  // pressurization valve open past setpoint is not an anti-chatter feature,
  // it is the hazard.
  const b = board();
  b.fw.command('BL100.0,20.0,1000,0');
  b.fw.command('bL1');

  b.fw.update({ l: 50 }, 0);
  assert.equal(b.last().press, true);
  b.fw.update({ l: 150 }, 100);         // 100 ms later, far above the band
  assert.equal(b.last().press, false, 'a CLOSE is immediate, dwell or not');

  b.fw.update({ l: 50 }, 500);          // only 400 ms since the switch
  assert.equal(b.last().press, false, 'the reopen waits');
  b.fw.update({ l: 50 }, 1200);         // 1100 ms since the switch
  assert.equal(b.last().press, true);
});

test('auto-vent takes over above the trigger, and releases below it', () => {
  const b = board();
  b.fw.command('BL100.0,20.0,0,0');
  b.fw.command('VL200.0,1');
  b.fw.command('bL1');

  b.fw.update({ l: 250 }, 100);
  assert.equal(b.last().state, 'AV');
  assert.equal(b.last().vent, true);
  assert.equal(b.last().press, false, 'venting and pressing at once is nonsense');

  b.fw.update({ l: 150 }, 200);
  assert.equal(b.last().state, 'SUS');
  assert.equal(b.last().vent, false);
});

test('auto-vent does nothing while it is disarmed', () => {
  const b = board();
  b.fw.command('BL100.0,20.0,0,0');
  b.fw.command('VL200.0,0');            // trigger set, auto OFF
  b.fw.command('bL1');

  b.fw.update({ l: 250 }, 100);
  assert.equal(b.last().state, 'SUS', 'a trigger alone must not vent a tank');
});

test('a manual vent works in any state, including abort', () => {
  const b = board().start();
  b.fw.command('xL');
  assert.equal(b.last().state, 'ABT');

  b.fw.command('vL1');
  assert.equal(b.last().vent, true, 'opening a vent always makes a tank safer');
});

test('abort is latched — the board refuses to re-enter SUS', () => {
  const b = board().start();
  b.fw.command('xL');
  b.lines.length = 0;

  b.fw.command('bL1');
  assert.ok(b.lines.some((l) => l.startsWith('BB_ERROR:')),
    'a silent refusal would leave an operator waiting for a loop that never starts');
  assert.equal(b.fw.sides.l.state, 'ABT');
  assert.equal(b.beats().length, 0, 'a refusal is not a state change, so nothing beats');
});

test('abort closes the press valve and keeps it closed', () => {
  const b = board().start();
  b.fw.update({ l: 50 }, 100);
  assert.equal(b.last().press, true);

  b.fw.command('xL');
  b.fw.update({ l: 50 }, 200);
  assert.equal(b.last().press, false);
});

test('forceSafe drops both sides, mirroring the board\'s disarm', () => {
  const b = board();
  b.fw.command('BL100.0,20.0,0,0');
  b.fw.command('BF100.0,20.0,0,0');
  b.fw.command('bL1');
  b.fw.command('bF1');
  b.fw.update({ l: 50, f: 50 }, 100);

  b.fw.forceSafe(200);
  const outputs = b.fw.outputs();
  assert.deepEqual(outputs.l, { press: false, vent: false });
  assert.deepEqual(outputs.f, { press: false, vent: false });
  assert.equal(b.fw.sides.l.state, 'OFF');
  assert.equal(b.fw.sides.f.state, 'OFF');
});

test('the two sides are independent', () => {
  const b = board();
  b.fw.command('BL100.0,20.0,0,0');
  b.fw.command('BF400.0,20.0,0,0');
  b.fw.command('bL1');
  b.fw.update({ l: 50, f: 50 }, 100);

  assert.equal(b.fw.outputs().l.press, true);
  assert.equal(b.fw.outputs().f.press, false, 'F was never enabled');
});

test('heartbeats keep coming when nothing is happening', () => {
  const b = board({ heartbeatMs: 100 });
  b.fw.command('BL100.0,20.0,0,0');
  b.lines.length = 0;

  for (let t = 0; t <= 500; t += 50) b.fw.update({ l: 50 }, t);
  const beats = b.beats().filter((m) => m.side === 'l');
  assert.ok(beats.length >= 5, `expected a steady heartbeat, got ${beats.length}`);
  assert.ok(beats.every((m) => m.state === 'OFF'));
});

test('a state change is announced immediately, not at the next heartbeat', () => {
  const b = board({ heartbeatMs: 10000 }).start();
  const evt = b.lines.map(parseLine).find((m) => m.category === 'BB_STATE');
  assert.equal(evt.detail, 'OFF->SUS');
  assert.equal(b.last().state, 'SUS', 'and the heartbeat follows it out at once');
});

test('a non-bang-bang line is not consumed', () => {
  // The board has a whole other vocabulary — solenoids, arm, sequences — and
  // claiming a line that belongs to it would swallow the command.
  const b = board();
  assert.equal(b.fw.command('S31'), false);
  assert.equal(b.fw.command('a'), false);
  assert.equal(b.fw.command('p0.71,0.69'), false);
  assert.equal(b.fw.command('bL1'), true);
});

// ------------------------------------------------------------- PT tare ---

test('TL zeroes the side against its current reading', () => {
  const b = board();
  b.fw.update({ l: 12.5, f: 30.0 }, 100);
  b.fw.command('TL');
  b.fw.update({ l: 12.5, f: 30.0 }, 200);

  assert.equal(b.fw.sides.l.pressure, 0, 'the tared side reads zero at the pressure it was zeroed at');
  assert.equal(b.fw.sides.f.pressure, 30.0, 'the other side is untouched');
});

test('the offset persists, so the tared side tracks CHANGES from the zero', () => {
  const b = board();
  b.fw.update({ l: 12.5 }, 100);
  b.fw.command('TL');
  b.fw.update({ l: 112.5 }, 200);
  assert.equal(b.fw.sides.l.pressure, 100, '100 psi above the zero reads as 100');
});

test('the regulator runs on the TARED pressure, not the raw one', () => {
  // The whole reason the offset is applied on the way in. A board that
  // regulated on raw and reported tared would hold the wrong pressure and
  // look correct doing it.
  const b = board();
  b.fw.update({ l: 50 }, 100);
  b.fw.command('TL');                       // zero at 50: raw 50 now reads 0
  b.start();                                // setpoint 100 +/- 10
  b.fw.update({ l: 105 }, 200);             // raw 105 -> tared 55, well below the band
  assert.equal(b.fw.sides.l.press, true, 'still filling: tared 55 is under the 90 psi band floor');

  b.fw.update({ l: 165 }, 300);             // raw 165 -> tared 115, above the band
  assert.equal(b.fw.sides.l.press, false, 'stopped: tared 115 is over the 110 psi band ceiling');
});

test('an explicit offset sets the zero without needing a reading', () => {
  const b = board();
  b.fw.command('T0,20.0');
  b.fw.update({ l: 50 }, 100);
  assert.equal(b.fw.sides.l.pressure, 30);
});

test('Tz clears both channels at once', () => {
  const b = board();
  b.fw.update({ l: 10, f: 20 }, 100);
  b.fw.command('TL');
  b.fw.command('TF');
  b.fw.command('Tz');
  b.fw.update({ l: 10, f: 20 }, 200);
  assert.equal(b.fw.sides.l.pressure, 10);
  assert.equal(b.fw.sides.f.pressure, 20);
});

test('taring with no reading yet is refused, not silently zeroed', () => {
  // The failure an operator hits by taring before the board has data. A tare
  // that quietly did nothing would leave them believing a zero was applied.
  const b = board();
  b.fw.command('TL');
  assert.ok(b.lines.includes('PT_ERROR:no_data'), 'the board must say why');
  assert.equal(b.fw.sides.l.ptOffset, 0, 'and must not have moved the offset');
  assert.equal(parseLine('PT_ERROR:no_data').kind, 'error');
});

test('a successful tare is announced as a PT_TARE event', () => {
  const b = board();
  b.fw.update({ l: 12.5 }, 100);
  b.fw.command('TL');

  const evt = b.lines.map(parseLine).find((m) => m.category === 'PT_TARE');
  assert.ok(evt, 'success has to be confirmed, or GC cannot tell it from a dropped byte');
  assert.equal(evt.side, 'l');
  assert.equal(evt.detail, '12.5');
});

test('predictive shutoff is refused unless the board is armed', () => {
  const b = board();
  b.fw.command('eL1');

  assert.ok(b.lines.some((l) => l.startsWith('BB_ERROR:')), 'a disarmed board must reject it');
  assert.equal(b.fw.sides.l.predictive, false, 'and must not have stored it');
});

test('an armed board accepts predictive shutoff on both sides', () => {
  const b = board();
  b.fw.setArmed(true);
  b.fw.command('eL1');
  b.fw.command('eF1');

  assert.equal(b.fw.sides.l.predictive, true);
  assert.equal(b.fw.sides.f.predictive, true);
  assert.equal(b.lines.filter((l) => l.startsWith('BB_ERROR:')).length, 0);
});

test('predictive shutoff can be turned OFF while disarmed', () => {
  // The asymmetry the host depends on: the safe direction is never gated, so
  // a board can always be put back to its default even after the arm latch
  // has dropped.
  const b = board();
  b.fw.setArmed(true);
  b.fw.command('eL1');
  b.fw.setArmed(false);
  b.lines.length = 0;

  b.fw.command('eL0');
  assert.equal(b.fw.sides.l.predictive, false);
  assert.equal(b.lines.filter((l) => l.startsWith('BB_ERROR:')).length, 0, 'disabling is never refused');
});

test('disarming clears predictive shutoff on both sides', () => {
  const b = board();
  b.fw.setArmed(true);
  b.fw.command('eL1');
  b.fw.command('eF1');

  b.fw.setArmed(false);
  assert.equal(b.fw.sides.l.predictive, false);
  assert.equal(b.fw.sides.f.predictive, false);

  // And it stays cleared: re-enabling needs a deliberate command after ARM,
  // never a side effect of arming.
  b.fw.setArmed(true);
  assert.equal(b.fw.sides.l.predictive, false);
});

test('forceSafe clears predictive shutoff', () => {
  const b = board();
  b.fw.setArmed(true);
  b.fw.command('eL1');

  b.fw.forceSafe(1000);
  assert.equal(b.fw.sides.l.predictive, false, 'the abort path leaves the board at its defaults');
});
