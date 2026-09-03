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

export class NiDaqDriver {
  constructor(options = {}) {
    this.name = 'nidaq';
    this.python = options.python || process.env.GC_PYTHON || 'python';
    this.chassis = options.chassis || 'cDAQ9189-2462EFD';
    this.sampleClockHz = Number(options.sampleClockHz || 100);
    this.samplesPerRead = Number(options.samplesPerRead || 10);
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
    this.lastRxAt = 0;
    this.connected = false;
    this.frameCount = 0;
    // Arrival times of recent frames, for the MEASURED receive rate. See
    // rxRates(). Bounded by age, not by count, so it self-limits at any rate.
    this.rxWindow = [];              // [{ t, n }] — n = samples in that frame
    this.stdoutBuffer = '';
    this.child = null;
    this.onEvent = options.onEvent || (() => {});
  }

  async init(config) {
    this.config = config;

    const payload = {
      chassis: this.chassis,
      sampleClockHz: this.sampleClockHz,
      samplesPerRead: this.samplesPerRead,
      cards: this.cards,
    };

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
      this.connected = false;
      if (this.closing) return;
      console.error(`[nidaq] streamer exited (code=${code} signal=${signal})`);
      // 143/SIGTERM means the whole process group is going down (Ctrl+C, a
      // service stop). That is a shutdown, not an acquisition fault, and
      // raising it as an error alarms the operator on a normal exit.
      const terminated = signal === 'SIGTERM' || signal === 'SIGINT' || code === 143 || code === 130;
      if (!terminated) {
        this.onEvent(`NI-DAQ acquisition stopped (code ${code})`);
      }
    });
    this.child.on('error', (err) => {
      this.connected = false;
      console.error(`[nidaq] failed to spawn "${this.python}": ${err.message}`);
    });

    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastRxAt > 2000) this.connected = false;
    }, 500);
    this.watchdog.unref?.();

    // Wait for the first real frame rather than a fixed delay, so the startup
    // banner and the first control ticks report a truthful link state. Card
    // configuration takes a second or two; give up after `startupTimeoutMs`
    // and let the watchdog report NO LINK rather than blocking the boot.
    await this.waitForFirstFrame(this.startupTimeoutMs);
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
        this.lastRxAt = Date.now();
        this.connected = true;
        this.noteRx(msg);
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

  setValve() { /* read-only device */ }

  /**
   * Record one frame's arrival for the measured receive rate.
   *
   * The sample count is taken from the LONGEST `samples` array in the frame
   * rather than from the configured samplesPerRead. A short read — the card
   * returned fewer samples than asked for, which is what a starved DAQ
   * actually does — has to show up as a lower rate. Reading the configured
   * number back out would report the nameplate no matter what arrived, which
   * is the exact failure this measurement exists to catch.
   */
  noteRx(msg) {
    let n = 0;
    for (const ch of msg.channels || []) {
      const len = Array.isArray(ch.samples) ? ch.samples.length : 1;
      if (len > n) n = len;
    }
    this.rxWindow.push({ t: this.lastRxAt, n: n || 1 });

    const cutoff = this.lastRxAt - RX_WINDOW_MS;
    let drop = 0;
    while (drop < this.rxWindow.length - 1 && this.rxWindow[drop].t < cutoff) drop++;
    if (drop) this.rxWindow.splice(0, drop);
  }

  /**
   * What the host is ACTUALLY receiving, measured at this end of the pipe:
   * `{ frameHz, sampleHz }`, or null until there is enough of a window.
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

    let samples = 0;
    for (let i = 1; i < w.length; i++) samples += w[i].n;
    return {
      frameHz: (w.length - 1) / elapsed,
      sampleHz: samples / elapsed,
    };
  }

  get status() {
    const configured = this.performance?.sample_rate_hz;
    const rx = this.connected ? this.rxRates() : null;
    return {
      name: this.name,
      connected: this.connected,
      // When the last frame actually landed. The header turns this into
      // "LIVE" or an age, so an operator can tell a link that dropped a
      // second ago from one that has been dead since before the count.
      // 0 means nothing has ever been received.
      lastRxAt: this.lastRxAt,
      // Measured here, not reported by the sidecar — see rxRates().
      rxSampleHz: rx ? Number(rx.sampleHz.toFixed(1)) : null,
      rxFrameHz: rx ? Number(rx.frameHz.toFixed(2)) : null,
      // The sample clock the cards were CONFIGURED for, so the header can say
      // what the measured rate is falling short of.
      sampleClockHz: Number.isFinite(configured) ? configured : this.sampleClockHz,
      detail: this.connected
        ? `${this.detail} · ${this.frameCount} frames`
        : `${this.detail} · NO LINK`,
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
