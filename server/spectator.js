/**
 * spectator.js — the read-only viewing port.
 *
 * A test draws a crowd: the rest of the team, a faculty advisor, whoever is
 * standing behind the operator asking what the chamber is doing. Handing them
 * the control URL works exactly until someone leans on a laptop trackpad.
 *
 * So spectators get their own listener on their own port. It is not the
 * control server with the buttons hidden — a hidden button is a suggestion,
 * and anyone who opens devtools or types a URL is past it. This is a separate
 * HTTP server that has no mutating routes at all:
 *
 *   - every method except GET/HEAD is refused before routing;
 *   - the only API routes that exist are the read-only snapshots plus the
 *     telemetry stream — /api/valve, /api/arm and PUT /api/config are not
 *     merely unreachable, they are absent;
 *   - Data and a read-only P&ID are the only pages served;
 *   - config includes drawing metadata, but omits wiring, interlocks and
 *     autosequences.
 *
 * The client is told it is a spectator (`ui.spectator`) so it can drop the
 * tare buttons and the recording control rather than render controls whose
 * only outcome is a rejection. That is politeness, not the safety property.
 * The safety property is that this server cannot carry out a command however
 * it is asked.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/** Directories under public/ a spectator may load assets from. */
const ASSET_DIRS = new Set(['css', 'js', 'img']);

/**
 * What a spectator's browser is told about the stand.
 *
 * Data and P&ID display metadata only. Valve wiring and command policy stay
 * on the control port; ids and geometry let the drawing follow live telemetry.
 * Empty command arrays keep shared client lookups safe.
 */
export function spectatorConfig(config) {
  const dataPage = config.ui?.pages?.find((p) => p.id === 'data')
    || { id: 'data', label: 'Data', href: '/', icon: 'gauge' };

  const pidPage = config.ui?.pages?.find((p) => p.id === 'pid')
    || { id: 'pid', label: 'P&ID', icon: 'schematic' };

  return {
    meta: {
      standName: config.meta?.standName,
      organization: config.meta?.organization,
      subtitle: config.meta?.subtitle,
      standLogo: config.meta?.standLogo,
      configVersion: config.meta?.configVersion,
    },
    ui: {
      brand: config.ui?.brand,
      logo: config.ui?.logo,
      accent: config.ui?.accent,
      defaultTheme: config.ui?.defaultTheme,
      sparklineSeconds: config.ui?.sparklineSeconds,
      pages: [{ ...dataPage, href: '/' }, { ...pidPage, href: '/pid.html' }],
      tankLevel: config.ui?.tankLevel,
      spectator: true,
    },
    telemetry: {
      sampleRateHz: config.telemetry?.sampleRateHz,
      streamRateHz: config.telemetry?.streamRateHz,
    },
    sensorGroups: config.sensorGroups || [],
    sensors: config.sensors || [],
    pid: config.pid,
    valves: (config.valves || []).map(({ id, name, type, group, pid, openLabel, closedLabel, normallyOpen, momentary }) =>
      ({ id, name, type, group, pid, openLabel, closedLabel, normallyOpen, momentary })),
    valveGroups: (config.valveGroups || []).map(({ id, label, color }) => ({ id, label, color })),
    bangbang: [],
    autosequences: [],
    safety: {},
    recording: {},
  };
}

/**
 * A read-only HTTP server over the same live stand.
 *
 * `openStream` is the control server's SSE handler, reused verbatim: spectators
 * join the same broadcast set and see identical telemetry at an identical
 * rate. A viewing screen that lags the operator's is worse than no viewing
 * screen — the crowd calls out a number the operator stopped seeing seconds
 * ago.
 */
export function createSpectatorServer({ stand, publicDir, openStream, mime = {} }) {
  const dataPage = path.join(publicDir, 'data.html');

  return http.createServer((req, res) => {
    const method = req.method.toUpperCase();

    // Refused before anything is parsed. There is no route table to reach; a
    // POST here fails the same way whatever it is addressed to.
    if (method !== 'GET' && method !== 'HEAD') {
      return json(res, 403, { ok: false, error: 'This is the spectator view — it is read-only.' });
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (pathname.startsWith('/api/')) serveApi(req, res, pathname, { stand, openStream });
      else serveStatic(res, pathname, { publicDir, dataPage, mime });
    } catch (err) {
      console.error('[spectator]', err);
      if (!res.headersSent) json(res, 500, { ok: false, error: err.message });
    }
  });
}

function serveApi(req, res, pathname, { stand, openStream }) {
  switch (pathname) {
    case '/api/stream':
      return openStream(req, res);
    case '/api/config':
      return json(res, 200, spectatorConfig(stand.config));
    // The control port asks for a PIN; this one never does, and it says so
    // rather than 404ing, so the shared client boot does not log an error
    // on every spectator's phone for asking.
    case '/api/auth':
      return json(res, 200, { required: false, authenticated: true });
    case '/api/state':
      return json(res, 200, stand.snapshot());
    case '/api/history':
      return json(res, 200, stand.historySnapshot());
    // The event log is operator-facing: who armed, which interlock refused
    // what, why a sequence stopped. Nothing on the Data page renders it, and
    // the client already treats an empty list as normal, so it is not shipped.
    case '/api/events':
      return json(res, 200, []);
    default:
      // Recordings included: /api/record/list and the CSV downloads are the
      // team's test data, not part of watching the stand run.
      return json(res, 404, { ok: false, error: 'Not available on the spectator view' });
  }
}

/**
 * Data and P&ID are the only HTML pages. Other bookmarks fall back to Data.
 */
function serveStatic(res, pathname, { publicDir, dataPage, mime }) {
  if (pathname === '/pid.html') return sendFile(res, path.join(publicDir, 'pid.html'), mime);
  if (pathname === '/' || pathname.endsWith('.html')) return sendFile(res, dataPage, mime);

  const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const target = path.join(publicDir, rel);
  if (!target.startsWith(publicDir)) return text(res, 403, 'Forbidden');

  const top = rel.split(/[/\\]/).filter(Boolean)[0];
  if (!ASSET_DIRS.has(top) && top !== 'favicon.ico') {
    return text(res, 404, `Not found: ${pathname}`);
  }
  return sendFile(res, target, mime);
}

function sendFile(res, file, mime) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return text(res, 404, 'Not found');
  }
  if (stat.isDirectory()) return text(res, 404, 'Not found');

  const ext = path.extname(file).toLowerCase();
  const isAsset = ['.png', '.svg', '.ico', '.woff2', '.jpg', '.jpeg'].includes(ext);
  res.writeHead(200, {
    'Content-Type': mime[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isAsset ? 'public, max-age=300' : 'no-store, must-revalidate',
  });
  fs.createReadStream(file).pipe(res);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}
