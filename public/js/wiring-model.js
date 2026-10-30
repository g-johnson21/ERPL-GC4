/* wiring-model.js — which hardware channel each instrument and actuator is on.
 *
 * Pure (no DOM): the Config page's channel editor makes these edits, and the
 * server checks the result with the same rules before it writes anything.
 *
 * Wiring is split across two files, and every edit here keeps them in step:
 *
 *   stand.json     sensor.channel  a flat number, unique per stand, used for
 *                                  display ("ch 3") and by the simulator
 *                  valve.channel   the PANDA DC channel, 1-16. This one IS the
 *                                  wiring: the PANDA driver commands S<nn>
 *                                  straight from it.
 *   hardware.json  nidaq.channelMap  "pt3" -> sensor id (card + index)
 *                  panda.channelMap  "bbpt0" -> sensor id
 *                  nidaq.cards.pt.channelMeta[i].maxPsi  the 4-20 mA span
 *                  panda.dcChannels[i].valve  which valve DC(i+1) current-senses
 *
 * A sensor is on at most one hardware channel. The PANDA's map overrides the
 * DAQ's for the same id, which is legal in the file but never what anyone
 * means from a form, so an edit here moves the sensor rather than doubling it.
 */

/** Hardware inputs the PANDA can report, beyond what its file declares. */
const PANDA_INPUTS = [
  { card: 'pt', label: 'PANDA PT', count: 16 },
  { card: 'bbpt', label: 'Board PT', count: 2, names: ['Board PT L (LOX)', 'Board PT F (Fuel)'] },
];

const CARD_LABELS = { pt: 'PT', lc: 'LC', tc: 'TC' };

/** Where a newly wired sensor's flat `channel` number starts, per input. */
const CHANNEL_BASE = {
  nidaq: { pt: 0, lc: 100, tc: 200 },
  panda: { pt: 300, bbpt: 320 },
};

/** The PANDA's solenoid drivers: S01-S16. */
export const DC_CHANNELS = 16;

/** Number of channels on an NI card, from either its `channels` or its modules. */
function cardCount(card) {
  if (Number.isInteger(card?.channels)) return card.channels;
  return (card?.modules || []).reduce((n, m) => n + (Number(m.channels) || 0), 0);
}

/**
 * Every input a sensor could be wired to, grouped by device.
 *
 *   [{ device: 'nidaq', label: 'NI-DAQ', inputs: [{ key: 'pt3', card: 'pt', index: 3, label: 'PT 3' }] }]
 */
export function inventory(hw) {
  const out = [];
  if (hw?.nidaq) {
    const inputs = [];
    for (const [card, spec] of Object.entries(hw.nidaq.cards || {})) {
      const n = cardCount(spec);
      for (let i = 0; i < n; i++) {
        inputs.push({ key: `${card}${i}`, card, index: i, label: `${CARD_LABELS[card] || card.toUpperCase()} ${i}` });
      }
    }
    out.push({ device: 'nidaq', label: 'NI-DAQ', inputs });
  }
  if (hw?.panda) {
    const inputs = [];
    for (const p of PANDA_INPUTS) {
      for (let i = 0; i < p.count; i++) {
        inputs.push({ key: `${p.card}${i}`, card: p.card, index: i, label: p.names?.[i] ?? `${p.label} ${i}` });
      }
    }
    out.push({ device: 'panda', label: 'PANDA', inputs });
  }
  return out;
}

/**
 * Which inputs can carry which kind of instrument. A thermocouple on a 4-20 mA
 * card reads nonsense, and a PT on a bridge card reads nothing, so the form
 * only offers inputs that suit the kind. Kinds not listed (flow, level, a
 * voltage) can come from any input: a flowmeter is as often 4-20 mA as not.
 */
const KIND_CARDS = {
  pressure: ['pt', 'bbpt'],
  temperature: ['tc'],
  force: ['lc'],
};

/** What a newly made sensor of each kind starts as: the stand's usual instrument of that kind. */
export const KIND_DEFAULTS = {
  pressure: { prefix: 'PT', units: 'psi', min: 0, max: 1000, decimals: 1 },
  temperature: { prefix: 'TC', units: '°F', min: -320, max: 200, decimals: 1 },
  force: { prefix: 'LC', units: 'lbf', min: -100, max: 2000, decimals: 1 },
  flow: { prefix: 'FM', units: 'gpm', min: 0, max: 100, decimals: 2 },
  level: { prefix: 'LV', units: 'in', min: 0, max: 100, decimals: 1 },
  voltage: { prefix: 'V', units: 'V', min: 0, max: 30, decimals: 2 },
  other: { prefix: 'S', units: '', min: 0, max: 100, decimals: 1 },
};

/** Thermocouple types the NI 9211 reader knows. */
export const TC_TYPES = ['K', 'J', 'T', 'E', 'N', 'R', 'S', 'B'];

/** Can an input carry this kind of sensor? */
export function suits(key, kind) {
  const cards = KIND_CARDS[kind];
  return !cards || cards.includes(parseKey(key)?.card);
}

/** `inventory()` narrowed to the inputs that suit a kind; devices with none are left out. */
export function inputsFor(devices, kind) {
  return devices
    .map((d) => ({ ...d, inputs: d.inputs.filter((i) => suits(i.key, kind)) }))
    .filter((d) => d.inputs.length);
}

/** The thermocouple type on a sensor's NI TC input, or null when it is not on one. */
export function tcType(hw, sensorId) {
  const src = sourceOf(hw, sensorId);
  if (src?.device !== 'nidaq' || parseKey(src.key)?.card !== 'tc') return null;
  return String(hw.nidaq.cards.tc.channelMeta?.[String(parseKey(src.key).index)]?.type ?? 'K').toUpperCase();
}

export function setTcType(hw, sensorId, type) {
  const src = sourceOf(hw, sensorId);
  if (src?.device !== 'nidaq' || parseKey(src.key)?.card !== 'tc') return;
  const meta = (hw.nidaq.cards.tc.channelMeta ??= {});
  const index = String(parseKey(src.key).index);
  meta[index] = { offset: 0, ...(meta[index] || {}), type };
}

/** "pt3" -> { card: 'pt', index: 3 }, or null. */
export function parseKey(key) {
  const m = /^([a-z]+?)(\d+)$/.exec(String(key));
  return m ? { card: m[1], index: Number(m[2]) } : null;
}

/** The input a sensor is wired to: { device, key } or null. PANDA wins, as in the driver. */
export function sourceOf(hw, sensorId) {
  for (const device of ['panda', 'nidaq']) {
    for (const [key, id] of Object.entries(hw?.[device]?.channelMap || {})) {
      if (id === sensorId) return { device, key };
    }
  }
  return null;
}

/** The sensor id on an input, or null. */
export function sensorOn(hw, device, key) {
  return hw?.[device]?.channelMap?.[key] ?? null;
}

/** Human label for an input: "NI-DAQ PT 3". */
export function sourceLabel(src) {
  if (!src) return 'Not wired';
  const p = parseKey(src.key);
  if (!p) return `${src.device} ${src.key}`;
  if (src.device === 'panda') {
    const def = PANDA_INPUTS.find((d) => d.card === p.card);
    return def?.names?.[p.index] ?? `${def?.label ?? `PANDA ${p.card.toUpperCase()}`} ${p.index}`;
  }
  return `NI ${CARD_LABELS[p.card] || p.card.toUpperCase()} ${p.index}`;
}

/** Is this input a 4-20 mA transducer on the NI PT card, whose span lives in hardware.json? */
export function hasNiSpan(src) {
  return src?.device === 'nidaq' && parseKey(src.key)?.card === 'pt';
}

/**
 * Wire a sensor to an input, or unwire it (`src` null).
 *
 * Anything already on that input is unwired — the form shows who it was so the
 * operator can rewire it. Returns the id that lost its input, or null.
 */
export function setSensorSource(cfg, hw, sensorId, src) {
  const sensor = cfg.sensors.find((s) => s.id === sensorId);
  if (!sensor) return null;

  for (const device of ['nidaq', 'panda']) {
    const map = hw?.[device]?.channelMap;
    if (!map) continue;
    for (const [key, id] of Object.entries(map)) if (id === sensorId) delete map[key];
  }
  if (!src) return null;

  const map = (hw[src.device].channelMap ??= {});
  const displaced = map[src.key] && map[src.key] !== sensorId ? map[src.key] : null;
  map[src.key] = sensorId;

  // The flat number follows the hardware, so "ch 3" on the Data page is the
  // input it is actually on. Kept if the derived one is taken.
  const p = parseKey(src.key);
  const base = CHANNEL_BASE[src.device]?.[p.card] ?? 400;
  sensor.channel = freeSensorChannel(cfg, sensorId, base + p.index);

  // A transducer carries its own span: moving it to another input moves its
  // range with it.
  if (hasNiSpan(src)) syncNiSpan(hw, sensor, src);
  return displaced;
}

/** `wanted` if no other sensor holds it, else the first free number from 1000. */
export function freeSensorChannel(cfg, sensorId, wanted) {
  const used = new Set(cfg.sensors.filter((s) => s.id !== sensorId).map((s) => s.channel));
  if (!used.has(wanted)) return wanted;
  let n = 1000;
  while (used.has(n)) n++;
  return n;
}

/**
 * Write a sensor's range into its NI PT channel's 4-20 mA span.
 *
 * The NI sidecar converts current to psi with `maxPsi`; the PANDA converts
 * with the sensor's own min/max. Without this, the "PT range" on the form
 * would be a display range on one device and a calibration on the other.
 */
export function syncNiSpan(hw, sensor, src = sourceOf(hw, sensor.id)) {
  if (!hasNiSpan(src) || !Number.isFinite(sensor.max)) return;
  const card = hw.nidaq.cards.pt;
  const meta = (card.channelMeta ??= {});
  const index = String(parseKey(src.key).index);
  meta[index] = { ...(meta[index] || { zeroMa: 4 }), maxPsi: sensor.max };
}

/** The NI span for a sensor, when it has one: { maxPsi, zeroMa } or null. */
export function niSpan(hw, sensorId) {
  const src = sourceOf(hw, sensorId);
  if (!hasNiSpan(src)) return null;
  return hw.nidaq.cards.pt.channelMeta?.[String(parseKey(src.key).index)] ?? null;
}

/**
 * Put a valve on a PANDA DC channel (1-16).
 *
 * Two valves on one channel would both move whenever either is commanded, and
 * the validator refuses it — so a valve already there trades places with this
 * one. Its current-sense entry follows it. Returns the id it traded with, or null.
 */
export function setValveChannel(cfg, hw, valveId, channel) {
  const valve = cfg.valves.find((v) => v.id === valveId);
  if (!valve) return null;
  const old = valve.channel;
  const other = cfg.valves.find((v) => v.id !== valveId && v.channel === channel);
  if (other) other.channel = old;
  valve.channel = channel;

  const dc = hw?.panda?.dcChannels;
  if (dc) {
    for (const entry of Object.values(dc)) {
      if (entry?.valve === valveId || (other && entry?.valve === other.id)) delete entry.valve;
    }
    const tie = (v) => {
      if (!Number.isInteger(v.channel) || v.channel < 1 || v.channel > DC_CHANNELS) return;
      const key = String(v.channel - 1);
      dc[key] ??= { id: `DC${v.channel}`, name: v.name };
      dc[key].valve = v.id;
    };
    tie(valve);
    if (other) tie(other);
  }
  return other ? other.id : null;
}

/** Give an instrument or actuator a new id everywhere the wiring names it. */
export function renameInWiring(hw, oldId, newId) {
  for (const device of ['nidaq', 'panda']) {
    const map = hw?.[device]?.channelMap;
    for (const key of Object.keys(map || {})) if (map[key] === oldId) map[key] = newId;
  }
  for (const entry of Object.values(hw?.panda?.dcChannels || {})) {
    if (entry?.valve === oldId) entry.valve = newId;
  }
  if (hw?.valveDevice?.[oldId] !== undefined) {
    hw.valveDevice[newId] = hw.valveDevice[oldId];
    delete hw.valveDevice[oldId];
  }
}

/** Forget an id the stand no longer has. */
export function removeFromWiring(hw, id) {
  for (const device of ['nidaq', 'panda']) {
    const map = hw?.[device]?.channelMap;
    for (const key of Object.keys(map || {})) if (map[key] === id) delete map[key];
  }
  for (const entry of Object.values(hw?.panda?.dcChannels || {})) {
    if (entry?.valve === id) delete entry.valve;
  }
  if (hw?.valveDevice) delete hw.valveDevice[id];
}

/**
 * Problems with a wiring file against the stand config it will drive.
 *
 * Every one of these is a stand that would read the wrong instrument into a
 * gauge or sense the wrong coil, so the save is refused rather than warned.
 */
export function validateWiring(hw, cfg) {
  const errors = [];
  if (!hw || typeof hw !== 'object') return ['hardware config is not an object'];
  const sensorIds = new Set((cfg?.sensors || []).map((s) => s.id));
  // A board transducer is not in `sensors`, but the PANDA map may surface it.
  for (const b of cfg?.bangbang || []) if (b.boardSensor?.id) sensorIds.add(b.boardSensor.id);
  const valves = new Map((cfg?.valves || []).map((v) => [v.id, v]));
  const valid = new Map(inventory(hw).map((d) => [d.device, new Set(d.inputs.map((i) => i.key))]));

  const seen = new Map();
  for (const device of ['nidaq', 'panda']) {
    const map = hw[device]?.channelMap;
    if (map == null) continue;
    if (typeof map !== 'object' || Array.isArray(map)) { errors.push(`${device}.channelMap must be an object`); continue; }
    for (const [key, id] of Object.entries(map)) {
      // The PANDA reports more than this editor offers (its own load cells);
      // anything it can parse is left alone rather than declared invalid.
      if (device === 'nidaq' && !valid.get(device)?.has(key)) {
        errors.push(`nidaq.channelMap: "${key}" is not an input on any configured card`);
      }
      if (!sensorIds.has(id)) errors.push(`${device}.channelMap: ${key} -> "${id}" is not a defined sensor`);
      const prev = seen.get(`${device}:${id}`);
      if (prev) errors.push(`${device}.channelMap: ${id} is on both ${prev} and ${key}`);
      seen.set(`${device}:${id}`, key);
    }
  }

  for (const [index, meta] of Object.entries(hw.nidaq?.cards?.pt?.channelMeta || {})) {
    if (meta?.maxPsi != null && !(Number(meta.maxPsi) > 0)) {
      errors.push(`nidaq PT ${index}: maxPsi must be a positive number`);
    }
  }

  for (const [index, entry] of Object.entries(hw.panda?.dcChannels || {})) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= DC_CHANNELS) {
      errors.push(`panda.dcChannels: "${index}" is not a DC position (0-${DC_CHANNELS - 1})`);
      continue;
    }
    if (!entry?.valve) continue;
    const valve = valves.get(entry.valve);
    if (!valve) errors.push(`panda.dcChannels[${index}]: "${entry.valve}" is not a defined valve`);
    else if (valve.channel !== i + 1) {
      errors.push(`panda.dcChannels[${index}] senses ${valve.id} as DC${i + 1}, but ${valve.id} is on DC${valve.channel}`);
    }
  }
  return errors;
}

/** Do two configs drive the actuators differently? (Channel, coil sense, routing.) */
export function valveWiringChanged(before, after) {
  const key = (cfg) => JSON.stringify((cfg?.valves || [])
    .map((v) => [v.id, v.channel, Boolean(v.normallyOpen)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  return key(before) !== key(after);
}
