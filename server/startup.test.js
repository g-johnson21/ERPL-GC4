import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

// Observe the real OS listener addresses without replacing the startup logic.
const observer = `
  import http from 'node:http';
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    this.once('listening', () => process.send(this.address()));
    return listen.apply(this, args);
  };
`;

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(t, flags = [], overrides = {}, spectator = true) {
  const spectatorPort = await unusedPort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GC_')) delete env[key];
  }
  const child = fork(new URL('./index.js', import.meta.url), [
    '--driver=simulator', '--port=0', `--spectator-port=${spectatorPort}`,
    ...flags,
  ], {
    env: { ...env, ...overrides },
    silent: true,
    execArgv: ['--import', `data:text/javascript,${encodeURIComponent(observer)}`],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  let output = '';
  const addresses = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out:\n${output}`)), 10000);
    const ready = () => {
      if (addresses.length === (spectator ? 2 : 1) && output.includes('Ctrl+C to shut down')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', (chunk) => { output += chunk; ready(); });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('message', (address) => { addresses.push(address); ready(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}):\n${output}`));
    });
  });
  return {
    control: addresses.find((a) => a.port !== spectatorPort),
    spectator: addresses.find((a) => a.port === spectatorPort),
    output,
  };
}

test('startup keeps control local and spectators network-facing by default', async (t) => {
  const app = await start(t);
  assert.equal(app.control.address, '127.0.0.1');
  assert.equal(app.spectator.address, '0.0.0.0');
  assert.match(app.output, /Control    local-only/);
  assert.doesNotMatch(app.output, /Network    http/);
  const control = await fetch(`http://127.0.0.1:${app.control.port}/`, { redirect: 'manual' });
  assert.ok([200, 302].includes(control.status), 'local control page is reachable (possibly through login)');
  const view = `http://127.0.0.1:${app.spectator.port}`;
  assert.equal((await fetch(`${view}/api/state`)).status, 200);
  assert.equal((await fetch(`${view}/api/arm`, { method: 'POST' })).status, 403);
});

test('bind overrides cannot enable remote control without the flag', async (t) => {
  for (const [flags, env] of [
    [['--bind=0.0.0.0'], {}],
    [[], { GC_BIND: '0.0.0.0' }],
    [['--allow-remote-control=false'], {}],
  ]) {
    await t.test(JSON.stringify({ flags, env }), async (t) => {
      const app = await start(t, flags, env);
      assert.equal(app.control.address, '127.0.0.1');
      assert.equal(app.spectator.address, '0.0.0.0');
    });
  }
});

test('remote control flag exposes control', async (t) => {
  const app = await start(t, ['--allow-remote-control']);
  assert.equal(app.control.address, '0.0.0.0');
  assert.equal(app.spectator.address, '0.0.0.0');
  assert.doesNotMatch(app.output, /Control    local-only/);
});

test('remote control honors the selected interface', async (t) => {
  const app = await start(t, ['--allow-remote-control=true', '--bind=127.0.0.1']);
  assert.equal(app.control.address, '127.0.0.1');
  assert.equal(app.spectator.address, '127.0.0.1');
  assert.doesNotMatch(app.output, /Network    http/);
});

test('disabling spectators leaves control local-only', async (t) => {
  const app = await start(t, ['--no-spectator'], {}, false);
  assert.equal(app.control.address, '127.0.0.1');
  assert.equal(app.spectator, undefined);
  assert.doesNotMatch(app.output, /Spectator  read-only/);
});
