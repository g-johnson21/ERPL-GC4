/**
 * hal/index.js — driver factory.
 *
 * To add a driver for your own hardware (LabJack, NI DAQ, Raspberry Pi GPIO,
 * Modbus PLC...), implement this interface and register it below:
 *
 *   async init(config)          -> void        one-time setup
 *   setValve(valveCfg, state)   -> void        state is 'open' | 'closed'
 *   safeAll()                   -> void        optional, drive outputs safe
 *   read()                      -> {id: value} engineering units, keyed by sensor id
 *   get status()                -> {name, connected, detail}
 *   async close()               -> void
 */
import fs from 'node:fs';
import path from 'node:path';

import { SimulatorDriver } from './simulator.js';
import { UdpDriver } from './udp.js';
import { SerialDriver } from './serial.js';
import { NiDaqDriver } from './nidaq.js';
import { PandaDriver } from './panda.js';
import { CompositeDriver } from './composite.js';

const DRIVERS = {
  simulator: SimulatorDriver,
  udp: UdpDriver,
  serial: SerialDriver,
  nidaq: NiDaqDriver,
  panda: PandaDriver,
};

export function createDriver(name, options = {}) {
  if (name === 'stand') return createStandDriver(options);

  const Driver = DRIVERS[name];
  if (!Driver) {
    throw new Error(
      `Unknown driver "${name}". Available: ${driverNames().join(', ')}`
    );
  }
  return new Driver(options);
}

/**
 * The real stand: NI cDAQ for instrumentation, PANDA board for actuation.
 *
 * Wiring details (chassis name, card slots, serial port, and the channel maps
 * that tie hardware channels to sensor ids) live in `config/hardware.json`,
 * deliberately separate from `config/stand.json`. stand.json is edited through
 * the Config page and rewritten wholesale on save; hardware wiring should not
 * be reachable from a browser, and should not churn when someone retimes a
 * sequence.
 */
export function createStandDriver(options = {}) {
  const hw = loadHardwareConfig(options.hardwareConfig, options.root);

  const daq = new NiDaqDriver({ ...hw.nidaq, onEvent: options.onEvent });
  const panda = new PandaDriver({
    ...hw.panda,
    // A CLI --port-name overrides the file, for swapping a board at the pad.
    port: options.pandaPort || hw.panda?.port,
    onEvent: options.onEvent,
    onRaw: options.onRaw,
  });

  return new CompositeDriver({
    devices: [
      { key: 'nidaq', driver: daq, required: hw.nidaq?.required !== false, actuates: false },
      { key: 'panda', driver: panda, required: hw.panda?.required !== false, actuates: true },
    ],
    valveDevice: hw.valveDevice || {},
    onEvent: options.onEvent,
  });
}

function loadHardwareConfig(explicitPath, root) {
  const file = explicitPath
    ? path.resolve(root || process.cwd(), explicitPath)
    : path.resolve(root || process.cwd(), 'config/hardware.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `The "stand" driver needs a hardware config.\n` +
      `  Expected: ${file}\n` +
      `  Copy config/hardware.example.json and edit it for your wiring.`
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid hardware config ${file}: ${err.message}`);
  }
}

export function driverNames() {
  // "stand" is composed rather than registered, but it is still selectable.
  return [...Object.keys(DRIVERS), 'stand'];
}
