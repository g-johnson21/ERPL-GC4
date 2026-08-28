/**
 * config-store.js — loads, validates, and hot-reloads config/stand.json.
 *
 * The config file is the single source of truth for the entire application.
 * Nothing about a particular stand should ever be hard-coded elsewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const VALID_VALVE_TYPES = ['solenoid', 'ball', 'butterfly', 'needle', 'igniter', 'motor'];
const VALID_SENSOR_KINDS = ['pressure', 'temperature', 'force', 'flow', 'level', 'voltage', 'other'];
const VALID_STATES = ['open', 'closed'];

export class ConfigStore extends EventEmitter {
  constructor(configPath) {
    super();
    this.path = path.resolve(configPath);
    this.config = null;
    this.load();
  }

  load() {
    const raw = fs.readFileSync(this.path, 'utf8');
    const parsed = JSON.parse(raw);
    const errors = validateConfig(parsed);
    if (errors.length) {
      throw new Error(`Invalid config ${this.path}:\n  - ${errors.join('\n  - ')}`);
    }
    this.config = normalizeConfig(parsed);
    warnRetiredKeys(parsed);
    return this.config;
  }

  /** Validate + write + hot reload. Returns {ok, errors}. */
  save(newConfig) {
    const errors = validateConfig(newConfig);
    if (errors.length) return { ok: false, errors };

    // Keep a timestamped backup so a bad edit at the pad is always recoverable.
    try {
      const backupDir = path.join(path.dirname(this.path), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(this.path, path.join(backupDir, `stand.${stamp}.json`));
      pruneBackups(backupDir, 20);
    } catch (err) {
      console.warn('[config] backup failed:', err.message);
    }

    fs.writeFileSync(this.path, JSON.stringify(newConfig, null, 2) + '\n', 'utf8');
    this.config = normalizeConfig(newConfig);
    this.emit('reload', this.config);
    return { ok: true, errors: [] };
  }

  reload() {
    this.load();
    this.emit('reload', this.config);
    return this.config;
  }

  /**
   * Which top-level sections `next` would change, compared to what is running.
   *
   * Used to decide whether a save is safe while the stand is armed: retiming a
   * countdown is, rewiring a valve channel is not. Both sides are normalized
   * first, so the defaults this store fills in are never mistaken for edits,
   * and key order is ignored, so a re-serialized file is not a "change".
   */
  changedSections(next) {
    const before = this.config;
    const after = normalizeConfig(next);
    const changed = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (canonical(before[key]) !== canonical(after[key])) changed.push(key);
    }
    return changed;
  }

  get() { return this.config; }
  valve(id) { return this.config.valves.find((v) => v.id === id); }
  sensor(id) { return this.config.sensors.find((s) => s.id === id); }
  controller(id) { return this.config.bangbang.find((c) => c.id === id); }
  sequence(id) { return this.config.autosequences.find((s) => s.id === id); }
}

/**
 * JSON with object keys sorted, so two configs that differ only in key order
 * compare equal. Arrays keep their order — the order of steps in a sequence,
 * or of valves in a group, is meaningful.
 */
function canonical(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
  });
}

function pruneBackups(dir, keep) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.unlinkSync(path.join(dir, f));
  }
}

/** Fill in optional fields so downstream code never has to guard for undefined. */
function normalizeConfig(c) {
  const cfg = structuredClone(c);

  cfg.meta ??= {};
  cfg.ui ??= {};
  cfg.ui.brand ??= cfg.meta.organization || 'Ground Control';
  cfg.ui.accent ??= '#ff7a1a';
  cfg.ui.defaultTheme ??= 'dark';
  cfg.ui.gridColumns ??= 4;
  cfg.ui.sparklineSeconds ??= 60;
  cfg.ui.confirmDangerousActions ??= true;
  cfg.ui.pages ??= [];

  cfg.telemetry ??= {};
  cfg.telemetry.sampleRateHz ??= 50;
  cfg.telemetry.streamRateHz ??= 20;
  cfg.telemetry.historySeconds ??= 120;

  cfg.safety ??= {};
  cfg.safety.requireArmToActuate ??= true;
  cfg.safety.autoDisarmAfterSeconds ??= 0;

  cfg.valveGroups ??= [];
  cfg.sensorGroups ??= [];
  cfg.valves ??= [];
  cfg.sensors ??= [];
  cfg.bangbang ??= [];
  cfg.autosequences ??= [];

  cfg.recording ??= {};
  cfg.recording.directory ??= 'data';
  cfg.recording.filenamePattern ??= '{stand}_{date}_{time}_{name}.csv';
  cfg.recording.defaultTestName ??= 'test';
  cfg.recording.rateHz ??= 50;
  cfg.recording.includeValveStates ??= true;
  cfg.recording.includeSetpoints ??= true;
  cfg.recording.derived ??= [];
  cfg.recording.flushIntervalMs ??= 500;

  cfg.pid ??= { width: 1600, height: 900, fluids: {}, components: [], pipes: [] };
  cfg.pid.components ??= [];
  cfg.pid.pipes ??= [];
  cfg.pid.fluids ??= {};

  for (const v of cfg.valves) {
    v.type ??= 'solenoid';
    v.group ??= 'aux';
    v.normallyOpen ??= false;
    v.requiresArm ??= true;
    v.momentary ??= false;
    v.momentaryMs ??= 1000;
    v.openLabel ??= 'OPEN';
    v.closedLabel ??= 'CLOSED';
    v.safeState ??= v.normallyOpen ? 'open' : 'closed';
    v.abortState ??= v.safeState;
    v.abbrev ??= v.name || v.id;
  }

  for (const s of cfg.sensors) {
    s.kind ??= 'other';
    // Grouping drives the Data page layout and the P&ID instrument colour.
    // Falling back to `kind` means a config that never heard of sensorGroups
    // still groups the way it always did — pressure, temperature, force.
    s.group ??= s.kind;
    s.units ??= '';
    s.decimals ??= 1;
    s.min ??= 0;
    s.max ??= 100;
    s.calibration ??= { slope: 1, offset: 0 };
    s.calibration.slope ??= 1;
    s.calibration.offset ??= 0;
    s.abbrev ??= s.name || s.id;
  }

  for (const b of cfg.bangbang) {
    b.enabled ??= false;
    b.deadband ??= 10;
    b.setpointMin ??= 0;
    b.setpointMax ??= 1000;
    b.setpointStep ??= 5;
    b.deadbandMin ??= 1;
    b.deadbandMax ??= 100;
    b.requiresArm ??= true;
    b.maxOpenSeconds ??= 0;
    // Duty-cycle limits, both disregarded when 0. maxOpenMs is the board's
    // max_open_ms; minIntervalMs is its wait_ms.
    b.maxOpenMs ??= 0;
    b.minIntervalMs ??= 0;
    // Auto-vent defaults OFF even when a trigger is configured. Venting a
    // tank is not a thing to start doing because a field was left unset.
    b.ventAuto ??= false;
    b.abbrev ??= b.name || b.id;
    // Normalised so nothing downstream has to care about case. The board's
    // commands take uppercase; its heartbeat reports lowercase.
    if (typeof b.side === 'string') b.side = b.side.toUpperCase();
  }

  for (const s of cfg.autosequences) {
    s.steps ??= [];
    s.abortConditions ??= [];
    s.requiresArm ??= true;
    s.confirm ??= true;
    s.style ??= 'normal';
    s.hidden ??= false;
    s.abbrev ??= s.name || s.id;
    s.steps.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    s.duration = s.steps.length ? Math.max(...s.steps.map((x) => x.t ?? 0)) : 0;
  }

  return cfg;
}

/**
 * Settings that no longer do anything, called out rather than dropped.
 *
 * Recording is an operator decision now, so a config that still asks a sequence
 * to open or close a file gets nothing — and the failure mode is a test that
 * quietly was not recorded. A warning at startup costs one line and is the only
 * chance anyone has to notice before the run.
 *
 * Loud, not fatal: refusing to boot at the pad over a dead key would be worse
 * than the key.
 */
function warnRetiredKeys(raw) {
  const retired = ['autoStartOnSequence', 'autoStopSecondsAfterSequence']
    .filter((k) => raw?.recording?.[k] !== undefined);
  if (!retired.length) return;
  console.warn(
    `[config] recording.${retired.join(' and recording.')} ` +
    `${retired.length > 1 ? 'are' : 'is'} no longer supported and will be ignored — ` +
    'sequences cannot start or stop log files. Use Start New Log File in the header.'
  );
}

export function validateConfig(c) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!c || typeof c !== 'object') return ['config is not an object'];
  if (!Array.isArray(c.valves)) err('valves must be an array');
  if (!Array.isArray(c.sensors)) err('sensors must be an array');
  if (errors.length) return errors;

  const valveIds = new Set();
  const usedChannels = new Map();
  for (const [i, v] of c.valves.entries()) {
    const where = `valves[${i}]`;
    if (!v.id) { err(`${where}: missing id`); continue; }
    if (valveIds.has(v.id)) err(`${where}: duplicate valve id "${v.id}"`);
    valveIds.add(v.id);
    if (!/^[A-Za-z0-9_\-]+$/.test(v.id)) err(`${where}: id "${v.id}" must be alphanumeric/dash/underscore`);
    if (v.type && !VALID_VALVE_TYPES.includes(v.type)) {
      err(`${where}: type "${v.type}" not one of ${VALID_VALVE_TYPES.join(', ')}`);
    }
    if (!Number.isInteger(v.channel) || v.channel < 0) err(`${where} (${v.id}): channel must be a non-negative integer`);
    else if (usedChannels.has(v.channel)) err(`${where} (${v.id}): channel ${v.channel} already used by ${usedChannels.get(v.channel)}`);
    else usedChannels.set(v.channel, v.id);
    for (const k of ['safeState', 'abortState']) {
      if (v[k] && !VALID_STATES.includes(v[k])) err(`${where} (${v.id}): ${k} must be "open" or "closed"`);
    }
  }

  const groupIds = new Set();
  for (const [i, g] of (c.sensorGroups || []).entries()) {
    if (!g.id) { err(`sensorGroups[${i}]: missing id`); continue; }
    if (groupIds.has(g.id)) err(`sensorGroups[${i}]: duplicate group id "${g.id}"`);
    groupIds.add(g.id);
    if (g.color && !/^#[0-9a-fA-F]{6}$/.test(g.color)) {
      err(`sensorGroups[${i}] (${g.id}): color must be a #rrggbb hex string`);
    }
  }

  const sensorIds = new Set();
  const usedSensorChannels = new Map();
  for (const [i, s] of c.sensors.entries()) {
    const where = `sensors[${i}]`;
    if (!s.id) { err(`${where}: missing id`); continue; }
    if (sensorIds.has(s.id)) err(`${where}: duplicate sensor id "${s.id}"`);
    sensorIds.add(s.id);
    if (s.kind && !VALID_SENSOR_KINDS.includes(s.kind)) {
      err(`${where} (${s.id}): kind "${s.kind}" not one of ${VALID_SENSOR_KINDS.join(', ')}`);
    }
    if (!Number.isInteger(s.channel) || s.channel < 0) err(`${where} (${s.id}): channel must be a non-negative integer`);
    else if (usedSensorChannels.has(s.channel)) err(`${where} (${s.id}): channel ${s.channel} already used by ${usedSensorChannels.get(s.channel)}`);
    else usedSensorChannels.set(s.channel, s.id);
    if (s.min != null && s.max != null && Number(s.min) >= Number(s.max)) err(`${where} (${s.id}): min must be < max`);
  }

  const usedSides = new Map();
  for (const [i, b] of (c.bangbang || []).entries()) {
    const where = `bangbang[${i}]`;
    if (!b.id) { err(`${where}: missing id`); continue; }
    // The board has exactly two bang-bang buses. A controller with no side
    // cannot be pushed to it at all, and two controllers on one side would
    // fight over the same setpoint — the board keeps one config per side.
    const side = String(b.side || '').toUpperCase();
    if (side !== 'L' && side !== 'F') {
      err(`${where} (${b.id}): side must be "L" (LOX) or "F" (Fuel) — the board bus this controller runs on`);
    } else if (usedSides.has(side)) {
      err(`${where} (${b.id}): board side ${side} is already used by ${usedSides.get(side)} — the board holds one config per side`);
    } else {
      usedSides.set(side, b.id);
    }
    if (!sensorIds.has(b.sensor)) err(`${where} (${b.id}): sensor "${b.sensor}" is not a defined sensor`);
    if (!valveIds.has(b.valve)) err(`${where} (${b.id}): valve "${b.valve}" is not a defined valve`);
    if (b.ventValve != null && !valveIds.has(b.ventValve)) {
      err(`${where} (${b.id}): ventValve "${b.ventValve}" is not a defined valve`);
    }
    if (typeof b.setpoint !== 'number') err(`${where} (${b.id}): setpoint must be a number`);
    if (b.deadband != null && Number(b.deadband) <= 0) err(`${where} (${b.id}): deadband must be > 0`);
    if (b.ventTrigger != null && (!Number.isFinite(Number(b.ventTrigger)) || Number(b.ventTrigger) < 0)) {
      err(`${where} (${b.id}): ventTrigger must be a number >= 0`);
    }
    if (b.ventAuto && b.ventTrigger == null) {
      err(`${where} (${b.id}): ventAuto needs a ventTrigger pressure to vent at`);
    }
    for (const k of ['maxOpenMs', 'minIntervalMs']) {
      if (b[k] != null && (!Number.isFinite(Number(b[k])) || Number(b[k]) < 0)) {
        err(`${where} (${b.id}): ${k} must be a number >= 0 (0 disables it)`);
      }
    }
    // A pulse longer than the hard trip can never fire: the trip would cut in
    // first, disabling the controller instead of limiting the pulse.
    if (Number(b.maxOpenMs) > 0 && Number(b.maxOpenSeconds) > 0 &&
        Number(b.maxOpenMs) >= Number(b.maxOpenSeconds) * 1000) {
      err(`${where} (${b.id}): maxOpenMs (${b.maxOpenMs}) must be less than ` +
          `maxOpenSeconds (${b.maxOpenSeconds}s = ${b.maxOpenSeconds * 1000}ms), ` +
          `or the leak trip fires before the pulse limit`);
    }
  }

  const seqIds = new Set();
  for (const [i, s] of (c.autosequences || []).entries()) {
    const where = `autosequences[${i}]`;
    if (!s.id) { err(`${where}: missing id`); continue; }
    if (seqIds.has(s.id)) err(`${where}: duplicate sequence id "${s.id}"`);
    seqIds.add(s.id);
    for (const [j, step] of (s.steps || []).entries()) {
      const sw = `${where}.steps[${j}]`;
      if (typeof step.t !== 'number' || step.t < 0) err(`${sw}: t must be a number >= 0`);
      switch (step.action) {
        case 'valve':
          if (!valveIds.has(step.target)) err(`${sw}: target "${step.target}" is not a defined valve`);
          if (!VALID_STATES.includes(step.state)) err(`${sw}: state must be "open" or "closed"`);
          break;
        case 'bangbang':
          if (step.target !== '*' && !(c.bangbang || []).some((b) => b.id === step.target)) {
            err(`${sw}: target "${step.target}" is not a defined bang-bang controller`);
          }
          break;
        case 'log': case 'safeAll': case 'abortStates': case 'abort': case 'end':
          break;
        default:
          err(`${sw}: unknown action "${step.action}"`);
      }
    }
    for (const [j, cond] of (s.abortConditions || []).entries()) {
      const cw = `${where}.abortConditions[${j}]`;
      if (!sensorIds.has(cond.sensor)) err(`${cw}: sensor "${cond.sensor}" is not a defined sensor`);
      if (!['>', '<', '>=', '<='].includes(cond.op)) err(`${cw}: op must be one of > < >= <=`);
      if (typeof cond.value !== 'number') err(`${cw}: value must be a number`);
    }
  }

  if (c.safety?.abortSequenceId && !seqIds.has(c.safety.abortSequenceId)) {
    err(`safety.abortSequenceId "${c.safety.abortSequenceId}" is not a defined autosequence`);
  }

  for (const [i, p] of (c.pid?.pipes || []).entries()) {
    if (!Array.isArray(p.points) || p.points.length < 2) err(`pid.pipes[${i}]: needs at least 2 points`);
    for (const vid of p.flowWhen || []) {
      if (!valveIds.has(vid)) err(`pid.pipes[${i}]: flowWhen references unknown valve "${vid}"`);
    }
  }

  for (const [i, comp] of (c.pid?.components || []).entries()) {
    if (comp.levelSensor && !sensorIds.has(comp.levelSensor)) {
      err(`pid.components[${i}]: levelSensor "${comp.levelSensor}" is not a defined sensor`);
    }
  }

  return errors;
}
