/**
 * recorder.js — CSV data recording.
 *
 * One row per sample at `recording.rateHz`. Columns:
 *   iso_time, epoch_ms, elapsed_s
 *   one column per sensor, header "ID (units)"
 *   one column per valve  (1 = open, 0 = closed)      [includeValveStates]
 *   setpoint / enabled columns per controller          [includeSetpoints]
 *   armed, sequence, event
 *
 * The `event` column carries any log lines emitted since the previous row,
 * so a single file contains the full test story.
 *
 * Alongside each CSV a `.meta.json` sidecar stores the exact config used for
 * the run — calibrations, setpoints, sequences — so a trace can always be
 * reinterpreted months later.
 */
import fs from 'node:fs';
import path from 'node:path';

export class Recorder {
  constructor(controller, baseDir) {
    this.stand = controller;
    this.baseDir = baseDir;
    this.active = false;
    this.stream = null;
    this.rows = 0;
    this.bytes = 0;
    this.startedAt = 0;
    this.file = null;
    this.pending = [];
    this.pendingEvents = [];
    this.lastSampleAt = 0;
    this.autoStopAt = 0;
  }

  get cfg() { return this.stand.config.recording; }

  start(testName, source = 'operator') {
    if (this.active) return { ok: false, error: 'Recording already in progress' };

    const cfg = this.cfg;
    const dir = path.resolve(this.baseDir, cfg.directory);
    fs.mkdirSync(dir, { recursive: true });

    const now = new Date();
    const name = sanitize(testName || cfg.defaultTestName);
    const filename = cfg.filenamePattern
      .replace('{stand}', sanitize(this.stand.config.meta.standName || 'stand'))
      .replace('{date}', localDate(now))
      .replace('{time}', localTime(now))
      .replace('{name}', name)
      .replace('{driver}', this.stand.driver.name);

    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      return { ok: false, error: `${filename} already exists — pick a different test name` };
    }

    this.columns = this.buildColumns();
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.stream.on('error', (err) => {
      this.stand.log('error', `Recording write failed: ${err.message}`, 'recorder');
      this.stop('write error');
    });

    const header = this.columns.map((c) => c.header).join(',') + '\n';
    this.stream.write(header);
    this.bytes = header.length;

    this.active = true;
    this.rows = 0;
    this.startedAt = Date.now();
    this.lastSampleAt = 0;
    this.autoStopAt = 0;
    this.file = filename;
    this.filePath = filePath;
    this.pending = [];
    this.pendingEvents = [];

    // Sidecar: exactly what the stand was configured as for this run.
    try {
      fs.writeFileSync(
        filePath.replace(/\.csv$/i, '') + '.meta.json',
        JSON.stringify({
          startedAt: now.toISOString(),
          testName: name,
          driver: this.stand.driver.status,
          config: this.stand.config,
        }, null, 2)
      );
    } catch (err) {
      this.stand.log('warn', `Could not write metadata sidecar: ${err.message}`, 'recorder');
    }

    this.flushTimer = setInterval(() => this.flush(), cfg.flushIntervalMs);
    this.stand.log('record', `RECORDING START -> ${filename}`, source);
    return { ok: true, file: filename };
  }

  buildColumns() {
    const cfg = this.cfg;
    const cols = [
      { header: 'iso_time', get: (s) => s.iso },
      { header: 'epoch_ms', get: (s) => s.now },
      { header: 'elapsed_s', get: (s) => ((s.now - this.startedAt) / 1000).toFixed(4) },
    ];

    for (const sensor of this.stand.config.sensors) {
      cols.push({
        header: csvEscape(`${sensor.id} (${sensor.units})`),
        get: (s) => {
          const v = s.readings[sensor.id];
          return Number.isFinite(v) ? v.toFixed(Math.max(sensor.decimals, 3)) : '';
        },
      });
    }

    if (cfg.includeValveStates) {
      for (const valve of this.stand.config.valves) {
        cols.push({
          header: csvEscape(`${valve.id} (state)`),
          get: (s) => (s.valves[valve.id] === 'open' ? '1' : '0'),
        });
      }
    }

    if (cfg.includeSetpoints) {
      for (const c of this.stand.config.bangbang) {
        cols.push({ header: csvEscape(`${c.id} setpoint`), get: (s) => s.controllers[c.id]?.setpoint ?? '' });
        cols.push({ header: csvEscape(`${c.id} enabled`), get: (s) => (s.controllers[c.id]?.enabled ? '1' : '0') });
        // What the BOARD reported, alongside what we asked it for. A trace
        // read back months later has to be able to answer "was the loop
        // actually running, and on what pressure" — and the answer to both is
        // the board's, not ours. `enabled` above is only our request.
        cols.push({ header: csvEscape(`${c.id} board state`), get: (s) => s.controllers[c.id]?.board?.state ?? '' });
        cols.push({ header: csvEscape(`${c.id} board press`), get: (s) => (s.controllers[c.id]?.board?.press ? '1' : '0') });
        cols.push({ header: csvEscape(`${c.id} board vent`), get: (s) => (s.controllers[c.id]?.board?.vent ? '1' : '0') });
        cols.push({
          header: csvEscape(`${c.id} board psi`),
          get: (s) => {
            const p = s.controllers[c.id]?.board?.pressure;
            return Number.isFinite(p) ? p.toFixed(2) : '';
          },
        });
      }
    }

    cols.push({ header: 'armed', get: (s) => (s.armed ? '1' : '0') });
    cols.push({ header: 'sequence', get: (s) => csvEscape(s.sequence || '') });
    cols.push({ header: 'event', get: (s) => csvEscape(s.event || '') });
    return cols;
  }

  /** Called every control tick; decimates to recording.rateHz. */
  sample(now, readings) {
    if (!this.active) return;

    if (this.autoStopAt && now >= this.autoStopAt) {
      this.stop('auto-stop after sequence');
      return;
    }

    const period = 1000 / Math.max(1, this.cfg.rateHz);
    if (now - this.lastSampleAt < period - 0.5) return;
    this.lastSampleAt = now;

    const snap = {
      now,
      iso: new Date(now).toISOString(),
      readings,
      valves: this.stand.valveStates,
      controllers: this.stand.bangbang.snapshot(),
      armed: this.stand.armed,
      sequence: this.stand.sequencer.active?.cfg.id || '',
      event: this.pendingEvents.join(' | '),
    };
    this.pendingEvents = [];

    this.pending.push(this.columns.map((c) => c.get(snap)).join(','));
    this.rows++;
    if (this.pending.length >= 500) this.flush();
  }

  noteEvent(text) {
    if (this.active) this.pendingEvents.push(text);
  }

  flush() {
    if (!this.stream || !this.pending.length) return;
    const chunk = this.pending.join('\n') + '\n';
    this.pending = [];
    this.bytes += chunk.length;
    this.stream.write(chunk);
  }

  scheduleAutoStop(seconds) {
    if (this.active && seconds > 0) this.autoStopAt = Date.now() + seconds * 1000;
  }

  stop(reason = 'stopped by operator', source = 'operator') {
    if (!this.active) return { ok: false, error: 'Not recording' };
    this.flush();
    clearInterval(this.flushTimer);
    const file = this.file;
    const rows = this.rows;
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.stream.end();
    this.active = false;
    this.stream = null;
    this.autoStopAt = 0;
    this.stand.log('record', `RECORDING STOP -> ${file} (${rows} rows, ${secs}s) — ${reason}`, source);
    return { ok: true, file, rows };
  }

  list() {
    const dir = path.resolve(this.baseDir, this.cfg.directory);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, modified: st.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
  }

  resolveFile(name) {
    const dir = path.resolve(this.baseDir, this.cfg.directory);
    const target = path.resolve(dir, name);
    // Never serve anything outside the recordings directory.
    if (!target.startsWith(dir + path.sep) || path.basename(name) !== name) return null;
    return fs.existsSync(target) ? target : null;
  }

  snapshot() {
    return {
      active: this.active,
      file: this.file,
      rows: this.rows,
      bytes: this.bytes,
      elapsed: this.active ? (Date.now() - this.startedAt) / 1000 : 0,
      rateHz: this.cfg.rateHz,
    };
  }
}

function sanitize(s) {
  return String(s).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'test';
}
function pad(n) { return String(n).padStart(2, '0'); }
function localDate(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }
function localTime(d) { return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
