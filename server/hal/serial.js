/**
 * serial.js — USB-serial driver for a microcontroller-based stand controller.
 *
 * Uses the same ASCII line protocol as the UDP driver (see hal/udp.js).
 *
 * Serial ports need a native module, which is the one thing in this project
 * that is not a Node built-in. Install it only if you use this driver:
 *
 *     npm install serialport
 *
 * Then:  node server/index.js --driver=serial --port=COM4 --baud=921600
 */

export class SerialDriver {
  constructor(options = {}) {
    this.name = 'serial';
    this.portPath = options.port || 'COM3';
    this.baud = Number(options.baud || 921600);
    this.detail = `${this.portPath} @ ${this.baud}`;
    this.raw = new Map();
    this.lastRxAt = 0;
    this.connected = false;
    this.rxCount = 0;
    this.buffer = '';
  }

  async init(config) {
    this.config = config;

    let SerialPort;
    try {
      ({ SerialPort } = await import('serialport'));
    } catch {
      throw new Error(
        'The serial driver needs the "serialport" package.\n' +
        '  Run:  npm install serialport\n' +
        '  Or run with --driver=simulator / --driver=udp instead.'
      );
    }

    this.port = new SerialPort({ path: this.portPath, baudRate: this.baud, autoOpen: false });

    await new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });

    this.port.on('data', (chunk) => this.onData(chunk.toString('utf8')));
    this.port.on('error', (err) => {
      console.error('[serial] error:', err.message);
      this.connected = false;
    });
    this.port.on('close', () => { this.connected = false; });

    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastRxAt > 1500) this.connected = false;
    }, 500);
    this.watchdog.unref?.();
    return this;
  }

  onData(text) {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] !== 'T') continue;
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

  send(line) {
    if (this.port?.writable) this.port.write(line + '\n');
  }

  setValve(valve, state) {
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
      lastRxAt: this.lastRxAt,
      detail: this.connected ? `${this.detail} · ${this.rxCount} frames` : `${this.detail} · NO LINK`,
    };
  }

  async close() {
    clearInterval(this.watchdog);
    this.safeAll();
    await new Promise((r) => this.port?.close(() => r()) ?? r());
  }
}
