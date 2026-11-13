/* seq-model.js — what an autosequence DOES, worked out from its steps.
 *
 * The editor draws a sequence as swimlanes, one per actuator, and has to know
 * at every moment what state each actuator is in. That is not written down
 * anywhere in a sequence: it follows from the steps, and not only from the
 * steps that name the valve. SAFE ALL and ABORT STATES move every valve; a
 * momentary actuator closes itself after its pulse; an END or ABORT step cuts
 * off everything after it. All of that is worked out here, with no DOM, so it
 * can be tested and so the timeline, the script and the lint agree.
 *
 * Steps are referenced by object identity throughout. The editor keeps its
 * selection as a set of step objects, which survives re-sorting.
 */

export const STEP_ACTIONS = [
  { value: 'valve', label: 'Set valve', hint: 'Command a valve open or closed' },
  { value: 'bangbang', label: 'Bang-bang', hint: "Start or stop the board's regulator, or change what it regulates to" },
  { value: 'log', label: 'Milestone', hint: 'Write a line to the event log and the CSV' },
  { value: 'safeAll', label: 'Safe all', hint: 'Drive every valve to its safe state' },
  { value: 'abortStates', label: 'Abort states', hint: 'Drive every valve to its abort state' },
  { value: 'abort', label: 'Trigger ABORT', hint: 'Latch a stand-wide abort' },
  { value: 'end', label: 'End', hint: 'Stop the sequence here' },
  { value: 'gate', label: 'Gate check', hint: 'Check sensors here; run a fail action if they are not where they should be' },
];

/** Actions drawn on the milestone lane rather than an actuator lane. */
export const EVENT_ACTIONS = new Set(['log', 'safeAll', 'abortStates', 'abort', 'end', 'gate']);

// ----------------------------------------------------------------- gates --
// A gate step's shape (see server/sequencer.js for how it runs):
//   { t, action: 'gate', conditions: [{ sensor, op, value } | { sensor, op: 'between'|'outside', min, max }],
//     match: 'all'|'any', timeout: s, hold: s, blocking: bool,
//     onFail: 'abort'|'sequence'|'safeAll'|'stop'|'continue', failSequence: id, message }

export const GATE_OPS = [
  { value: '>', label: '>' },
  { value: '>=', label: '≥' },
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: 'between', label: 'between' },
  { value: 'outside', label: 'outside' },
];
export const GATE_RANGE_OPS = new Set(['between', 'outside']);

export const GATE_FAIL_ACTIONS = [
  { value: 'abort', label: 'ABORT the stand', hint: 'Latch a stand-wide abort, which runs the abort sequence' },
  { value: 'sequence', label: 'Run a sequence', hint: 'Stop this sequence and start another in its place' },
  { value: 'safeAll', label: 'Safe all', hint: 'Stop this sequence and drive every valve to its safe state' },
  { value: 'setValves', label: 'Set valve states', hint: 'Drive the chosen valves to the chosen states whatever they are now, turning off any loop that holds one' },
  { value: 'stop', label: 'Stop sequence', hint: 'Stop this sequence and leave every valve where it is' },
  { value: 'continue', label: 'Log and continue', hint: 'Note the failure in the log and keep running' },
];

export function conditionText(cond) {
  if (cond.op === 'between') return `${cond.sensor} in [${cond.min}, ${cond.max}]`;
  if (cond.op === 'outside') return `${cond.sensor} outside [${cond.min}, ${cond.max}]`;
  return `${cond.sensor} ${cond.op} ${cond.value}`;
}

export function gateLabel(step) {
  return (step.conditions || []).map(conditionText).join(step.match === 'any' ? ' OR ' : ' AND ') || '(no conditions)';
}

/**
 * Everything wrong with a gate step, as messages. The server refuses to save
 * a config with any of these; the editor shows them beside the step.
 */
export function gateProblems(step, seq, config) {
  const out = [];
  const sensors = new Set((config.sensors || []).map((s) => s.id));
  const seqs = config.autosequences || [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const conds = step.conditions;
  if (!Array.isArray(conds) || !conds.length) out.push('needs at least one condition');
  for (const [k, cond] of (Array.isArray(conds) ? conds : []).entries()) {
    const at = `condition ${k + 1}`;
    if (!sensors.has(cond.sensor)) out.push(`${at}: "${cond.sensor}" is not a defined sensor`);
    if (!GATE_OPS.some((o) => o.value === cond.op)) out.push(`${at}: op must be one of ${GATE_OPS.map((o) => o.value).join(' ')}`);
    else if (GATE_RANGE_OPS.has(cond.op)) {
      if (!num(cond.min) || !num(cond.max)) out.push(`${at}: ${cond.op} needs numeric min and max`);
      else if (cond.min > cond.max) out.push(`${at}: min is above max`);
    } else if (!num(cond.value)) out.push(`${at}: value must be a number`);
  }
  if (step.match !== undefined && step.match !== 'all' && step.match !== 'any') out.push('match must be "all" or "any"');
  for (const key of ['timeout', 'hold']) {
    if (step[key] !== undefined && (!num(step[key]) || step[key] < 0)) out.push(`${key} must be a number of seconds >= 0`);
  }
  if (step.blocking !== undefined && typeof step.blocking !== 'boolean') out.push('blocking must be true or false');
  const onFail = step.onFail ?? 'abort';
  if (!GATE_FAIL_ACTIONS.some((a) => a.value === onFail)) {
    out.push(`onFail must be one of ${GATE_FAIL_ACTIONS.map((a) => a.value).join(', ')}`);
  }
  if (onFail === 'setValves') {
    const valves = new Set((config.valves || []).map((v) => v.id));
    const loops = bangbangLoops(config);
    const list = step.failValves;
    if (!Array.isArray(list) || !list.length) out.push('onFail "setValves" needs at least one valve or bang-bang controller in failValves');
    const seen = new Set();
    const listed = Array.isArray(list) ? list : [];
    for (const [k, fv] of listed.entries()) {
      const at = `failValves ${k + 1}`;
      if (fv?.bangbang !== undefined) {
        // { bangbang: id, enabled: bool } -- turn a regulating loop on or off.
        const loop = loops.find((l) => l.id === fv.bangbang);
        if (!loop) out.push(`${at}: "${fv.bangbang}" is not a bang-bang controller`);
        else if (seen.has(`bb:${fv.bangbang}`)) out.push(`${at}: ${fv.bangbang} is listed twice`);
        seen.add(`bb:${fv.bangbang}`);
        if (typeof fv.enabled !== 'boolean') out.push(`${at}: enabled must be true or false`);
        // Enabling a loop hands it its valve; setting that valve too would
        // have two things decide its position.
        if (loop && fv.enabled === true && listed.some((x) => x?.valve === loop.valve)) {
          out.push(`${at}: enabling ${fv.bangbang} hands it ${loop.valve}, which is also being set`);
        }
        continue;
      }
      if (!valves.has(fv?.valve)) out.push(`${at}: "${fv?.valve}" is not a defined valve`);
      else if (seen.has(fv.valve)) out.push(`${at}: ${fv.valve} is listed twice`);
      seen.add(fv?.valve);
      if (fv?.state !== 'open' && fv?.state !== 'closed') out.push(`${at}: state must be "open" or "closed"`);
    }
    if (step.failStop !== undefined && typeof step.failStop !== 'boolean') out.push('failStop must be true or false');
  }
  if (onFail === 'sequence') {
    if (!step.failSequence) out.push('onFail "sequence" needs a failSequence');
    else if (!seqs.some((s) => s.id === step.failSequence)) out.push(`failSequence "${step.failSequence}" is not a defined sequence`);
    else if (step.failSequence === seq?.id) out.push('failSequence cannot be the sequence the gate is in');
    else {
      const loop = failLoop(step.failSequence, seq?.id, seqs);
      if (loop) out.push(`failSequence leads back here: ${loop.join(' → ')}`);
    }
  }
  return out;
}

/**
 * The gate a step is checked against, or null: a gate step is its own; a
 * valve step may carry one as `step.gate`, and then only actuates once it
 * passes.
 */
export function gateOf(step) {
  if (step?.action === 'gate') return step;
  return step?.gate && typeof step.gate === 'object' ? step.gate : null;
}

/** A fresh gate for the editor. No threshold is guessed: the operator types it. */
export function newGate(config) {
  return { conditions: [{ sensor: config.sensors?.[0]?.id, op: '>', value: 0 }], onFail: 'abort' };
}

/**
 * Every bang-bang loop "Set valve states" can turn on or off: the board's
 * controllers (`bangbang[]`), plus the ground-station GN2 press loop as
 * `gn2Press` where the stand has one.
 */
export function bangbangLoops(config) {
  const out = (config.bangbang || []).map((c) => ({ id: c.id, name: c.name || c.id, valve: c.valve, kind: 'board' }));
  if (config.gn2Press) {
    out.push({ id: 'gn2Press', name: config.gn2Press.name || 'GN2 press loop', valve: config.gn2Press.valve, kind: 'gn2' });
  }
  return out;
}

/** What a failed gate does, in a few words. */
export function gateFailText(step, config = {}) {
  const onFail = step.onFail ?? 'abort';
  if (onFail === 'sequence') {
    const target = (config.autosequences || []).find((s) => s.id === step.failSequence);
    return `run ${target?.name || step.failSequence || '?'}`;
  }
  if (onFail === 'setValves') {
    const list = (step.failValves || []).map((fv) => (fv.bangbang !== undefined
      ? `${fv.bangbang} ${fv.enabled ? 'ON' : 'OFF'}`
      : `${fv.valve} ${String(fv.state).toUpperCase()}`)).join(', ');
    return `set ${list || 'no valves'}${step.failStop === false ? ' and continue' : ' and stop'}`;
  }
  return GATE_FAIL_ACTIONS.find((a) => a.value === onFail)?.label.toLowerCase() || onFail;
}

/** A chain of fail sequences from `from` that returns to `home`, or null. */
function failLoop(from, home, seqs) {
  const seen = new Set();
  const walk = (id, path) => {
    if (id === home) return path;
    if (seen.has(id)) return null;
    seen.add(id);
    const s = seqs.find((x) => x.id === id);
    for (const step of s?.steps || []) {
      const spec = gateOf(step);
      if (spec?.onFail === 'sequence' && spec.failSequence) {
        const found = walk(spec.failSequence, [...path, spec.failSequence]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(from, [home, from]);
}

export const round3 = (n) => Math.round(n * 1000) / 1000;
export const stepT = (s) => Number(s?.t) || 0;

/** "T+1.50" — the one way a sequence time is written on this page. */
export function fmtT(t, decimals = 2) {
  return `T+${stepT({ t }).toFixed(decimals)}`;
}

/** "+0.40" / "−0.10" — a gap between two times. */
export function fmtDelta(dt, decimals = 2) {
  const v = round3(dt);
  return `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(decimals)}`;
}

/** Steps in firing order: by time, ties kept in array order (as the server sorts). */
export function ordered(seq) {
  return (seq.steps || []).map((s, i) => [s, i])
    .sort((a, b) => stepT(a[0]) - stepT(b[0]) || a[1] - b[1])
    .map(([s]) => s);
}

export function duration(seq) {
  const steps = seq.steps || [];
  return steps.length ? Math.max(...steps.map(stepT)) : 0;
}

/** Time of the first END or ABORT step. Nothing after it runs. */
export function stopTime(seq) {
  const stop = ordered(seq).find((s) => s.action === 'end' || s.action === 'abort');
  return stop ? stepT(stop) : null;
}

/** True when a step can never fire because an END/ABORT comes before it. */
export function isUnreachable(seq, step) {
  const steps = ordered(seq);
  const stopIdx = steps.findIndex((s) => s.action === 'end' || s.action === 'abort');
  return stopIdx >= 0 && steps.indexOf(step) > stopIdx;
}

export function isHazard(valve) {
  return Boolean(valve && (valve.type === 'igniter' || valve.momentary));
}

/**
 * The lanes, top to bottom: milestones, then every valve the sequence touches
 * in the order it first touches them (so the lanes read as the story of the
 * run), then the bang-bang controllers. `extra` holds lanes the operator has
 * added but not yet put a step on. `order` is the lane order to keep (lane
 * keys, milestones excluded); it defaults to the one saved with the sequence.
 * Without one the lanes follow first touch, which moves a lane whenever a
 * step is dragged past another actuator's -- so the editor passes the order
 * it showed last time and only new lanes are placed.
 */
export function buildLanes(seq, config, extra = [], order = seq.lanes) {
  const lanes = [{ key: 'events', kind: 'events' }];
  const seen = new Set();
  const valves = config.valves || [];
  const ctrls = config.bangbang || [];

  const addValve = (id) => {
    const key = `valve:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    lanes.push({ key, kind: 'valve', id, valve: valves.find((v) => v.id === id) || null });
  };
  const addCtrl = (id) => {
    const key = `bb:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    lanes.push({ key, kind: 'bb', id, ctrl: ctrls.find((c) => c.id === id) || null });
  };

  const valveKeys = [];
  const ctrlKeys = [];
  for (const s of ordered(seq)) {
    if (s.action === 'valve' && s.target) valveKeys.push(s.target);
    if (s.action === 'bangbang') {
      if (s.target === '*') ctrlKeys.push(...ctrls.map((c) => c.id));
      else if (s.target) ctrlKeys.push(s.target);
    }
  }
  for (const key of extra) {
    const [kind, id] = key.split(':');
    if (kind === 'valve') valveKeys.push(id);
    else if (kind === 'bb') ctrlKeys.push(id);
  }
  valveKeys.forEach(addValve);
  ctrlKeys.forEach(addCtrl);
  return applyLaneOrder(lanes, order);
}

/**
 * Put lanes in the order the operator dragged them into (`seq.lanes`, a
 * list of lane keys saved with the sequence). Milestones stay on top. Lanes
 * the saved order does not mention -- an actuator a later edit brought in --
 * keep their natural place after the lane that precedes them naturally, so a
 * new valve appears near its neighbours rather than always at the bottom.
 */
export function applyLaneOrder(lanes, order) {
  if (!Array.isArray(order) || !order.length) return lanes;
  const [events, ...rest] = lanes;
  const byKey = new Map(rest.map((l) => [l.key, l]));
  const out = order.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
  const placed = new Set(out.map((l) => l.key));
  rest.forEach((lane, i) => {
    if (placed.has(lane.key)) return;
    const prev = rest.slice(0, i).reverse().find((l) => placed.has(l.key));
    const at = prev ? out.indexOf(prev) + 1 : 0;
    out.splice(at, 0, lane);
    placed.add(lane.key);
  });
  return [events, ...out];
}

/** Move the lane at `from` to `to` (indices among the movable lanes). */
export function moveLane(keys, from, to) {
  const out = [...keys];
  const [k] = out.splice(from, 1);
  out.splice(to, 0, k);
  return out;
}

/**
 * Where a lane being dragged lands, and how far every other lane has to
 * step aside while it is held there. All movable lanes are one height, `h`.
 * Returns { dy, target, shifts } with `dy` clamped to the lane stack.
 */
export function laneDrag(count, from, rawDy, h) {
  const dy = Math.max(-from * h, Math.min((count - 1 - from) * h, rawDy));
  const target = Math.max(0, Math.min(count - 1, Math.round((from * h + dy) / h)));
  const shifts = Array.from({ length: count }, (_, i) => {
    if (i === from) return 0;
    if (from < target && i > from && i <= target) return -h;
    if (target < from && i >= target && i < from) return h;
    return 0;
  });
  return { dy, target, shifts };
}

/** Which lanes a step is drawn on. A `*` bang-bang step sits on every controller. */
export function laneKeysFor(step, config) {
  if (step.action === 'valve') return [`valve:${step.target}`];
  if (step.action === 'bangbang') {
    return step.target === '*'
      ? (config.bangbang || []).map((c) => `bb:${c.id}`)
      : [`bb:${step.target}`];
  }
  return ['events'];
}

/**
 * Walk the sequence and record every state change of every actuator.
 *
 * Returns { valves: Map<id, Segment[]>, ctrls: Map<id, Segment[]>, redundant: Set<step> }
 * where a Segment is { from, to, state, step, implicit, cause }. The first
 * segment of each lane starts at the first change: before that the actuator
 * is wherever the operator left it, and the timeline says so instead of
 * guessing.
 */
export function simulate(seq, config) {
  const valves = config.valves || [];
  const ctrls = config.bangbang || [];
  const end = stopTime(seq);
  const horizon = Math.max(duration(seq), 0);

  const vSegs = new Map();
  const cSegs = new Map();
  const vState = new Map();
  const cState = new Map();
  const redundant = new Set();
  const pulses = new Map(); // valve id -> close time of a momentary pulse

  const push = (map, id, seg) => {
    if (!map.has(id)) map.set(id, []);
    const list = map.get(id);
    const last = list[list.length - 1];
    if (last && last.to === null) last.to = seg.from;
    list.push({ ...seg, to: null });
  };

  const setValve = (valve, state, t, step, implicit, cause) => {
    pulses.delete(valve.id);
    if (vState.get(valve.id) === state && !implicit) redundant.add(step);
    if (vState.get(valve.id) === state) return;
    vState.set(valve.id, state);
    push(vSegs, valve.id, { from: t, state, step, implicit, cause });
    if (state === 'open' && valve.momentary) {
      pulses.set(valve.id, round3(t + (Number(valve.momentaryMs) || 1000) / 1000));
    }
  };

  // Momentary pulses end on their own; replay any that end before `t`.
  const expirePulses = (t) => {
    for (const [id, at] of [...pulses].sort((a, b) => a[1] - b[1])) {
      if (at > t) continue;
      const valve = valves.find((v) => v.id === id);
      pulses.delete(id);
      if (valve) setValve(valve, valve.safeState || 'closed', at, null, true, 'pulse');
    }
  };

  for (const step of ordered(seq)) {
    const t = stepT(step);
    if (end !== null && t > end) break;
    expirePulses(t);

    if (step.action === 'valve') {
      const valve = valves.find((v) => v.id === step.target);
      if (valve && (step.state === 'open' || step.state === 'closed')) {
        setValve(valve, step.state, t, step, false, 'step');
      }
    } else if (step.action === 'safeAll' || step.action === 'abortStates') {
      const key = step.action === 'safeAll' ? 'safeState' : 'abortState';
      for (const valve of valves) {
        // Only lanes already on the timeline change visibly; a valve the
        // sequence never names is still driven, which the milestone says.
        if (vState.has(valve.id)) setValve(valve, valve[key] || 'closed', t, step, true, step.action);
      }
    } else if (step.action === 'bangbang') {
      const targets = step.target === '*' ? ctrls : ctrls.filter((c) => c.id === step.target);
      for (const ctrl of targets) {
        const prev = cState.get(ctrl.id) || { enabled: undefined };
        const next = { ...prev };
        for (const k of ['enabled', 'setpoint', 'deadband', 'maxOpenMs', 'minIntervalMs']) {
          if (step[k] !== undefined) next[k] = step[k];
        }
        cState.set(ctrl.id, next);
        push(cSegs, ctrl.id, { from: t, state: next, step, implicit: false, cause: 'step' });
      }
    }
    if (step.action === 'end' || step.action === 'abort') break;
  }
  expirePulses(end ?? Infinity);

  const close = (map) => {
    for (const list of map.values()) {
      const last = list[list.length - 1];
      if (last && last.to === null) last.to = Math.max(end ?? horizon, last.from);
    }
  };
  close(vSegs);
  close(cSegs);
  return { valves: vSegs, ctrls: cSegs, redundant, end };
}

/** The state of every lane at time `t` — what the gutter shows under the cursor. */
export function stateAt(sim, laneKey, t) {
  const [kind, id] = laneKey.split(':');
  const list = (kind === 'valve' ? sim.valves : sim.ctrls).get(id) || [];
  let current = null;
  for (const seg of list) {
    if (seg.from <= t + 1e-9) current = seg;
    else break;
  }
  return current;
}

/**
 * Problems worth showing beside a step. Not validation — the server does
 * that on save — but the mistakes that validate fine and still surprise
 * someone at T+0.
 */
export function lint(seq, config) {
  const out = new Map();
  const add = (step, msg) => {
    if (!out.has(step)) out.set(step, []);
    out.get(step).push(msg);
  };
  const sim = simulate(seq, config);
  const valves = config.valves || [];
  const ctrls = config.bangbang || [];

  for (const step of seq.steps || []) {
    if (isUnreachable(seq, step)) add(step, 'Never runs: an END or ABORT step comes first');
    if (sim.redundant.has(step)) add(step, `${step.target} is already ${String(step.state).toUpperCase()} here`);
    if (step.action === 'valve') {
      const valve = valves.find((v) => v.id === step.target);
      if (!valve) add(step, `No valve "${step.target}"`);
      else if (valve.requiresArm && seq.requiresArm === false) {
        add(step, `${valve.id} needs the stand ARMED, but this sequence does not require ARM`);
      }
    }
    if (step.action === 'bangbang') {
      if (step.target !== '*' && !ctrls.some((c) => c.id === step.target)) add(step, `No controller "${step.target}"`);
      const keys = ['enabled', 'setpoint', 'deadband', 'maxOpenMs', 'minIntervalMs', 'vent', 'abort'];
      if (!keys.some((k) => step[k] !== undefined)) add(step, 'Changes nothing');
    }
    const gate = gateOf(step);
    if (gate) {
      for (const problem of gateProblems(gate, seq, config)) add(step, `Gate ${problem}`);
    }
    if (seq.usePandaAutosequencer && step.action !== 'valve' && step.action !== 'log') {
      add(step, 'Panda runs valve steps only');
    } else if (seq.usePandaAutosequencer && step.gate) {
      add(step, 'Panda cannot check a gate: it would actuate regardless');
    }
  }
  return out;
}

// -------------------------------------------------------------- keybinds --

/**
 * Keys a sequence can be bound to: letters, digits and the numpad's digits,
 * stored as a KeyboardEvent.code ("KeyP", "Digit7", "Numpad3"). `code`, not
 * `key`, because the operator holds SHIFT to run a sequence and SHIFT+7 types
 * "&" on a US layout -- the physical key is the same either way.
 */
const KEY_RE = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9])$/;

/** Keys the station already uses, and for what. Esc is ABORT everywhere. */
export const KEY_RESERVED = {
  Escape: 'ABORT',
  KeyT: 'the timer',
  KeyC: 'the COPV Press Tool',
  KeyG: 'the GOX purge controller',
  KeyL: 'the P&ID view lock',
  KeyK: 'the P&ID legend',
  Digit0: 'the P&ID zoom reset',
  Numpad0: 'the P&ID zoom reset',
};

/** "KeyP" -> "P", "Digit7" -> "7", "Numpad3" -> "Num 3". */
export function keyLabel(code) {
  if (typeof code !== 'string') return '';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/**
 * Why `code` cannot be a sequence's keybind, or null if it can. `others` are
 * the other sequences it must not collide with.
 */
export function keyProblem(code, others = []) {
  if (typeof code !== 'string' || !KEY_RE.test(code)) {
    return `"${code}" is not a bindable key (use a letter, a digit or a numpad digit, as a KeyboardEvent.code such as "KeyP")`;
  }
  if (KEY_RESERVED[code]) return `${keyLabel(code)} is reserved for ${KEY_RESERVED[code]}`;
  const clash = others.find((s) => s.keybind === code);
  if (clash) return `${keyLabel(code)} already runs "${clash.name || clash.id}"`;
  return null;
}

// ------------------------------------------------------------- time axis --

/** A round tick spacing giving roughly `target` ticks across `range` seconds. */
export function niceStep(range, target = 8) {
  if (!(range > 0)) return 1;
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

/**
 * Snap a dragged time. Other steps' times win within `magnet` seconds (so
 * steps line up exactly with each other), then the grid. `grid` 0 = free.
 */
export function snapTime(t, { grid = 0, magnets = [], magnet = 0 } = {}) {
  let best = null;
  for (const m of magnets) {
    const d = Math.abs(m - t);
    if (d <= magnet && (best === null || d < Math.abs(best - t))) best = m;
  }
  if (best !== null) return round3(Math.max(0, best));
  if (grid > 0) return round3(Math.max(0, Math.round(t / grid) * grid));
  return round3(Math.max(0, t));
}

/**
 * Move `moving` steps by `delta` seconds from their `orig` times. With
 * `ripple`, every other step later than the earliest moving one is carried
 * along too, so the gaps after an edit are kept — what "Δ from previous"
 * editing used to mean. Never moves a step before T+0: the delta is clamped
 * so the earliest moving step lands at 0 at worst.
 *
 * `orig` is a Map<step, t> captured when the drag began.
 */
export function shiftSteps(steps, orig, moving, delta, ripple = false) {
  const movingSet = new Set(moving);
  const anchor = Math.min(...[...movingSet].map((s) => orig.get(s)));
  const affected = new Set(movingSet);
  if (ripple) {
    for (const s of steps) if (orig.get(s) > anchor) affected.add(s);
  }
  const low = Math.min(...[...affected].map((s) => orig.get(s)));
  const d = Math.max(delta, -low);
  for (const s of steps) {
    s.t = affected.has(s) ? round3(orig.get(s) + d) : orig.get(s);
  }
  return d;
}

/** Stable sort in place, by time, as the server does on load. */
export function sortSteps(seq) {
  const order = new Map((seq.steps || []).map((s, i) => [s, i]));
  seq.steps?.sort((a, b) => stepT(a) - stepT(b) || order.get(a) - order.get(b));
}

// ---------------------------------------------------------- description --

export function valveStateLabel(valve, state) {
  if (state === 'open') return valve?.openLabel || 'OPEN';
  if (state === 'closed') return valve?.closedLabel || 'CLOSED';
  return String(state || '?').toUpperCase();
}

/** The settings a bang-bang step changes, as short tokens: ['ON', 'SP 870', …]. */
export function bbTokens(step) {
  const bits = [];
  if (step.enabled !== undefined) bits.push(step.enabled ? 'ON' : 'OFF');
  if (step.setpoint !== undefined) bits.push(`SP ${step.setpoint}`);
  if (step.deadband !== undefined) bits.push(`±${step.deadband}`);
  if (step.maxOpenMs !== undefined) bits.push(`MAX ${step.maxOpenMs}ms`);
  if (step.minIntervalMs !== undefined) bits.push(`DWELL ${step.minIntervalMs}ms`);
  if (step.vent !== undefined) bits.push(step.vent ? 'VENT OPEN' : 'VENT SHUT');
  if (step.abort) bits.push('SIDE ABORT');
  return bits;
}

/** One line, plain text: what the step does. */
export function describe(step, config) {
  switch (step.action) {
    case 'valve': {
      const valve = (config.valves || []).find((v) => v.id === step.target);
      const base = `${step.target} → ${valveStateLabel(valve, step.state)}`;
      return step.gate ? `${base} IF ${gateLabel(step.gate)}, else ${gateFailText(step.gate, config)}` : base;
    }
    case 'bangbang':
      return `${step.target === '*' ? 'All controllers' : step.target}: ${bbTokens(step).join(' · ') || 'no change'}`;
    case 'log': return `“${step.message || ''}”`;
    case 'abort': return `ABORT${step.message ? `: ${step.message}` : ''}`;
    case 'gate': return `GATE ${gateLabel(step)} → else ${gateFailText(step, config)}`;
    default: return STEP_ACTIONS.find((a) => a.value === step.action)?.label || step.action;
  }
}
