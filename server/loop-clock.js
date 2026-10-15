/**
 * loop-clock.js — paces the control loop.
 *
 * A plain setInterval cannot hold the configured rate on Windows. Node timers
 * fire on the OS timer grid, ~15.6 ms there, so `setInterval(tick, 20)`
 * lands every 31 ms and a "50 Hz" loop measured 32.7 Hz. Every reading,
 * controller decision and recorded row ran a third slow.
 *
 * Two fixes, together:
 *
 *   1. Deadline scheduling. Each timer wake aims at an absolute deadline
 *      rather than "period from now", so grid rounding averages out instead
 *      of accumulating. On its own this holds the AVERAGE rate, but ticks
 *      jitter by up to a grid step.
 *
 *   2. Ticking on data. `poke()` is called whenever fresh sensor data lands.
 *      A pipe read wakes the event loop within ~0.5 ms (measured), so a DAQ
 *      sending frames at the loop rate locks the loop to them: every tick
 *      sees a value that just arrived, at the DAQ's own steady pace. The
 *      timer remains as the fallback for when data stops, so control never
 *      waits on a sensor.
 *
 * Pokes are held to the loop rate (see poke()), so data arriving faster than
 * the loop cannot speed it up.
 */

const EARLY_MS = 1;         // a timer wake this close to its deadline counts
// A frame may tick up to (1 - MIN_GAP) of a period before it is due, which
// covers frame jitter (measured p95 ~0.5 ms). Frames arriving faster than the
// loop cannot speed it up: the schedule advances a full period per tick.
const MIN_GAP = 0.9;
const POKE_GRACE = 1.5;     // after a data tick, the timer waits this many periods

export class LoopClock {
  constructor({
    hz,
    onTick,
    now = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.period = 1000 / hz;
    this.onTick = onTick;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.lastTick = -Infinity;
    this.deadline = 0;
    this.dataDue = -Infinity;   // when the next frame is expected, see poke()
  }

  start() {
    this.running = true;
    this.deadline = this.now() + this.period;
    this.schedule();
  }

  stop() {
    this.running = false;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  /**
   * Fresh data has arrived: tick now unless it is early for the frame
   * schedule.
   *
   * "Early" is judged against when this frame was DUE, not against when the
   * last tick happened to run. Judged against the last tick, one frame
   * handled 3 ms late made the next, on-time frame look 3 ms early, so it
   * was skipped and that tick ran off the timer with 13 ms old data.
   */
  poke() {
    if (!this.running) return;
    const now = this.now();
    const p = this.period;
    if (now < this.dataDue - p * (1 - MIN_GAP)) return;
    if (now - this.lastTick < p * 0.5) return;   // never two ticks back to back
    this.fire(now);
    // Stay on the frame schedule while frames are near it, so a late one
    // does not shift the next. Far off it (first frame, data resuming, a
    // stall) and the schedule restarts from this frame.
    const onSchedule = Math.abs(now - this.dataDue) <= p * 0.5;
    this.dataDue = (onSchedule ? this.dataDue : now) + p;
    // Give the next frame room to arrive and drive the next tick; the timer
    // only steps in if it does not.
    this.deadline = now + this.period * POKE_GRACE;
    this.schedule();
  }

  onTimer() {
    this.timer = null;
    if (!this.running) return;
    const now = this.now();
    if (now >= this.deadline - EARLY_MS) {
      this.fire(now);
      this.deadline += this.period;
      // Fell a whole period behind (a stalled host, a debugger): skip the
      // missed ticks rather than bursting through them back to back.
      if (this.deadline <= now) this.deadline = now + this.period;
    }
    this.schedule();
  }

  fire(now) {
    this.lastTick = now;
    try {
      this.onTick();
    } catch (err) {
      // A throwing tick must not stop the clock: valves, ARM and ABORT run
      // from here.
      console.error(`[loop] tick failed: ${err.stack || err.message}`);
    }
  }

  schedule() {
    this.clearTimer(this.timer);
    if (!this.running) return;
    const delay = Math.max(0, this.deadline - this.now());
    this.timer = this.setTimer(() => this.onTimer(), delay);
  }
}
