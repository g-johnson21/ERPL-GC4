/**
 * udp.js — dependency-free driver for an Ethernet-attached stand controller
 * (Teensy 4.1 + NativeEthernet, ESP32, RevPi, etc).
 *
 * Wire protocol — plain ASCII lines, one datagram per message:
 *
 *   GC -> controller
 *     SET <channel> <0|1>     energize / de-energize a discrete output
 *     SAFE                    controller-side safe state (also on link loss)
 *     PING <seq>
 *
 *   controller -> GC
 *     T <millis> <ch>:<raw> <ch>:<raw> ...     telemetry frame (raw counts)
 *     PONG <seq>
 *     ACK <channel> <0|1>                      optional command echo
 *
 * `raw` is whatever your ADC produces; the per-sensor `calibration`
 * {slope, offset} in stand.json converts it to engineering units.
 *
 * IMPORTANT: the controller must implement its own watchdog. If it stops
 * receiving packets it must drive every output to its safe state itself —
 * never rely on this laptop staying alive.
 */
import dgram from 'node:dgram';

export class UdpDriver {
  constructor(options = {}) {
    this.name = 'udp';
    this.host = options.host || '192.168.1.50';
    this.port = Number(options.port || 5000);
    this.listenPort = Number(options.listenPort || 5001);
    this.timeoutMs = Number(options.timeoutMs || 1500);
    this.detail = `${this.host}:${this.port}`;
    this.raw = new Map();      // channel -> raw count
    this.lastRxAt = 0;
    this.connected = false;
    this.rxCount = 0;
    this.socket = null;
  }

  async init(config) {
    this.config = config;
    this.byChannel = new Map(config.sensors.map((s) => [s.channel, s]));

    await new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', (err) => {
        console.error('[udp] socket error:', err.message);
        this.connected = false;
      });
      this.socket.on('message', (msg) => this.onMessage(msg.toString('utf8')));
      this.socket.bind(this.listenPort, () => resolve());
      setTimeout(() => reject(new Error('UDP bind timeout')), 3000).unref?.();
    });

    this.heartbeat = setInterval(() => {
      this.send(`PING ${Date.now() % 100000}`);
      if (Date.now() - this.lastRxAt > this.timeoutMs) this.connected = false;
    }, 500);
    this.heartbeat.unref?.();
    return this;
  }

  onMessage(text) {
    for (const line of text.split(/[\r\n]+/)) {
      const parts = line.trim().split(/\s+/);
      if (!parts[0]) continue;
      if (parts[0] === 'T') {
        for (const token of parts.slice(2)) {
          const [ch, val] = token.split(':');
          const c = Number(ch), v = Number(val);
          if (Number.isFinite(c) && Number.isFinite(v)) this.raw.set(c, v);
        }
        this.lastRxAt = Date.now();
        this.connected = true;
        this.rxCount++;
      }
    }
  }

  send(line) {
    if (!this.socket) return;
    const buf = Buffer.from(line + '\n', 'utf8');
    this.socket.send(buf, 0, buf.length, this.port, this.host, (err) => {
      if (err) console.error('[udp] send failed:', err.message);
    });
  }

  setValve(valve, state) {
    // Normally-open valves must be energized to CLOSE.
    const energize = valve.normallyOpen ? state === 'closed' : state === 'open';
    this.send(`SET ${valve.channel} ${energize ? 1 : 0}`);
  }

  safeAll() { this.send('SAFE'); }

  read() {
    const out = {};
    for (const sensor of this.config.sensors) {
      const raw = this.raw.get(sensor.channel);
      if (raw === undefined) continue;
      const { slope = 1, offset = 0 } = sensor.calibration || {};
      out[sensor.id] = raw * slope + offset;
    }
    return out;
  }

  get status() {
    return {
      name: this.name,
      connected: this.connected,
      detail: this.connected
        ? `${this.detail} · ${this.rxCount} frames`
        : `${this.detail} · NO LINK`,
    };
  }

  async close() {
    clearInterval(this.heartbeat);
    this.safeAll();
    await new Promise((r) => this.socket?.close(r) ?? r());
  }
}
