import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopClock } from './loop-clock.js';

/**
 * A fake clock whose timers fire on a coarse grid, like Windows' ~15.6 ms
 * timer: a timeout fires at the first grid step at or after its due time.
 * That grid is the whole reason LoopClock exists, so the tests run on it.
 */
function harness({ hz = 50, gridMs = 15.625 } = {}) {
  let t = 0;
  let pending = null;   // { at, fn }
  const ticks = [];
  const clock = new LoopClock({
    hz,
    onTick: () => ticks.push(t),
    now: () => t,
    setTimer: (fn, ms) => {
      const due = t + ms;
      pending = { at: Math.ceil(due / gridMs) * gridMs, fn };
      return pending;
    },
    clearTimer: (h) => { if (h && pending === h) pending = null; },
  });
  /** Advance to `until`, firing timers and any pokes scheduled on the way. */
  function run(until, pokes = []) {
    const queue = [...pokes].sort((a, b) => a - b);
    for (;;) {
      const nextPoke = queue.length ? queue[0] : Infinity;
      const nextTimer = pending ? pending.at : Infinity;
      const next = Math.min(nextPoke, nextTimer);
      if (next > until) { t = until; return; }
      t = next;
      if (nextPoke <= nextTimer) { queue.shift(); clock.poke(); } else { const p = pending; pending = null; p.fn(); }
    }
  }
  return { clock, ticks, run };
}

const rate = (ticks) => (ticks.length - 1) / ((ticks.at(-1) - ticks[0]) / 1000);

test('on a 15.6 ms timer grid the timer alone still averages the configured rate', () => {
  // setInterval(20) on this grid runs at 32 Hz. Deadline scheduling must not.
  const { clock, ticks, run } = harness({ hz: 50 });
  clock.start();
  run(10_000);
  assert.ok(Math.abs(rate(ticks) - 50) < 1, `rate ${rate(ticks)}`);
});

test('data arriving at the loop rate drives the ticks, exactly on each frame', () => {
  const { clock, ticks, run } = harness({ hz: 50 });
  clock.start();
  // Frames every 20 ms, offset off the timer grid.
  const frames = Array.from({ length: 500 }, (_, i) => 3.3 + i * 20);
  run(10_000, frames);
  assert.ok(Math.abs(rate(ticks) - 50) < 0.5, `rate ${rate(ticks)}`);
  // Every frame produced a tick at the moment it arrived: none were left
  // waiting for the next timer step.
  const onFrame = frames.filter((f) => ticks.includes(f)).length;
  assert.ok(onFrame >= frames.length - 1, `${onFrame}/${frames.length} frames ticked on arrival`);
});

test('data arriving faster than the loop rate cannot speed the loop up', () => {
  const { clock, ticks, run } = harness({ hz: 50 });
  clock.start();
  run(10_000, Array.from({ length: 2000 }, (_, i) => i * 5));   // 200 Hz frames
  assert.ok(Math.abs(rate(ticks) - 50) < 1, `rate ${rate(ticks)}`);
  const odd = harness({ hz: 50 });
  odd.clock.start();
  odd.run(10_000, Array.from({ length: 1400 }, (_, i) => i * 7));  // 143 Hz, off-grid
  assert.ok(Math.abs(rate(odd.ticks) - 50) < 1, `rate ${rate(odd.ticks)}`);
});

test('one late frame does not cost the next, on-time frame its tick', () => {
  const { clock, ticks, run } = harness({ hz: 50 });
  clock.start();
  // Frames on a 20 ms schedule, except every 10th is handled 4 ms late (an
  // event loop busy with something else). The frame after it is on time and
  // must still tick on arrival, not wait for the timer.
  const frames = Array.from({ length: 500 }, (_, i) => 3.3 + i * 20 + (i % 10 === 5 ? 4 : 0));
  run(10_000, frames);
  const onFrame = frames.filter((f) => ticks.includes(f)).length;
  assert.ok(onFrame >= frames.length - 1, `${onFrame}/${frames.length} frames ticked on arrival`);
});

test('when data stops, the timer takes over without a gap', () => {
  const { clock, ticks, run } = harness({ hz: 50 });
  clock.start();
  run(2_000, Array.from({ length: 100 }, (_, i) => i * 20));   // data until 2 s
  const before = ticks.length;
  run(4_000);                                                   // then silence
  const after = ticks.filter((t) => t > 2_000);
  assert.ok(after.length >= 95, `${after.length} timer ticks in 2 s`);
  // The longest gap across the handover is bounded by the poke grace plus a
  // grid step, not by anything open-ended.
  const gaps = ticks.slice(before - 1).map((t, i, a) => (i ? t - a[i - 1] : 0));
  assert.ok(Math.max(...gaps) <= 20 * 1.5 + 15.625, `max gap ${Math.max(...gaps)}`);
});

test('after a stall the loop skips missed ticks instead of bursting', () => {
  const { clock, ticks, run } = harness({ hz: 50 });
  clock.start();
  run(1_000);
  // Simulate the host freezing for 500 ms: nothing fires, time jumps.
  const n = ticks.length;
  clock.stop();
  clock.running = true;
  clock.deadline = 1_020;
  run(1_500);         // no timer pending, so nothing runs
  clock.onTimer();    // the late wake
  run(1_600);
  const burst = ticks.slice(n).filter((t) => t === 1_500).length;
  assert.equal(burst, 1, 'one tick for the late wake, not 25');
});

test('a throwing tick does not stop the clock', () => {
  let count = 0;
  let t = 0;
  let pending = null;
  const clock = new LoopClock({
    hz: 50,
    onTick: () => { count++; throw new Error('boom'); },
    now: () => t,
    setTimer: (fn, ms) => (pending = { at: t + ms, fn }),
    clearTimer: () => { pending = null; },
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    clock.start();
    for (let i = 0; i < 5; i++) { t = pending.at; const p = pending; pending = null; p.fn(); }
  } finally {
    console.error = quiet;
  }
  assert.equal(count, 5);
});

test('stop() cancels the timer and ignores later pokes', () => {
  const { clock, ticks, run } = harness({ hz: 50 });
  clock.start();
  run(100);
  const n = ticks.length;
  clock.stop();
  run(1_000, [500, 600]);
  assert.equal(ticks.length, n);
});
