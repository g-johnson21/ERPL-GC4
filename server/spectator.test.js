/**
 * Tests for the read-only spectator port.
 *
 *   node --test server/spectator.test.js
 *
 * The property under test is the whole reason the port exists: a browser
 * pointed at it CANNOT move the stand. That is not something a hidden button
 * can be trusted to provide, so these tests skip the UI entirely and ask the
 * server directly — with the requests a curious spectator, a stale bookmark,
 * or a devtools console would actually produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSpectatorServer, spectatorConfig } from './spectator.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const CONFIG = {
  meta: { standName: 'Draco', organization: 'ERPL', configVersion: '4.0.0', notes: 'x' },
  ui: {
    brand: 'GC',
    accent: '#1239d3',
    pages: [
      { id: 'grid', label: 'Control Grid', href: '/index.html', icon: 'grid' },
      { id: 'pid', label: 'P&ID', href: '/pid.html', icon: 'schematic' },
      { id: 'data', label: 'Data', href: '/data.html', icon: 'gauge' },
      { id: 'config', label: 'Config', href: '/config.html', icon: 'sliders' },
    ],
  },
  telemetry: { sampleRateHz: 50, streamRateHz: 20 },
  safety: { requireArmToActuate: true },
  sensorGroups: [{ id: 'lox', label: 'LOX', color: '#38bdf8' }],
  sensors: [{ id: 'PT1', name: 'LOX Tank', group: 'lox', channel: 3, units: 'psi', min: 0, max: 1000 }],
  valves: [{ id: 'MV-LOX', name: 'LOX Main', safeState: 'closed' }],
  valveGroups: [{ id: 'main', label: 'Main' }],
  bangbang: [{ id: 'BB-LOX', setpoint: 450 }],
  autosequences: [{ id: 'hotfire', label: 'HOT FIRE', steps: [] }],
  pid: { nodes: [], edges: [] },
  recording: { directory: 'data', defaultTestName: 'test' },
};

/** Enough of a StandController for the read-only routes. */
const STAND = {
  config: CONFIG,
  snapshot: () => ({ t: 1, armed: false, sensors: { PT1: { v: 12.5, status: 'ok' } } }),
  historySnapshot: () => ({ PT1: { t: [1], v: [12.5] } }),
};

/** A spectator server on an ephemeral port, plus a fetch bound to it. */
async function serving() {
  const server = createSpectatorServer({
    stand: STAND,
    publicDir: PUBLIC_DIR,
    openStream: (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(); },
    mime: { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (p, init) => fetch(base + p, init),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('the config a spectator receives carries no way to command the stand', () => {
  const cfg = spectatorConfig(CONFIG);

  // Not "empty because the page ignores them" — absent from the wire. A
  // spectator's browser never learns the valve ids, the interlock policy, the
  // countdown timings or the P&ID that would let someone hand-craft a command.
  assert.deepEqual(cfg.valves, []);
  assert.deepEqual(cfg.valveGroups, []);
  assert.deepEqual(cfg.bangbang, []);
  assert.deepEqual(cfg.autosequences, []);
  assert.deepEqual(cfg.safety, {});
  assert.equal(cfg.pid, undefined);

  // What the Data page draws does survive, or the window is blank.
  assert.deepEqual(cfg.sensors, CONFIG.sensors);
  assert.deepEqual(cfg.sensorGroups, CONFIG.sensorGroups);
  assert.equal(cfg.telemetry.streamRateHz, 20);
  assert.equal(cfg.ui.brand, 'GC');
});

test('the nav offers only the page this port serves', () => {
  const cfg = spectatorConfig(CONFIG);
  // The header builds its links straight from this list, so a Control Grid
  // entry here is a link a spectator can click.
  assert.equal(cfg.ui.pages.length, 1);
  assert.equal(cfg.ui.pages[0].id, 'data');
  assert.equal(cfg.ui.pages[0].href, '/');
  assert.equal(cfg.ui.spectator, true);
});

test('a config with no data page still yields a usable one', () => {
  const cfg = spectatorConfig({ ...CONFIG, ui: { ...CONFIG.ui, pages: [{ id: 'grid', href: '/' }] } });
  assert.equal(cfg.ui.pages.length, 1);
  assert.equal(cfg.ui.pages[0].id, 'data');
});

test('every mutating method is refused, whatever it is addressed to', async (t) => {
  const s = await serving();
  t.after(() => s.close());

  const attempts = [
    ['POST', '/api/valve'],
    ['POST', '/api/arm'],
    ['POST', '/api/abort'],
    ['POST', '/api/safe-all'],
    ['POST', '/api/tare'],
    ['POST', '/api/sequence/start'],
    ['POST', '/api/record/start'],
    ['PUT', '/api/config'],
    ['DELETE', '/api/config'],
    // Refused by method, before the path is even looked at — so a route that
    // does not exist here fails identically to one that does on the control
    // port. There is nothing to probe for.
    ['POST', '/api/state'],
  ];

  for (const [method, route] of attempts) {
    const res = await s.get(route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'MV-LOX', state: 'open', armed: true }),
    });
    assert.equal(res.status, 403, `${method} ${route} should be refused`);
    assert.equal((await res.json()).ok, false);
  }
});

test('the read-only routes serve live stand data', async (t) => {
  const s = await serving();
  t.after(() => s.close());

  const state = await (await s.get('/api/state')).json();
  assert.equal(state.sensors.PT1.v, 12.5);

  const history = await (await s.get('/api/history')).json();
  assert.deepEqual(history.PT1.v, [12.5]);

  const cfg = await (await s.get('/api/config')).json();
  assert.equal(cfg.ui.spectator, true);
  assert.deepEqual(cfg.valves, []);

  // Operator-facing, so it is shipped empty rather than 404ing — the client
  // treats an empty log as normal and a missing one as a fault to retry.
  assert.deepEqual(await (await s.get('/api/events')).json(), []);
});

test('recorded test files are not reachable', async (t) => {
  const s = await serving();
  t.after(() => s.close());

  for (const route of ['/api/record/list', '/api/record/download/Draco_20260904_112328_hotfire.csv']) {
    assert.equal((await s.get(route)).status, 404, route);
  }
});

test('every page a spectator can reach is the Data page', async (t) => {
  const s = await serving();
  t.after(() => s.close());

  // Including the control pages by name: a stale bookmark or a typed URL
  // lands on the view they are allowed to have, not on a 404 that reads like
  // the server is broken.
  for (const route of ['/', '/index.html', '/pid.html', '/config.html', '/data.html']) {
    const res = await s.get(route);
    assert.equal(res.status, 200, route);
    const html = await res.text();
    assert.match(html, /page-data\.js/, `${route} should serve the Data page`);
    assert.doesNotMatch(html, /page-grid\.js|page-pid\.js|page-config\.js/, route);
  }
});

test('static serving stays inside the asset directories', async (t) => {
  const s = await serving();
  t.after(() => s.close());

  assert.equal((await s.get('/css/base.css')).status, 200);
  assert.equal((await s.get('/js/page-data.js')).status, 200);

  // The stand config on disk holds the wiring and the interlocks. It sits
  // outside public/, and the traversal that would reach it must not.
  for (const route of ['/../config/stand.json', '/%2e%2e/config/stand.json', '/../package.json']) {
    const status = (await s.get(route)).status;
    assert.ok(status === 403 || status === 404, `${route} returned ${status}`);
  }
});
