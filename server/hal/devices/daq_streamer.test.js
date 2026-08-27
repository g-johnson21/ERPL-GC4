/**
 * Runs the NI-DAQ sidecar's Python self-test as part of `npm test`.
 *
 *   node --test server/hal/devices/daq_streamer.test.js
 *
 * The sidecar is a separate process in another language, so the Node suite
 * never loads it and every bug in it is invisible here. That is not
 * hypothetical: tare was broken for every PT channel on real hardware and
 * nothing in this repo could see it, because the simulator implements its own
 * tareSensors() and the sidecar's own path had no coverage at all.
 *
 * SKIPPED, not failed, when the host has no Python. Anyone running the
 * simulator needs neither Python nor NI-DAQmx, and a red suite on a laptop
 * that was never going to talk to a cDAQ teaches people to ignore the suite.
 * The assertions themselves live in daq_streamer_selftest.py, which imports
 * the sidecar directly and needs no hardware.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELFTEST = path.join(__dirname, 'daq_streamer_selftest.py');

/** The first interpreter on this host that can actually run, or null. */
function findPython() {
  for (const exe of [process.env.GC_PYTHON, 'python', 'python3'].filter(Boolean)) {
    const probe = spawnSync(exe, ['-c', 'import sys; sys.exit(0)'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

const python = findPython();

test('the DAQ sidecar tares against a value its convert() can accept', { skip: python ? false : 'no Python on this host' }, () => {
  const run = spawnSync(python, [SELFTEST], { encoding: 'utf8' });

  // Printed on failure so the Python assertion text reaches whoever is reading
  // the Node output, rather than being summarised away to an exit code.
  if (run.status !== 0) console.error(run.stdout + run.stderr);

  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, 'daq_streamer_selftest.py reported a failure');
  assert.match(run.stdout, /all sidecar tare checks passed/);
});
