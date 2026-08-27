/**
 * bb-firmware.js — an emulation of the PANDA board's bang-bang regulator.
 *
 * WHY THIS EXISTS
 *   The regulator runs on the board, so the ground station has no loop to
 *   test. Without a stand-in, every line of the §5 protocol — the command
 *   grammar, the heartbeat, the CFG_PUSH echo, the enable handshake — would be
 *   untestable until someone is standing at the pad with the hardware. This
 *   emulation lets the simulator answer in the board's own words, so what runs
 *   in `npm run sim` is the same server code path that runs on the stand.
 *
 *   It is a stand-in for the PROTOCOL, not a model of the firmware. The
 *   control law here is a plain hysteresis band with a dwell timer, which is
 *   what §5 describes; the real firmware's mass-flow scheduling and its exact
 *   abort behaviour are not visible from the host, and the places where this
 *   file had to guess are marked GUESS below.
 *
 * STATE MACHINE (per side, independent)
 *   OFF  press closed, loop idle. `b<side>1` -> SUS
 *   SUS  regulating: press opens below (sp - db/2), closes above (sp + db/2)
 *   AV   auto-vent: pressure exceeded ventTrigger with ventAuto on
 *   ABT  latched abort. Nothing in the protocol clears it (§5.4)
 */
import {
  encodeHeartbeat,
  encodeCfgPush,
  parseCommand,
} from './bb-protocol.js';

const SIDES = ['l', 'f'];

/** How often the board narrates its state, even when nothing has changed. */
const HEARTBEAT_MS = 200;

/**
 * How far below the vent trigger the pressure must fall before auto-vent
 * releases back to SUS.
 *
 * GUESS. The protocol carries a vent trigger but no vent release, and a bare
 * threshold with no hysteresis chatters the vent solenoid at exactly the
 * pressure an operator is most likely to be sitting at. 2% of the trigger is
 * a plausible firmware choice; confirm it before reading anything into the
 * simulator's vent cycling.
 */
const VENT_RELEASE_FRACTION = 0.98;

export class BangBangFirmware {
  constructor(options = {}) {
    this.onLine = options.onLine || (() => {});
    this.heartbeatMs = Number(options.heartbeatMs ?? HEARTBEAT_MS);
    this.bootedAt = options.now ?? Date.now();
    // One clock. `update()` advances it and `command()` defaults to it, so a
    // command and the tick that follows cannot disagree about what time it is
    // — a dwell timer comparing two different clocks silently refuses to open
    // a valve, or opens one it should have held.
    this.clock = this.bootedAt;
    this.sides = {};
    for (const side of SIDES) this.sides[side] = freshSide();
  }

  /**
   * Offer one host->board line to the regulator.
   *
   * Returns true if this was a bang-bang command and was consumed. A false
   * return means "not mine" — the caller goes on to try solenoid commands,
   * arm, and the rest of the board's vocabulary.
   */
  command(line, now = this.clock) {
    const cmd = parseCommand(line);
    if (!cmd) return false;

    const side = cmd.side.toLowerCase();
    const st = this.sides[side];

    switch (cmd.kind) {
      case 'config':
        if (!(cmd.deadbandFull > 0)) {
          this.emit(`BB_ERROR: ${cmd.side} deadband must be > 0`);
          return true;
        }
        st.cfg.setpoint = cmd.setpoint;
        st.cfg.deadbandFull = cmd.deadbandFull;
        st.cfg.waitMs = cmd.waitMs;
        st.cfg.maxOpenMs = cmd.maxOpenMs;
        this.echoConfig(side, now);
        return true;

      case 'vent':
        st.cfg.ventTrigger = cmd.trigger;
        st.cfg.ventAuto = cmd.auto;
        this.echoConfig(side, now);
        return true;

      case 'mdot':
        st.cfg.mdotTarget = cmd.target;
        st.cfg.spMin = cmd.spMin;
        st.cfg.spMax = cmd.spMax;
        st.cfg.mdotGain = cmd.gain;
        st.cfg.rho = cmd.rho;          // stored, never echoed — see CFG_PUSH_KEYS
        st.cfg.mdotOn = cmd.enabled;
        this.echoConfig(side, now);
        return true;

      case 'enable':
        // An aborted side is latched: it refuses to re-enter SUS. This is the
        // behaviour §5.4 describes ("nothing in the host code clears it"), and
        // the rejection is what tells an operator the latch is still set.
        if (cmd.on && st.state === 'ABT') {
          this.emit(`BB_ERROR: ${cmd.side} is in ABORT — cannot enable`);
          return true;
        }
        if (cmd.on) {
          this.transition(side, 'SUS', now);
        } else {
          st.press = false;
          this.transition(side, 'OFF', now);
        }
        return true;

      case 'manualVent':
        // Independent of ventAuto, and permitted in every state including
        // ABT: opening a vent always makes a pressurised tank safer.
        st.manualVent = cmd.open;
        this.beat(side, now, true);
        return true;

      case 'abort':
        st.press = false;
        this.transition(side, 'ABT', now);
        return true;

      default:
        return false;
    }
  }

  /**
   * Run the loop. `pressures` is `{l, f}` in psi — the board's OWN PT
   * channels, which is the whole point: the ground station's DAQ reading of
   * the same tank is a different sensor and may not agree.
   */
  update(pressures = {}, now = Date.now()) {
    this.clock = now;
    for (const side of SIDES) {
      const st = this.sides[side];
      const p = Number(pressures[side]);
      if (Number.isFinite(p)) st.pressure = p;

      switch (st.state) {
        case 'SUS':
          this.sustain(side, now);
          break;
        case 'AV':
          st.press = false;
          if (st.pressure < st.cfg.ventTrigger * VENT_RELEASE_FRACTION) {
            this.transition(side, 'SUS', now);
          }
          break;
        case 'OFF':
        case 'ABT':
        default:
          st.press = false;
          break;
      }

      // Auto-vent pre-empts regulation from any live state.
      if (st.cfg.ventAuto && st.state === 'SUS' && st.pressure > st.cfg.ventTrigger) {
        st.press = false;
        this.transition(side, 'AV', now);
      }

      if (now - st.lastBeatAt >= this.heartbeatMs) this.beat(side, now);
    }
  }

  /** The hysteresis band, plus the dwell and pulse-length timers. */
  sustain(side, now) {
    const st = this.sides[side];
    const half = st.cfg.deadbandFull / 2;
    const lo = st.cfg.setpoint - half;
    const hi = st.cfg.setpoint + half;

    let want = st.press;
    if (st.pressure < lo) want = true;
    else if (st.pressure > hi) want = false;

    // Pulse limit: cut a continuous open at maxOpenMs. The loop keeps
    // running; the dwell timer governs when it may reopen.
    if (want && st.press && st.cfg.maxOpenMs > 0 && st.openedAt != null &&
        now - st.openedAt >= st.cfg.maxOpenMs) {
      want = false;
    }

    // Anti-chatter dwell. It may delay an OPEN but never a CLOSE — a
    // regulator that cannot stop pressurising on demand is not a safety
    // device, it is the hazard.
    if (want && !st.press && st.cfg.waitMs > 0 && st.switchedAt != null &&
        now - st.switchedAt < st.cfg.waitMs) {
      want = false;
    }

    if (want !== st.press) {
      st.press = want;
      st.switchedAt = now;
      st.openedAt = want ? now : null;
      this.beat(side, now, true);
    }
  }

  transition(side, next, now) {
    const st = this.sides[side];
    if (st.state === next) return;
    const prev = st.state;
    st.state = next;
    // `switchedAt` times VALVE transitions, not state transitions, and the
    // dwell is measured from it. Stamping it here would make entering SUS owe
    // a full wait_ms before the first actuation — so a 1 s dwell would leave a
    // tank unpressurised for a second after the operator enabled the loop,
    // for no reason anyone could see from the outside.
    st.switchedAt = null;
    if (next !== 'SUS') st.openedAt = null;
    this.emit(`EVT:${this.uptime(now)}:BB_STATE:${side}:${prev}->${next}`);
    this.beat(side, now, true);
  }

  /**
   * The board's `forceSafe()`, reached by the global disarm `r`. Drops both
   * sides to OFF with everything closed (§5.4).
   */
  forceSafe(now = Date.now()) {
    this.clock = now;
    for (const side of SIDES) {
      const st = this.sides[side];
      st.press = false;
      st.manualVent = false;
      if (st.state !== 'OFF') this.transition(side, 'OFF', now);
      else this.beat(side, now, true);
    }
  }

  /**
   * Is this side's vent solenoid energised?
   *
   * DERIVED, never stored. Storing it meant a state change beat out a
   * heartbeat before the stored copy caught up, so the board announced
   * "auto-venting, vent closed" for one beat — a frame in which the UI shows
   * a tank venting through a shut valve.
   */
  ventOpen(side) {
    const st = this.sides[side];
    return st.manualVent || st.state === 'AV';
  }

  /** Current solenoid demand, for the physics model to act on. */
  outputs() {
    const out = {};
    for (const side of SIDES) {
      out[side] = { press: this.sides[side].press, vent: this.ventOpen(side) };
    }
    return out;
  }

  // --------------------------------------------------------------- output ---

  beat(side, now, force = false) {
    const st = this.sides[side];
    if (!force && now - st.lastBeatAt < this.heartbeatMs) return;
    st.lastBeatAt = now;
    this.emit(encodeHeartbeat(side, {
      state: st.state,
      press: st.press,
      vent: this.ventOpen(side),
      pressure: st.pressure,
    }));
  }

  /**
   * The board confirming what it actually stored. Everything it holds is
   * echoed, not just the fields the last command carried — that is what makes
   * the echo usable as the authority on the board's configuration.
   */
  echoConfig(side, now) {
    const c = this.sides[side].cfg;
    this.emit(encodeCfgPush(this.uptime(now), side, {
      sp: c.setpoint.toFixed(1),
      db: c.deadbandFull.toFixed(1),
      wait: Math.round(c.waitMs),
      maxOpen: Math.round(c.maxOpenMs),
      ventTrig: c.ventTrigger.toFixed(1),
      ventAuto: c.ventAuto,
      mdot: c.mdotTarget.toFixed(3),
      spMin: c.spMin.toFixed(3),
      spMax: c.spMax.toFixed(3),
      gain: c.mdotGain.toFixed(5),
      mdotOn: c.mdotOn,
    }));
  }

  uptime(now) { return Math.max(0, Math.round(now - this.bootedAt)); }

  emit(line) { this.onLine(line); }
}

function freshSide() {
  return {
    state: 'OFF',
    press: false,
    manualVent: false,
    pressure: 0,
    switchedAt: null,
    openedAt: null,
    lastBeatAt: -Infinity,
    cfg: {
      setpoint: 0,
      deadbandFull: 0,
      waitMs: 0,
      maxOpenMs: 0,
      ventTrigger: 0,
      ventAuto: false,
      mdotTarget: 0,
      spMin: 0,
      spMax: 0,
      mdotGain: 0,
      rho: 0,
      mdotOn: false,
    },
  };
}
