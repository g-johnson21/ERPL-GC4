/**
 * tap-hub.js — relays the PANDA's raw serial traffic to a viewer window.
 *
 * A serial port has one owner, so a second process cannot open COM5 while the
 * server holds it. This listens on loopback, the viewer attaches, and every
 * framed line in and command out is forwarded verbatim.
 *
 * Records are `<dir> <base64>\n`. Base64 because the whole point is fidelity:
 * a board sending a stray 0x00 or a high bit must arrive at the viewer exactly
 * as it left the wire, and a plain-text relay would mangle precisely the bytes
 * worth looking at.
 *
 * LOOPBACK ONLY. It binds 127.0.0.1, never 0.0.0.0. The stand's telemetry
 * server is deliberately reachable across the pad network; a debug stream that
 * carries every command the board is given is not something to put there too.
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = path.join(__dirname, 'panda-tap.js');

/** Dropped rather than queued without bound if a viewer stops reading. */
const MAX_BACKLOG_BYTES = 1 << 20;

export class TapHub {
  constructor({ onNotice = console.error } = {}) {
    this.clients = new Set();
    this.onNotice = onNotice;
    this.server = null;
    this.port = 0;
    this.dropped = 0;
  }

  /** Listen on an OS-assigned loopback port. Resolves with that port. */
  async start() {
    this.server = net.createServer((socket) => {
      socket.on('error', () => this.clients.delete(socket));
      socket.on('close', () => this.clients.delete(socket));
      this.clients.add(socket);
      this.onNotice(`[tap] viewer attached (${this.clients.size} total)`);
    });
    this.server.unref();

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  /** Forward one framed line. `bytes` is exactly what crossed the link. */
  write(direction, bytes) {
    if (!this.clients.size) return;
    const record = `${direction} ${bytes.toString('base64')}\n`;
    for (const socket of this.clients) {
      // A viewer that has stopped draining must not become unbounded memory in
      // the process that is also running the stand. Dropping is the right
      // failure here: this is a diagnostic, and the control loop is not.
      if (socket.writableLength > MAX_BACKLOG_BYTES) {
        this.dropped++;
        continue;
      }
      socket.write(record);
    }
  }

  /**
   * Open the viewer in a terminal of its own.
   *
   * Best-effort by design. Spawning a terminal is the least portable thing in
   * this codebase — it depends on the desktop environment, not just the OS —
   * so a failure prints the command to run by hand rather than taking the
   * server down with it. The tap still works either way; only the convenience
   * of the window is lost.
   */
  openViewer() {
    const command = `node "${VIEWER}" ${this.port}`;
    try {
      const child = spawnTerminal(VIEWER, this.port);
      child.on('error', () => this.explain(command));
      child.unref();
      return true;
    } catch {
      this.explain(command);
      return false;
    }
  }

  explain(command) {
    this.onNotice(
      `[tap] could not open a terminal window. Run this in one yourself:\n    ${command}`
    );
  }

  close() {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    this.server?.close();
  }
}

/**
 * Launch `node <viewer> <port>` in a new terminal window.
 *
 * WINDOWS QUOTING, which is worth spelling out because getting it wrong fails
 * in a confusing way. `start` is a cmd builtin, hence the `cmd /c` wrapper.
 * The first quoted token after `start` is always taken as the window TITLE, so
 * a title has to be supplied — otherwise a quoted viewer path becomes the
 * title and the command never runs.
 *
 * The quotes must reach cmd intact, and Node's normal argument handling
 * escapes embedded quotes as \" when it builds the command line. cmd then sees
 * \"PANDA as the title and tries to execute `raw` as a program, giving
 * "Windows cannot find 'raw'". So the whole command line is built here and
 * passed through with windowsVerbatimArguments, which tells Node to hand it to
 * CreateProcess exactly as written.
 */
export function terminalCommand(viewer, port, platform = process.platform) {
  const base = { detached: true, stdio: 'ignore' };

  if (platform === 'win32') {
    // One pre-quoted string, passed through untouched. The viewer path is
    // quoted for spaces; the title is quoted so `start` claims it as the title
    // rather than treating the next word as a command.
    return {
      command: 'cmd',
      args: [`/c start "PANDA raw serial" cmd /k node "${viewer}" ${port}`],
      options: { ...base, windowsVerbatimArguments: true, windowsHide: false },
    };
  }

  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "node '${viewer}' ${port}"`],
      options: base,
    };
  }

  return {
    command: null,          // resolved by trying the candidates below
    candidates: ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'],
    args: ['-e', 'node', viewer, String(port)],
    options: base,
  };
}

function spawnTerminal(viewer, port) {
  const spec = terminalCommand(viewer, port);

  if (spec.command) return spawn(spec.command, spec.args, spec.options);

  // Linux desktops vary; try the common terminals in turn and let the caller's
  // error handler print the manual command if none of them is present.
  for (const term of spec.candidates) {
    try {
      return spawn(term, spec.args, spec.options);
    } catch { /* try the next one */ }
  }
  throw new Error('no terminal emulator found');
}
