/**
 * panda-tap.js — a window that prints exactly what crosses the PANDA link.
 *
 *   node server/tools/panda-tap.js <port>
 *
 * Started for you by `node server/index.js --driver=stand --panda-tap`, which
 * opens it in its own terminal. Run it by hand against the same port if the
 * window did not open, or to reattach after closing it.
 *
 * WHY IT CONNECTS BACK INSTEAD OF OPENING THE PORT
 *   A serial port has exactly one owner. The server holds COM5 for the whole
 *   run, so a second process cannot open it — the only honest way to see the
 *   traffic is to have the process that owns the port relay it. The server
 *   listens on a loopback port and this attaches to it.
 *
 *   That means this shows what the DRIVER framed, not the electrical stream.
 *   The two differ in one way worth knowing: bytes still sitting in the
 *   reassembly buffer with no newline yet are not here, because they are not
 *   a line yet. If the board stops mid-line, you see nothing rather than a
 *   fragment — the server's own framing diagnostic covers that case.
 *
 * READ-ONLY. It cannot send anything to the board, deliberately: a debug
 * window that can actuate is a debug window somebody actuates by accident.
 */
import net from 'node:net';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('usage: node server/tools/panda-tap.js <port>');
  process.exit(2);
}

/**
 * Bytes that need no hex dump: printable ASCII, plus CR and TAB.
 *
 * CR is excluded from "surprising" on purpose. A board sending CRLF puts one
 * on every single line, and hex-dumping all of them doubles the output for no
 * information — the escaped `\r` in the text view already shows it is there.
 * Anything else non-printable is the case this window exists for.
 */
const UNSURPRISING = /^[\x20-\x7e\r\t]*$/;

/** Control and high bytes shown as escapes, so nothing is silently invisible. */
function escape(buf) {
  let out = '';
  for (const b of buf) {
    if (b === 0x0d) out += '\\r';
    else if (b === 0x09) out += '\\t';
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

function hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

let count = 0;
const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
  console.log(`PANDA raw serial tap — attached on 127.0.0.1:${port}`);
  console.log('  <  board -> host        >  host -> board');
  console.log('  Non-printable bytes are escaped; a line containing any also gets a hex dump.');
  console.log('  Read-only: this window cannot command the board. Ctrl+C to close.\n');
});

let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const record = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!record) continue;

    // The server frames each event as <dir> <base64>, so the payload survives
    // the relay byte for byte regardless of what the board sent.
    const sp = record.indexOf(' ');
    const dir = record.slice(0, sp);
    const bytes = Buffer.from(record.slice(sp + 1), 'base64');
    const text = bytes.toString('ascii');

    count++;
    const arrow = dir === 'tx' ? '>' : '<';
    console.log(`${stamp()} ${arrow} ${String(bytes.length).padStart(4)}B  ${escape(bytes)}`);
    if (!UNSURPRISING.test(text)) console.log(`${' '.repeat(13)}  hex  ${hex(bytes)}`);
  }
});

socket.on('error', (err) => {
  console.error(`\ntap: ${err.message}`);
  console.error('The server may not be running, or was started without --panda-tap.');
  process.exit(1);
});

socket.on('close', () => {
  console.log(`\ntap: server closed the connection after ${count} record(s).`);
  process.exit(0);
});
