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
import { SimulatorDriver } from './simulator.js';
import { UdpDriver } from './udp.js';
import { SerialDriver } from './serial.js';

const DRIVERS = {
  simulator: SimulatorDriver,
  udp: UdpDriver,
  serial: SerialDriver,
};

export function createDriver(name, options = {}) {
  const Driver = DRIVERS[name];
  if (!Driver) {
    throw new Error(`Unknown driver "${name}". Available: ${Object.keys(DRIVERS).join(', ')}`);
  }
  return new Driver(options);
}

export function driverNames() {
  return Object.keys(DRIVERS);
}
