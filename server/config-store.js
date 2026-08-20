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

  get() { return this.config; }
  valve(id) { return this.config.valves.find((v) => v.id === id); }
  sensor(id) { return this.config.sensors.find((s) => s.id === id); }
  controller(id) { return this.config.bangbang.find((c) => c.id === id); }
  sequence(id) { return this.config.autosequences.find((s) => s.id === id); }
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
  cfg.ui.sensorGridColumns ??= 4;
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
  cfg.recording.autoStartOnSequence ??= [];
  cfg.recording.autoStopSecondsAfterSequence ??= 10;
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
    v.confirm ??= false;
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
    b.abbrev ??= b.name || b.id;
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

  for (const [i, b] of (c.bangbang || []).entries()) {
    const where = `bangbang[${i}]`;
    if (!b.id) { err(`${where}: missing id`); continue; }
    if (!sensorIds.has(b.sensor)) err(`${where} (${b.id}): sensor "${b.sensor}" is not a defined sensor`);
    if (!valveIds.has(b.valve)) err(`${where} (${b.id}): valve "${b.valve}" is not a defined valve`);
    if (typeof b.setpoint !== 'number') err(`${where} (${b.id}): setpoint must be a number`);
    if (b.deadband != null && Number(b.deadband) <= 0) err(`${where} (${b.id}): deadband must be > 0`);
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
