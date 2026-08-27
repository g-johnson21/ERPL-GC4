/**
 * Tests for the raw PANDA serial tap.
 *
 *   node --test server/tools/tap-hub.test.js
 *
 * The one property that matters is FIDELITY. A tap exists to answer "what did
 * the board actually send", so anything it silently normalises on the way to
 * the window — a trailing CR, a NUL, a high bit, an empty frame — is exactly
 * the byte someone turned it on to see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TapHub, terminalCommand } from './tap-hub.js';

/** A hub with one attached viewer, and the records that viewer receives. */
async function attached() {
  const hub = new TapHub({ onNotice: () => {} });
  const port = await hub.start();

  const records = [];
  let buffer = '';
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const sp = line.indexOf(' ');
      records.push({ dir: line.slice(0, sp), bytes: Buffer.from(line.slice(sp + 1), 'base64') });
    }
  });
  await new Promise((r) => socket.once('connect', r));
  await new Promise((r) => setTimeout(r, 50));

  return {
    hub, records,
    close: () => { socket.destroy(); hub.close(); },
    settle: () => new Promise((r) => setTimeout(r, 80)),
  };
}

test('the Windows launcher hands cmd one verbatim, correctly quoted line', () => {
  // The failure this guards against is not a crash. Passing the title as its
  // own array element lets Node escape the quotes as \", so cmd reads \"PANDA
  // as the title and tries to run `raw` as a program -- a Windows dialog
  // saying "Windows cannot find 'raw'", which says nothing about quoting.
  const spec = terminalCommand('C:\\Programming\\ERPL-GC4\\server\\tools\\panda-tap.js', 55854, 'win32');

  assert.equal(spec.command, 'cmd');
  assert.equal(spec.args.length, 1, 'ONE argument: Node must not re-quote a prepared line');
  assert.equal(spec.options.windowsVerbatimArguments, true,
    'without this Node escapes the quotes and start mis-reads the title');
  assert.equal(
    spec.args[0],
    '/c start "PANDA raw serial" cmd /k node "C:\\Programming\\ERPL-GC4\\server\\tools\\panda-tap.js" 55854'
  );
});

test('a viewer path containing spaces stays one argument', () => {
  // The repo can live anywhere, including under "Program Files".
  const spec = terminalCommand('C:\\My Stand\\gc4\\panda-tap.js', 42, 'win32');
  assert.match(spec.args[0], /cmd \/k node "C:\\My Stand\\gc4\\panda-tap\.js" 42$/);
});

test('the title is present and quoted, so start never eats the command', () => {
  // `start` takes the first quoted token as the window title. Omit it and the
  // quoted viewer path becomes the title, and nothing runs at all.
  const spec = terminalCommand('/tmp/panda-tap.js', 1, 'win32');
  assert.match(spec.args[0], /^\/c start "[^"]+" cmd \/k /);
});

test('macOS and Linux launchers are shaped for their own platforms', () => {
  const mac = terminalCommand('/opt/gc4/panda-tap.js', 900, 'darwin');
  assert.equal(mac.command, 'osascript');
  assert.match(mac.args[1], /do script "node '\/opt\/gc4\/panda-tap\.js' 900"/);

  // Linux has no single terminal, so the caller tries candidates in turn.
  const linux = terminalCommand('/opt/gc4/panda-tap.js', 900, 'linux');
  assert.equal(linux.command, null);
  assert.ok(linux.candidates.includes('xterm'));
  assert.deepEqual(linux.args, ['-e', 'node', '/opt/gc4/panda-tap.js', '900']);
});

test('every byte survives the relay exactly', async () => {
  const t = await attached();
  // A trailing CR, an embedded NUL, a set high bit, and an empty frame: the
  // four things a plain-text relay would eat.
  const samples = [
    Buffer.from('s0.00,0.00,0.38\r', 'ascii'),
    Buffer.from([0x70, 0x31, 0x2e, 0x35, 0x00, 0xff, 0x0d]),
    Buffer.alloc(0),
    Buffer.from('BB:l:SUS:1:0:312.4', 'ascii'),
  ];
  for (const s of samples) t.hub.write('rx', s);
  await t.settle();

  assert.equal(t.records.length, samples.length, 'an empty frame is still a frame');
  samples.forEach((sent, i) => {
    assert.deepEqual(t.records[i].bytes, sent, `record ${i} differs from what was written`);
  });
  t.close();
});

test('direction is carried, so a command and its answer read as one exchange', async () => {
  const t = await attached();
  t.hub.write('tx', Buffer.from('BF450.0,30.0,250,500', 'ascii'));
  t.hub.write('rx', Buffer.from('EVT:1:CFG_PUSH:f:sp=450.0', 'ascii'));
  await t.settle();

  assert.deepEqual(t.records.map((r) => r.dir), ['tx', 'rx']);
  t.close();
});

test('the hub binds loopback only', async () => {
  // The telemetry server is deliberately reachable across the pad network.
  // A stream carrying every command the board is given is not.
  const hub = new TapHub({ onNotice: () => {} });
  await hub.start();
  assert.equal(hub.server.address().address, '127.0.0.1');
  hub.close();
});

test('writing with no viewer attached costs nothing and never throws', async () => {
  const hub = new TapHub({ onNotice: () => {} });
  await hub.start();
  // The common case: the flag is on, the window was closed, the stand keeps
  // running. This is called for every line the board sends, so it has to be
  // free and it has to be safe.
  for (let i = 0; i < 1000; i++) hub.write('rx', Buffer.from('s0.00,0.00', 'ascii'));
  assert.equal(hub.clients.size, 0);
  hub.close();
});

test('a viewer that stops reading is dropped, not queued without bound', async () => {
  const t = await attached();
  // Simulate a stalled reader by pretending the socket buffer is full.
  for (const socket of t.hub.clients) {
    Object.defineProperty(socket, 'writableLength', { get: () => 1 << 30 });
  }
  for (let i = 0; i < 100; i++) t.hub.write('rx', Buffer.alloc(64));

  assert.equal(t.hub.dropped, 100, 'records are dropped rather than buffered');
  // The point: a diagnostic window nobody is reading must not become unbounded
  // memory inside the process that is also running the stand.
  t.close();
});

test('a closed viewer detaches instead of accumulating', async () => {
  const t = await attached();
  assert.equal(t.hub.clients.size, 1);
  t.close();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(t.hub.clients.size, 0);
});
