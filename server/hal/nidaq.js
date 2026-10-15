/**
 * nidaq.js — NI cDAQ acquisition via a Python sidecar.
 *
 * The NI-DAQmx bindings only exist for Python, so acquisition runs in
 * `devices/daq_streamer.py`, spawned as a child process. It streams
 * newline-delimited JSON on stdout and accepts commands on stdin.
 *
 * That stdin channel is the whole reason to prefer this over the previous
 * design: the old stack pushed telemetry one-way over TCP and had to smuggle
 * tare/calibration commands back by writing sentinel files into a directory
 * that the acquisition loop polled. A pipe is bidirectional, so commands are
 * just messages.
 *
 * CHANNEL ADDRESSING — the easiest thing to get wrong. DAQ channel indices
 * restart at 0 on every card, so "channel 3" is ambiguous on its own. GC-4's
 * config uses one flat channel number per sensor, so `channelMap` translates:
 *
 *     "pt0": "PT-101"     NI-9208 ai0  -> the sensor with that id
 *     "lc2": "LC-301"     NI-9237 ai2
 *     "tc1": "TC-301"     NI-9211 ai1  (spanning both 9211 modules)
 *
 * Anything not in the map is acquired and logged but never surfaces as a
 * sensor reading.
 *
 * TARING. `{action:'tare', card, channel, clear}` zeroes a channel against its
 * last raw sample, inside the sidecar and before conversion — so the zero
 * applies to the raw trace, not just to the display. `clear` puts the channel
 * back on its untared calibration. Only channels in `channelMap` are reachable
 * through `tareSensors`: an unmapped channel has no sensor to zero, and taring
 * one by accident moves a reading nobody is watching.
 *
 * Offsets are not tracked here. Every telemetry frame carries the offset the
 * sidecar is currently applying to each channel, so a sidecar restart cannot
 * leave this driver reporting a zero the hardware has forgotten.
 *
 * This driver is read-only: it has no actuation. Pair it with the PANDA
 * driver through `composite` for a stand that reads here and actuates there.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'devices', 'daq_streamer.py');

// Averaging window for the measured receive rate. Long enough that one late
// frame does not make the header flicker, short enough that a link degrading
// mid-test is visible while it is still degrading.
const RX_WINDOW_MS = 3000;
const RX_MIN_SPAN_S = 0.4;

// No channel data for this long and the DAQ is reported disconnected. Frames
// that arrive EMPTY do not count: a sidecar that is alive but reading nothing
// is, for everyone watching the gauges, a DAQ that is not there.
const DATA_TIMEOUT_MS = 2000;

/**
 * Samples per frame for one frame per control tick: 100 Hz clock / 50 Hz
 * loop = 2. Never below 1, so a loop faster than the clock gets a frame per
 * sample rather than a fraction. Falls back to 10 without a loop rate.
 */
export function framesPerTick(sampleClockHz, loopHz) {
  if (!(loopHz > 0) || !(sampleClockHz > 0)) return 10;
  return Math.max(1, Math.round(sampleClockHz / loopHz));
}

/** True when any channel in a telemetry frame carries at least one sample. */
function frameHasData(msg) {
  return (msg.channels || []).some((ch) => Array.isArray(ch.samples) && ch.samples.length > 0);
}

export class NiDaqDriver {
  constructor(options = {}) {
    this.name = 'nidaq';
    this.python = options.python || process.env.GC_PYTHON || 'python';
    this.chassis = options.chassis || 'cDAQ9189-2462EFD';
    this.sampleClockHz = Number(options.sampleClockHz || 100);
    // Samples per sidecar frame. Unset means one frame per control tick, worked
    // out in init() once the loop rate is known: only the latest value of
    // each frame reaches the stand, so frames slower than the loop leave
    // ticks re-reading an old value, and the old fixed 10 held PT at 10 Hz.
    this.samplesPerRead = options.samplesPerRead ? Number(options.samplesPerRead) : null;
    this.cards = options.cards || {};
    this.channelMap = options.channelMap || {};
    this.startupTimeoutMs = Number(options.startupTimeoutMs || 8000);
    this.detail = this.chassis;

    this.values = new Map();     // "<kind><index>" -> engineering value
    this.statuses = new Map();   // "<kind><index>" -> 'ok' | 'disconnected' | ...
    // Offset the sidecar is currently subtracting from each channel, in the
    // card's own units. Learned from the telemetry frames rather than tracked
    // here, so a sidecar restart cannot leave the host claiming a zero the
    // hardware is no longer applying.
    this.tares = new Map();      // "<kind><index>" -> offset
    // lastRxAt: when channel DATA last arrived — what the header ages from.
    // lastFrameAt: when the sidecar last said anything, data or not. The two
    // together tell "cards stopped reading" from "the sidecar went quiet".
    this.lastRxAt = 0;
    this.lastFrameAt = 0;
    // When acquisition was launched. Until the first data arrives, the header
    // counts from here rather than showing a bare NO LINK.
    this.startedAt = 0;
    this.connected = false;
    this.everConnected = false;
    this.lostReason = null;
    this.frameCount = 0;
    // Arrival times of recent frames, for the MEASURED receive rate. See
    // rxRates(). Bounded by age, not by count, so it self-limits at any rate.
    this.rxWindow = [];              // [{ t, n: {card: samples} }] per frame
    this.stdoutBuffer = '';
    this.child = null;
    this.onEvent = options.onEvent || (() => {});
  }

  async init(config) {
    this.config = config;
    this.samplesPerRead ??= framesPerTick(this.sampleClockHz, config?.telemetry?.sampleRateHz);

    const payload = {
      chassis: this.chassis,
      sampleClockHz: this.sampleClockHz,
      samplesPerRead: this.samplesPerRead,
      cards: this.cards,
    };

    this.startedAt = Date.now();
    this.child = spawn(this.python, ['-u', SCRIPT, JSON.stringify(payload)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) console.error(`[nidaq] ${line.trim()}`);
      }
    });
    this.child.on('exit', (code, signal) => {
      if (this.closing) { this.connected = false; return; }
      console.error(`[nidaq] streamer exited (code=${code} signal=${signal})`);
      // 143/SIGTERM means the whole process group is going down (Ctrl+C, a
      // service stop). That is a shutdown, not an acquisition fault, and
      // raising it as an error alarms the operator on a normal exit.
      const terminated = signal === 'SIGTERM' || signal === 'SIGINT' || code === 143 || code === 130;
      if (terminated) { this.closing = true; this.connected = false; return; }
      this.fail(`acquisition process exited (code ${code})`);
    });
    this.child.on('error', (err) => {
      this.fail(`could not start "${this.python}"`);
      console.error(`[nidaq] failed to spawn "${this.python}": ${err.message}`);
    });

    this.watchdog = setInterval(() => this.checkData(), 250);
    this.watchdog.unref?.();

    // Wait for the first real frame rather than a fixed delay, so the startup
    // banner and the first control ticks report a truthful link state. Card
    // configuration takes a second or two; give up after `startupTimeoutMs`
    // and let the watchdog report NO LINK rather than blocking the boot.
    const up = await this.waitForFirstFrame(this.startupTimeoutMs);
    // A DAQ that never delivers never makes an up->down transition, so the
    // watchdog would stay silent about it. Say so once, here.
    if (!up && !this.lostReason && !this.closing) {
      this.fail(this.lastFrameAt
        ? 'acquisition running but no card is returning samples'
        : `no data within ${Math.round(this.startupTimeoutMs / 1000)} s of startup`);
    }
    return this;
  }

  waitForFirstFrame(timeoutMs) {
    return new Promise((resolve) => {
      if (this.connected) return resolve(true);
      const started = Date.now();
      const poll = setInterval(() => {
        if (this.connected || Date.now() - started > timeoutMs) {
          clearInterval(poll);
          resolve(this.connected);
        }
      }, 50);
      poll.unref?.();
    });
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`[nidaq] unparseable frame: ${line.slice(0, 120)}`);
        continue;
      }

      if (msg.type === 'data') {
        for (const ch of msg.channels || []) {
          const key = `${ch.card}${ch.channel}`;
          const value = ch.card === 'pt' ? ch.pressure_psi
            : ch.card === 'lc' ? ch.lbf
            : ch.temp_f;
          this.statuses.set(key, ch.status);
          if (Number.isFinite(ch.tare)) this.tares.set(key, ch.tare);
          // null means the sidecar could not produce a reading (open input,
          // unconfigured channel). Leave the last good value in place and let
          // the status carry the fault, rather than writing null into control.
          if (value !== null && value !== undefined) this.values.set(key, value);
          if (ch.raw !== null && ch.raw !== undefined) {
            this.values.set(`${key}_raw`, ch.raw);
          }
        }
        this.performance = msg.performance;
        this.frameCount++;
        this.lastFrameAt = Date.now();
        this.noteRx(msg);
        if (frameHasData(msg)) {
          this.lastRxAt = this.lastFrameAt;
          this.setConnected(true);
          this.dataListener?.();
        }
      } else if (msg.type === 'status') {
        if (!msg.ok) this.onEvent(`NI-DAQ: ${msg.message}`);
        console.error(`[nidaq] ${msg.message}`);
      } else if (msg.type === 'ack') {
        // A tare that silently did nothing is the worst outcome: the operator
        // walks away believing a channel is zeroed. Say which ones refused.
        //
        // At ERROR level, and phrased to contradict rather than qualify. The
        // stand has already logged "*** TARE *** PT1" by the time this
        // arrives, because tareSensors() returns as soon as the command is
        // written and the sidecar answers milliseconds later. A `warn` reading
        // "could not be tared (pt2)" under a success line naming PT1 is two
        // messages an operator has to reconcile at exactly the wrong moment.
        if (msg.action === 'tare' && msg.skipped?.length) {
          const names = msg.skipped.map((label) => this.sensorForLabel(label));
          this.onEvent(
            `NI-DAQ: ${names.join(', ')} NOT tared — no valid reading. ` +
            `Disregard the TARE line above for ${names.length > 1 ? 'these channels' : 'this channel'}; ` +
            `${names.length > 1 ? 'they are' : 'it is'} still reading uncorrected.`,
            'error'
          );
        } else if (msg.ok === false) {
          this.onEvent(`NI-DAQ: "${msg.action}" failed${msg.error ? ` — ${msg.error}` : ''}`);
        }
      }
    }
  }

  /** Watchdog: drop the link once channel data has been absent too long. */
  checkData(now = Date.now()) {
    if (!this.connected || now - this.lastRxAt <= DATA_TIMEOUT_MS) return;
    this.setConnected(false, now - this.lastFrameAt <= DATA_TIMEOUT_MS
      ? 'acquisition running but no card is returning samples'
      : 'acquisition process stopped responding');
  }

  /**
   * The one place the link changes state, so every transition is logged
   * exactly once. The loss is an ERROR: sensor readings freeze at their last
   * value, and an operator watching a steady gauge has no other way to know
   * it stopped being true. Nothing here blocks control — valves, ARM and
   * ABORT carry on; the stand only loses its eyes on this device.
   */
  setConnected(up, reason = null) {
    if (up === this.connected) return;
    this.connected = up;
    if (up) {
      const wasLost = this.everConnected;
      this.everConnected = true;
      this.lostReason = null;
      if (wasLost) this.onEvent('NI-DAQ data restored', 'info');
      return;
    }
    this.lostReason = reason;
    if (this.closing) return;
    this.onEvent(
      `NI-DAQ DISCONNECTED — ${reason}. DAQ sensor readings are frozen at their last value.`,
      'error'
    );
  }

  /**
   * The sidecar itself failed. Logged even when the link was never up — a DAQ
   * that dies during startup is still a DAQ the operator needs to hear about.
   */
  fail(reason) {
    if (this.connected) return this.setConnected(false, reason);
    this.lostReason = reason;
    this.onEvent(`NI-DAQ DISCONNECTED — ${reason}.`, 'error');
  }

  command(obj) {
    if (!this.child?.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  /**
   * Zero a channel (or a whole card, or everything) against its current
   * reading. `clear` restores the channel to its untared calibration instead.
   *
   * Addressed by card and channel, which is how the sidecar thinks. Callers
   * that speak in sensor ids want `tareSensors` below.
   */
  tare(card, channel, { clear = false } = {}) {
    return this.command({ action: 'tare', card, channel, clear });
  }

  /**
   * Zero one or more sensors, addressed by sensor id.
   *
   * Only channels present in `channelMap` can be tared — an unmapped card
   * channel has no sensor to zero, and taring one by accident would move a
   * reading nobody is looking at. Sensors this device does not measure come
   * back in `unsupported` rather than failing the whole request, so a
   * composite stand can hand the same list to each of its devices.
   */
  tareSensors(ids, { clear = false } = {}) {
    const tared = [];
    const unsupported = [];
    for (const id of ids) {
      const target = this.channelForSensor(id);
      if (!target) { unsupported.push(id); continue; }
      if (!this.tare(target.card, target.channel, { clear })) {
        return {
          ok: false,
          error: 'NI-DAQ acquisition is not running',
          tared,
          unsupported,
        };
      }
      tared.push(id);
    }
    return { ok: true, tared, unsupported };
  }

  /** sensor id -> {card, channel}, or null when this device does not read it. */
  channelForSensor(id) {
    if (!this.sensorChannels) {
      // channelMap is fixed at construction, so this is built once. First
      // mapping wins if a sensor is listed twice.
      this.sensorChannels = new Map();
      for (const [key, sensorId] of Object.entries(this.channelMap)) {
        const m = /^([a-z]+)(\d+)$/.exec(key);
        if (!m || this.sensorChannels.has(sensorId)) continue;
        this.sensorChannels.set(sensorId, { card: m[1], channel: Number(m[2]) });
      }
    }
    return this.sensorChannels.get(id) || null;
  }

  /**
   * The inverse: a sidecar channel label like `pt2` back to `PT1`.
   *
   * The sidecar speaks in card and channel because that is how the hardware is
   * addressed, but an operator tared a sensor with a name on it. Reporting a
   * failure as "pt2" asks them to do this lookup themselves, from memory,
   * while something is wrong. An unmapped channel falls back to its raw label
   * rather than being dropped — an unexpected channel in a refusal is still
   * worth seeing.
   */
  sensorForLabel(label) {
    const m = /^([a-z]+)(\d+)$/.exec(String(label));
    if (!m) return String(label);
    const id = this.channelMap[`${m[1]}${Number(m[2])}`];
    return id ? `${id} (${label})` : String(label);
  }

  /**
   * Current tare offset per sensor, in the sensor's engineering units.
   *
   * Every mapped channel appears, zero included — the presence of an entry is
   * what tells the UI a sensor can be tared at all. Entries only exist once
   * telemetry has arrived, so a card that is down offers no tare button,
   * which is the honest answer.
   *
   * The sidecar zeroes the value BEFORE stand.json's calibration is applied,
   * so the visible shift is scaled by the slope. (The calibration's offset
   * term cancels: it applies equally to the tared and untared reading.)
   */
  tareStatus() {
    const out = {};
    for (const [key, id] of Object.entries(this.channelMap)) {
      const offset = this.tares.get(key);
      if (offset === undefined) continue;
      const sensor = this.config?.sensors.find((s) => s.id === id);
      const { slope = 1 } = sensor?.calibration || {};
      out[id] = offset * slope;
    }
    return out;
  }

  setCalMode(card, channel, useAlt) {
    return this.command({ action: 'set_cal_mode', card, channel, useAlt });
  }

  read() {
    const out = {};
    for (const [key, id] of Object.entries(this.channelMap)) {
      const value = this.values.get(key);
      if (value === undefined) continue;
      const sensor = this.config?.sensors.find((s) => s.id === id);
      const { slope = 1, offset = 0 } = sensor?.calibration || {};
      out[id] = value * slope + offset;
    }
    return out;
  }

  /** Per-channel acquisition status, for surfacing an open transducer in the UI. */
  channelStatus() {
    const out = {};
    for (const [key, id] of Object.entries(this.channelMap)) {
      const s = this.statuses.get(key);
      if (s) out[id] = s;
    }
    return out;
  }

  /**
   * Called after every frame that carried data. The control loop ticks off
   * this rather than only off its own timer: on Windows a Node timer fires on
   * a ~15.6 ms grid (a 50 Hz setInterval measured 32.7 Hz), but a pipe read
   * wakes the event loop within a fraction of a millisecond.
   */
  setDataListener(fn) {
    this.dataListener = fn;
  }

  setValve() { /* read-only device */ }

  /**
   * Record one frame's arrival for the measured update rate.
   *
   * Samples are counted PER CARD — the longest `samples` array among that
   * card's channels — because the cards run on unrelated clocks: the 9208 at
   * the configured 100 Hz, the 9237 coerced to ~1.6 kHz, the 9211 converting
   * every ~350 ms. Folding them into one number reports whichever is fastest.
   *
   * A frame that carries no samples counts as none. The sidecar emits a frame
   * every pass whether or not any card had data, and counting an empty frame
   * as a sample reported the pass rate as if channels were updating.
   *
   * A short read — fewer samples than the clock implies, which is what a
   * starved DAQ does — shows up as a lower rate, because what is counted is
   * what arrived, never the configured samplesPerRead.
   */
  noteRx(msg, t = this.lastFrameAt) {
    const n = {};
    for (const ch of msg.channels || []) {
      if (!ch.card) continue;
      const len = Array.isArray(ch.samples) ? ch.samples.length : 0;
      n[ch.card] = Math.max(n[ch.card] ?? 0, len);
    }
    // n[card] > 0 also means the card produced a NEW value this frame. That,
    // not the sample count, is what the stand sees: only the latest value of
    // each frame reaches read(), the control loop and the recording.
    this.rxWindow.push({ t, n });

    const cutoff = t - RX_WINDOW_MS;
    let drop = 0;
    while (drop < this.rxWindow.length - 1 && this.rxWindow[drop].t < cutoff) drop++;
    if (drop) this.rxWindow.splice(0, drop);
  }

  /**
   * How fast channels are ACTUALLY updating, measured at this end of the
   * pipe: `{ frameHz, updateHz, clockHz, cards, sampleCards }`, or null until
   * there is enough of a window.
   *
   * Two rates per card, because they are different things:
   *
   *   cards        new values per second that reach the stand — a frame
   *                carrying any samples for the card counts once. This is
   *                the rate the gauges, control loop and recording move at.
   *   sampleCards  hardware samples per second the sidecar acquired. A
   *                frame of ten PT samples is ten here but one above: the
   *                stand only ever sees the last of them.
   *
   * The headline `updateHz` is the SLOWEST clocked card's update rate (PT/LC):
   * the stand is only as current as its laggiest clocked input, and the fast
   * 9237 must not mask a stalled 9208. Thermocouples only headline when
   * nothing else is streaming, because the 9211's ~3 Hz is its normal pace,
   * not a fault. `clockHz` is the acquisition clock of the headline card, for
   * the tooltip's acquisition line. With no cards reporting at all the rate is
   * 0 — frames arriving empty are a live link with nothing updating, and that
   * is what should be shown.
   *
   * This is deliberately not `performance.sample_rate_hz` from the sidecar.
   * That field is the configured sample clock echoed back — it reads 100 Hz
   * whether the DAQ is streaming, stuttering, or half a second behind, so it
   * can never disagree with the config and never tells an operator anything.
   *
   * Rates are taken across the span between the first and last frame in the
   * window, counting the frames AFTER the first: the earliest entry marks
   * when the interval opened, and its own samples arrived before it.
   */
  rxRates() {
    const w = this.rxWindow;
    if (w.length < 2) return null;
    const elapsed = (w[w.length - 1].t - w[0].t) / 1000;
    if (elapsed < RX_MIN_SPAN_S) return null;

    const samples = {};
    const updates = {};
    for (let i = 0; i < w.length; i++) {
      for (const [card, n] of Object.entries(w[i].n)) {
        samples[card] = (samples[card] ?? 0) + (i === 0 ? 0 : n);
        updates[card] = (updates[card] ?? 0) + (i === 0 || n === 0 ? 0 : 1);
      }
    }
    const cards = {};
    const sampleCards = {};
    for (const [card, n] of Object.entries(updates)) cards[card] = n / elapsed;
    for (const [card, n] of Object.entries(samples)) sampleCards[card] = n / elapsed;

    const clocks = this.performance?.card_rates_hz || {};
    const clocked = Object.keys(cards).filter((c) => c !== 'tc');
    const pick = clocked.length ? clocked : Object.keys(cards);
    let head = null;
    for (const c of pick) if (head === null || cards[c] < cards[head]) head = c;

    let clockHz = null;
    if (head && head !== 'tc') {
      clockHz = Number.isFinite(clocks[head]) ? clocks[head]
        : Number.isFinite(this.performance?.sample_rate_hz) ? this.performance.sample_rate_hz
        : this.sampleClockHz;
    }

    return {
      frameHz: (w.length - 1) / elapsed,
      updateHz: head ? cards[head] : 0,
      headCard: head,
      clockHz,
      cards,
      sampleCards,
    };
  }

  get status() {
    const configured = this.performance?.sample_rate_hz;
    const rx = this.connected ? this.rxRates() : null;
    const clocks = this.performance?.card_rates_hz || {};
    return {
      name: this.name,
      connected: this.connected,
      // When the last frame actually landed. The header turns this into
      // "LIVE" or an age, so an operator can tell a link that dropped a
      // second ago from one that has been dead since before the count.
      // 0 means nothing has ever been received.
      lastRxAt: this.lastRxAt,
      // Set only while nothing has EVER arrived: when acquisition started,
      // so the header can say how long it has been waiting.
      waitingSince: this.lastRxAt ? null : (this.startedAt || null),
      // Measured here, not reported by the sidecar — see rxRates(). How often
      // a new value reaches the stand, which is what the header shows.
      rxUpdateHz: rx ? Number(rx.updateHz.toFixed(1)) : null,
      rxFrameHz: rx ? Number(rx.frameHz.toFixed(2)) : null,
      // Per-card breakdown for the tooltip: updates reaching the stand, and
      // samples acquired vs. the card's clock.
      rxCards: rx
        ? Object.entries(rx.cards).map(([card, hz]) => ({
          card,
          hz: Number(hz.toFixed(1)),
          sampleHz: Number((rx.sampleCards[card] ?? 0).toFixed(1)),
          clockHz: Number.isFinite(clocks[card]) ? clocks[card] : null,
        }))
        : null,
      // The acquisition clock of the headline card. Null when the headline is
      // the unclocked 9211 — it has no nameplate to fall short of.
      sampleClockHz: rx
        ? rx.clockHz
        : Number.isFinite(configured) ? configured : this.sampleClockHz,
      // Why the link is down, for the header's warning strip. Null while up.
      lostReason: this.connected ? null : this.lostReason,
      detail: this.connected
        ? `${this.detail} · ${this.frameCount} frames`
        : `${this.detail} · ${this.lastFrameAt ? 'NO DATA' : 'NO LINK'}`,
    };
  }

  async close() {
    this.closing = true;
    clearInterval(this.watchdog);
    this.command({ action: 'shutdown' });
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child?.kill();
        resolve();
      }, 1500);
      timer.unref?.();
      this.child?.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
