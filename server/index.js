#!/usr/bin/env node
/**
 * ERPL Ground Control 4 — local webserver ground control software.
 *
 *   node server/index.js                      simulator (default), port 8080
 *   node server/index.js --driver=udp --host=192.168.1.50
 *   node server/index.js --driver=serial --port-name=COM4 --baud=921600
 *   node server/index.js --port=8080 --bind=0.0.0.0 --config=config/stand.json
 *
 * Zero npm dependencies — Node built-ins only, so it runs at the pad on a
 * laptop with no internet. Telemetry is pushed to browsers over Server-Sent
 * Events; commands go back over plain POST.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { ConfigStore, validateConfig } from './config-store.js';
import { TapHub } from './tools/tap-hub.js';
import { createDriver, driverNames } from './hal/index.js';
import { StandController } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? process.env.GC_PORT ?? 8080);
const BIND = args.bind ?? process.env.GC_BIND ?? '0.0.0.0';
const CONFIG_PATH = path.resolve(ROOT, args.config ?? 'config/stand.json');
const DRIVER_NAME = args.driver ?? process.env.GC_DRIVER ?? 'simulator';

/**
 * Config sections a save may touch while the stand is ARMED.
 *
 * `$schema` is editor metadata with no runtime meaning, so it rides along.
 * Everything else — valves, sensors, calibrations, safety policy, the P&ID —
 * is locked until the stand is disarmed.
 */
const ARMED_EDITABLE = new Set(['autosequences', '$schema']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// ------------------------------------------------------------------ boot ----

let configStore;
try {
  configStore = new ConfigStore(CONFIG_PATH);
} catch (err) {
  console.error(`\n  CONFIG ERROR\n  ${err.message}\n`);
  process.exit(1);
}

let standRef = null;
function emitDriverEvent(message, level = 'error') {
  if (standRef) standRef.log(level, message, 'driver');
  else console.error(`[driver] ${message}`);
}

/**
 * --panda-tap opens a second terminal printing the raw PANDA serial traffic.
 *
 * Started BEFORE the driver, so the window is already attached when the board
 * sends its boot banner — the first few lines after a reset are usually the
 * ones worth seeing, and a tap that attaches late misses exactly those.
 */
let tapHub = null;
if (args['panda-tap']) {
  // Only two drivers own a serial link to the board. On any other the flag
  // would open a window that stays empty forever, which reads as "the board
  // is silent" rather than "you asked the wrong driver for this".
  if (DRIVER_NAME !== 'stand' && DRIVER_NAME !== 'panda') {
    console.error(
      `
  --panda-tap needs a driver with a PANDA serial link.
` +
      `  Got --driver=${DRIVER_NAME}; use --driver=stand (or --driver=panda).
`
    );
    process.exit(1);
  }
  tapHub = new TapHub();
  const tapPort = await tapHub.start();
  tapHub.openViewer();
  console.error(`[tap] raw PANDA serial on 127.0.0.1:${tapPort}`);
}

let driver;
try {
  driver = createDriver(DRIVER_NAME, {
    host: args.host,
    port: args['driver-port'],
    listenPort: args['listen-port'],
    port_: undefined,
    // serial
    ...(DRIVER_NAME === 'serial' ? { port: args['port-name'] ?? args.com, baud: args.baud } : {}),
    // stand (nidaq + panda)
    root: ROOT,
    hardwareConfig: args['hardware-config'],
    pandaPort: args['port-name'] ?? args.com,
    // Driver-level faults reach the operator through the same event log as
    // everything else, rather than only the server console. A device can fault
    // while StandController is still being constructed, so this resolves the
    // controller lazily instead of closing over a binding that may not exist.
    onEvent: (message, level) => emitDriverEvent(message, level),
    onRaw: tapHub ? (direction, bytes) => tapHub.write(direction, bytes) : undefined,
  });
} catch (err) {
  console.error(`\n  DRIVER ERROR\n  ${err.message}\n  Available drivers: ${driverNames().join(', ')}\n`);
  process.exit(1);
}

const stand = new StandController(configStore, driver, ROOT);
standRef = stand;

try {
  await stand.start();
} catch (err) {
  console.error(`\n  DRIVER STARTUP FAILED\n  ${err.message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------- SSE clients ----

const clients = new Set();

stand.on('telemetry', (snap) => broadcast('state', snap));
stand.on('event', (entry) => broadcast('log', entry));
stand.on('config-reload', (cfg) => broadcast('config', { configVersion: cfg.meta.configVersion }));

function broadcast(event, data) {
  if (!clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (!res.write(payload)) {
      // Backpressure: a stalled browser must never stall the control loop.
      res.stalled = (res.stalled || 0) + 1;
      if (res.stalled > 200) { try { res.end(); } catch {} clients.delete(res); }
    } else {
      res.stalled = 0;
    }
  }
}

setInterval(() => {
  for (const res of clients) { try { res.write(': ping\n\n'); } catch {} }
}, 15000).unref();

// ----------------------------------------------------------------- server ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url);
    } else {
      serveStatic(res, pathname);
    }
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, BIND, () => {
  const banner = [
    '',
    `  ${configStore.get().ui.brand}  —  ${configStore.get().meta.standName}`,
    `  ${'-'.repeat(58)}`,
    `  Local      http://localhost:${PORT}`,
    ...localAddresses().map((ip) => `  Network    http://${ip}:${PORT}`),
    `  Driver     ${driver.status.name}  (${driver.status.detail})`,
    `  Config     ${path.relative(ROOT, CONFIG_PATH)}`,
    `  Recording  ${path.join(configStore.get().recording.directory)}/`,
    '',
    '  Ctrl+C to shut down (all actuators are driven safe on exit).',
    '',
  ].join('\n');
  console.log(banner);
});

// -------------------------------------------------------------------- API ----

async function handleApi(req, res, pathname, url) {
  const method = req.method.toUpperCase();
  const route = `${method} ${pathname}`;

  // --- streaming ---
  if (route === 'GET /api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(stand.snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // --- read-only ---
  if (route === 'GET /api/config') return sendJson(res, 200, stand.config);
  if (route === 'GET /api/state') return sendJson(res, 200, stand.snapshot());
  if (route === 'GET /api/history') return sendJson(res, 200, stand.historySnapshot());
  if (route === 'GET /api/events') {
    const since = Number(url.searchParams.get('since') || 0);
    return sendJson(res, 200, stand.events.filter((e) => e.seq > since));
  }
  if (route === 'GET /api/record/list') return sendJson(res, 200, stand.recorder.list());

  if (method === 'GET' && pathname.startsWith('/api/record/download/')) {
    const name = pathname.slice('/api/record/download/'.length);
    const file = stand.recorder.resolveFile(name);
    if (!file) return sendJson(res, 404, { ok: false, error: 'File not found' });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
    });
    return fs.createReadStream(file).pipe(res);
  }

  // --- mutating ---
  if (method !== 'POST' && method !== 'PUT') {
    return sendJson(res, 404, { ok: false, error: `No route for ${route}` });
  }

  const body = await readJsonBody(req);
  const who = body.operator || 'operator';

  switch (route) {
    case 'POST /api/arm':
      return sendJson(res, 200, withState(stand.setArmed(body.armed, who)));

    case 'POST /api/abort':
      return sendJson(res, 200, withState(stand.abort(body.reason || 'Operator abort')));

    case 'POST /api/abort/clear':
      return sendJson(res, 200, withState(stand.clearAbort(who)));

    case 'POST /api/valve': {
      const result = body.toggle
        ? stand.toggleValve(body.id, { source: who })
        : stand.commandValve(body.id, body.state, { source: who });
      return sendJson(res, result.ok ? 200 : 409, withState(result));
    }

    case 'POST /api/safe-all':
      stand.safeAll(who);
      return sendJson(res, 200, withState({ ok: true }));

    // Zero instrumentation against its current reading:
    //   { sensors: ['PT1','PT4'] } | { kind: 'pressure' }  [, clear: true ]
    case 'POST /api/tare': {
      const result = stand.tare(body, who);
      return sendJson(res, result.ok ? 200 : 409, withState(result));
    }

    // Zero the DIFFERENCE behind a P&ID tank level, leaving both of the
    // transducers behind it reporting exactly what they did before:
    //   { tanks: ['TK-LOX'] } | {}  [, clear: true ]
    case 'POST /api/tank-level/tare': {
      const result = stand.tareTankLevels(body, who);
      return sendJson(res, result.ok ? 200 : 409, withState(result));
    }

    case 'POST /api/controller': {
      const result = stand.bangbang.set(body.id, body, who);
      return sendJson(res, result.ok ? 200 : 409, withState(result));
    }

    case 'POST /api/sequence/start': {
      const result = stand.sequencer.start(body.id, who);
      return sendJson(res, result.ok ? 200 : 409, withState(result));
    }

    case 'POST /api/sequence/stop': {
      const result = stand.sequencer.stop(body.reason || 'Stopped by operator', who);
      return sendJson(res, result.ok ? 200 : 409, withState(result));
    }

    case 'POST /api/record/start': {
      const result = stand.recorder.start(body.name, who);
      return sendJson(res, result.ok ? 200 : 409, withState(result));
    }

    case 'POST /api/record/stop': {
      const result = stand.recorder.stop(body.reason || 'stopped by operator', who);
      return sendJson(res, result.ok ? 200 : 409, withState(result));
    }

    case 'POST /api/config/validate': {
      const errors = validateConfig(body.config ?? body);
      return sendJson(res, 200, { ok: errors.length === 0, errors });
    }

    case 'PUT /api/config': {
      const next = body.config ?? body;
      if (stand.sequencer.running) {
        return sendJson(res, 409, { ok: false, errors: ['Cannot change config while a sequence is running'] });
      }
      // Retiming a countdown between attempts is normal test-day work, and
      // making an operator disarm to do it costs more than it buys. Wiring is
      // a different matter: channels, calibrations, interlocks and the P&ID
      // describe the hardware, and swapping those under a live stand would
      // move the meaning of every command already on screen.
      if (stand.armed) {
        const changed = configStore.changedSections(next).filter((k) => !ARMED_EDITABLE.has(k));
        if (changed.length) {
          return sendJson(res, 409, {
            ok: false,
            errors: [
              `DISARM the stand to change ${changed.join(', ')} — ` +
              `only autosequences can be edited while armed`,
            ],
          });
        }
      }
      const result = configStore.save(next);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    case 'POST /api/config/reload': {
      try {
        configStore.reload();
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { ok: false, errors: [err.message] });
      }
    }

    default:
      return sendJson(res, 404, { ok: false, error: `No route for ${route}` });
  }
}

/** Attach a fresh snapshot so the UI updates instantly, without waiting a frame. */
function withState(result) {
  return { ...result, state: stand.snapshot() };
}

// ----------------------------------------------------------------- static ----

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!target.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return sendText(res, 404, `Not found: ${pathname}`);
  }
  if (stat.isDirectory()) return sendText(res, 404, `Not found: ${pathname}`);

  const ext = path.extname(target).toLowerCase();
  // Markup, styles and scripts must never be stale — an operator can't be
  // looking at an old control page. Images are content-addressed by name and
  // safe to hold briefly.
  const isAsset = ['.png', '.svg', '.ico', '.woff2', '.jpg', '.jpeg'].includes(ext);

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isAsset ? 'public, max-age=300' : 'no-store, must-revalidate',
  });
  fs.createReadStream(target).pipe(res);
}

// ------------------------------------------------------------------ utils ----

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readJsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) { reject(new Error(`Invalid JSON body: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function localAddresses() {
  const list = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) list.push(i.address);
    }
  }
  return list;
}

// --------------------------------------------------------------- shutdown ----

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} received — safing actuators and shutting down...`);
  for (const res of clients) { try { res.end(); } catch {} }
  server.close();
  try { await stand.shutdown(); } catch (err) { console.error('  shutdown error:', err.message); }
  console.log('  Stopped.\n');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('\n  UNCAUGHT EXCEPTION — safing stand\n', err);
  shutdown('uncaughtException');
});
