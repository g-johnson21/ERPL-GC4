/** panda-firmware-main/SequenceHandler: one CSV packet, delays AFTER actions.
 * RX_BUF_SIZE=256, NUM_MAX_COMMANDS=32, %1x%1u.%5u. Channel 0 waits
 * without touching an output (update() only actuates channels 1..12).
 */
export function encodeSequence(sequence, valves) {
  if (!Array.isArray(sequence.steps) || !sequence.steps.length) {
    throw new Error('Panda sequences need at least one valve step');
  }
  const steps = [...sequence.steps].sort((a, b) => a.t - b.t);
  const items = steps.map((step, index) => {
    if (step.action !== 'valve') throw new Error(`Step ${index + 1}: Panda supports valve steps only (${step.action} is unsupported)`);
    if (!Number.isFinite(step.t) || step.t < 0) throw new Error(`Step ${index + 1}: invalid time`);
    const valve = valves.find((v) => v.id === step.target);
    if (!valve) throw new Error(`Unknown valve "${step.target}"`);
    const channel = Number(valve.channel);
    if (!Number.isInteger(channel) || channel < 1 || channel > 12) throw new Error(`${valve.id}: Panda channel must be 1–12`);
    if (valve.momentary) throw new Error(`${valve.id}: Panda firmware cannot enforce the momentary timeout; use the GC sequencer`);
    if (!['open', 'closed'].includes(step.state)) throw new Error(`${valve.id}: invalid valve state`);
    return { step, at: Math.round(step.t * 1000), channel, on: valve.normallyOpen ? step.state === 'closed' : step.state === 'open' };
  });
  if (items[0].at > 0) items.unshift({ at: 0, channel: 0, on: false, step: null });
  if (items.length > 32) throw new Error('Panda supports at most 32 commands');
  const command = items.map((item, i) => {
    const delay = i + 1 < items.length ? items[i + 1].at - item.at : 0;
    if (delay > 99999) throw new Error('Panda delays cannot exceed 99.999 seconds between steps');
    return `s${item.channel.toString(16).toUpperCase()}${item.on ? 1 : 0}.${String(delay).padStart(5, '0')}`;
  }).join(',');
  if (command.length > 255) throw new Error('Panda sequence exceeds the 255-byte firmware packet limit (including any initial wait)');
  return { command, items, steps };
}
