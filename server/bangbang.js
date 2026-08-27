/**
 * bangbang.js — the ground station's half of the PANDA's bang-bang regulator.
 *
 * THE LOOP IS NOT HERE. It runs on the board, against the board's own PT
 * channels. This file pushes configuration, asks the board to start and stop,
 * mirrors what it reports back, and runs a few supervisory trips that can only
 * ever tell the board to stop. It never commands a valve.
 *
 * That split is the point (HANDOVER_COMMS.md §5.1): if the serial link, this
 * server, or the browser dies, the board keeps regulating with the last
 * configuration it accepted. A ground station that closed the loop itself
 * would drop the press valve on a disconnect — mid-fill, with a tank at
 * setpoint and nobody watching. It is also why §5.7's browser-side loop is
 * flagged as a hazard rather than a feature: two controllers on one solenoid,
 * reading two different transducers, with no arbitration between them.
 *
 * WHAT LIVES WHERE
 *
 *   Board (authoritative)          Host (this file)
 *   ---------------------          ----------------
 *   the hysteresis loop            what setpoint/band to use
 *   setpoint, deadband             requiresArm interlock
 *   wait_ms dwell                  maxOpenSeconds leak trip
 *   max_open_ms pulse limit        abortAbove threshold
 *   auto-vent trigger              display, logging, handshake
 *   the actual valve state
 *
 * The three host trips exist because the protocol has no equivalent for them.
 * They are SUPERVISORY: each one can send `b<side>0` or `x<side>` — stop
 * regulating, or abort — and nothing else. They cannot open a valve, they
 * cannot hold one open, and if the link drops they simply stop being able to
 * intervene while the board carries on. Accepting that is the cost of §5.1,
 * and it is the right trade: a watchdog that fails silent is better than a
 * control loop that fails open.
 *
 * UNITS, AND THE ONE CONVERSION THAT MATTERS
 *   GC-4 speaks in ± half-bands: `deadband: 15` means 15 psi either side of
 *   the setpoint. The board's `B` command takes the FULL band width. The
 *   doubling happens in `boardConfig()` below and nowhere else. Get this
 *   wrong and the stand regulates in a band half or twice the width the
 *   screen claims, which is exactly the kind of error that looks like a
 *   plausible reading right up until it isn't.
 *
 * THE ENABLE HANDSHAKE (§5.6)
 *   Enabling with stale configuration regulates to the wrong setpoint, so
 *   `b<side>1` is not sent until the board echoes the config back as a
 *   `CFG_PUSH`. Since a firmware that never echoes would otherwise be
 *   impossible to enable, the requirement is applied only to boards that have
 *   been seen to echo at least once — see `enableGate()`.
 */
import { commandSide } from './hal/bb-protocol.js';

/**
 * Operating limits an operator may retune from the control screen.
 *
 * The bounds are guard rails against a typo — a 300-second "pulse" entered by
 * a slipped keystroke — not policy. Policy is `requiresArm`, which stays in
 * the config file and is deliberately not runtime-adjustable: a policy an
 * operator can switch off from the control screen is not a policy.
 */
const LIMITS = {
  maxOpenMs: { min: 0, max: 120000, units: 'ms' },
  minIntervalMs: { min: 0, max: 120000, units: 'ms' },
  maxOpenSeconds: { min: 0, max: 3600, units: 's' },
};

/** How long the board gets to echo a config push before we call it lost. */
const CONFIRM_TIMEOUT_MS = 1500;

/** How long the board gets to enter SUS after `b<side>1`. */
const ENABLE_TIMEOUT_MS = 1500;

/**
 * How often a stop is repeated at a board that has not acted on it.
 *
 * A retry is worth having — the first command may have been lost — but at the
 * tick rate it would be fifty commands a second down the same serial link the
 * board needs in order to answer, which is the opposite of helpful when the
 * thing you want is for it to stop.
 */
const STOP_RETRY_MS = 1000;

/** Tolerance when comparing our config against the board's echo. */
const ECHO_EPSILON = 0.05;

export class BangBangBank {
  constructor(controller) {
    this.stand = controller;
    this.runtime = new Map(); // id -> runtime state
    this.sync();
  }

  /** Rebuild runtime state after a config reload, preserving live settings. */
  sync() {
    const cfg = this.stand.config;
    const next = new Map();
    for (const c of cfg.bangbang) {
      const prev = this.runtime.get(c.id);
      next.set(c.id, {
        id: c.id,
        side: commandSide(c.side),
        // Operator INTENT. The board's reported state is the truth; this is
        // what we have asked it for.
        enabled: prev?.enabled ?? c.enabled ?? false,
        setpoint: prev?.setpoint ?? c.setpoint,
        deadband: prev?.deadband ?? c.deadband,
        // Board-side limits, seeded from config and then owned by the runtime.
        // A live operator change must survive a config hot-reload, so `prev`
        // wins here exactly as it does for the setpoint.
        maxOpenMs: prev?.maxOpenMs ?? c.maxOpenMs ?? 0,
        minIntervalMs: prev?.minIntervalMs ?? c.minIntervalMs ?? 0,
        ventTrigger: prev?.ventTrigger ?? c.ventTrigger ?? null,
        ventAuto: prev ? prev.ventAuto : (c.ventAuto ?? false),
        // Host supervisory trips. No board equivalent exists for either.
        maxOpenSeconds: prev?.maxOpenSeconds ?? c.maxOpenSeconds ?? 0,
        // null, not 0: 0 is a legitimate abort threshold, so "no threshold"
        // needs its own value.
        //
        // Tested on `prev` rather than on `prev?.abortAbove`, because `??`
        // cannot tell a runtime value of null from an absent one. Written the
        // short way, an operator who turned the threshold OFF would have it
        // silently switched back on by the next config reload — the one
        // failure mode in this file that hands you a surprise abort.
        abortAbove: prev ? prev.abortAbove : (c.abortAbove ?? null),

        // --- handshake and supervision bookkeeping ---
        configPushedAt: prev?.configPushedAt ?? null,
        configDirty: prev?.configDirty ?? true,
        awaitingEcho: prev?.awaitingEcho ?? false,
        enableSentAt: prev?.enableSentAt ?? null,
        manualVent: prev?.manualVent ?? false,
        stopRetryAt: prev?.stopRetryAt ?? null,
        pressSince: prev?.pressSince ?? null,
        lastPress: prev?.lastPress ?? false,
        cycles: prev?.cycles ?? 0,
        fault: prev?.fault ?? null,
        lastError: prev?.lastError ?? null,
        lastCommand: prev?.lastCommand ?? null,
        warnedNoEcho: prev?.warnedNoEcho ?? false,
      });
    }
    this.runtime = next;
  }

  get(id) { return this.runtime.get(id); }

  /** The driver, if it speaks the board's bang-bang protocol at all. */
  get driver() {
    const d = this.stand.driver;
    return typeof d?.bbEnable === 'function' ? d : null;
  }

  /** Board-reported state for one controller's side, or null. */
  board(rt) {
    if (!rt?.side) return null;
    const status = this.driver?.bbStatus?.();
    return status?.[rt.side.toLowerCase()] ?? null;
  }

  /**
   * Is this controller live — either we have asked for it, or the board says
   * it is regulating? Both halves matter: intent without a board state covers
   * the moment between the request and the first heartbeat, and a board state
   * without intent covers a loop still running that we have lost track of.
   */
  isLive(id) {
    const rt = this.runtime.get(id);
    if (!rt) return false;
    if (rt.enabled) return true;
    const board = this.board(rt);
    return Boolean(board && !board.stale && board.state !== 'OFF');
  }

  /** Valves the board owns right now — a live loop is driving them. */
  ownedValves() {
    const out = new Map();
    for (const cfg of this.stand.config.bangbang) {
      if (!this.isLive(cfg.id)) continue;
      if (cfg.valve) out.set(cfg.valve, cfg);
      if (cfg.ventValve) out.set(cfg.ventValve, cfg);
    }
    return out;
  }

  /**
   * Apply an operator or sequence change. Returns {ok, error}.
   *
   * Accepts `enabled`, `setpoint`, `deadband`, the duty-cycle limits, the vent
   * settings, `abortAbove`, and the two overrides `vent` and `abort`. Anything
   * rejected leaves the controller exactly as it was — a half-applied patch is
   * a regulator nobody configured.
   */
  set(id, patch = {}, source = 'operator') {
    const cfg = this.stand.configStore.controller(id);
    const rt = this.runtime.get(id);
    if (!cfg || !rt) return { ok: false, error: `Unknown controller "${id}"` };
    if (!rt.side) {
      return { ok: false, error: `${cfg.name || id}: no board side configured (set "side" to "L" or "F")` };
    }

    // --- limits: validate everything before writing anything ---
    //
    // Checked against the MERGED result rather than each field on its own, so
    // a patch that moves maxOpenMs and maxOpenSeconds together is judged on
    // where it lands instead of on whichever half is applied first.
    const limits = {
      maxOpenMs: rt.maxOpenMs,
      minIntervalMs: rt.minIntervalMs,
      maxOpenSeconds: rt.maxOpenSeconds,
    };
    for (const [key, bound] of Object.entries(LIMITS)) {
      if (patch[key] === undefined) continue;
      const v = Number(patch[key]);
      if (!Number.isFinite(v) || v < bound.min || v > bound.max) {
        return {
          ok: false,
          error: `${key} must be between ${bound.min} and ${bound.max} ${bound.units} (0 disables it)`,
        };
      }
      limits[key] = v;
    }
    // A pulse longer than the leak trip can never fire: the trip cuts in
    // first and drops the controller instead of limiting the pulse.
    if (limits.maxOpenMs > 0 && limits.maxOpenSeconds > 0 &&
        limits.maxOpenMs >= limits.maxOpenSeconds * 1000) {
      return {
        ok: false,
        error: `Max pulse (${limits.maxOpenMs} ms) must be shorter than the leak trip ` +
               `(${limits.maxOpenSeconds}s), or the trip fires first and drops control`,
      };
    }

    let abortAbove = rt.abortAbove;
    if (patch.abortAbove !== undefined) {
      if (patch.abortAbove === null || patch.abortAbove === '') {
        abortAbove = null;                       // threshold removed
      } else {
        const v = Number(patch.abortAbove);
        if (!Number.isFinite(v)) return { ok: false, error: 'abortAbove must be a number, or null to disable it' };
        abortAbove = v;
      }
    }

    let ventTrigger = rt.ventTrigger;
    if (patch.ventTrigger !== undefined) {
      if (patch.ventTrigger === null || patch.ventTrigger === '') {
        ventTrigger = null;
      } else {
        const v = Number(patch.ventTrigger);
        if (!Number.isFinite(v) || v < 0) return { ok: false, error: 'ventTrigger must be a number >= 0, or null to disable it' };
        ventTrigger = v;
      }
    }
    const ventAuto = patch.ventAuto === undefined ? rt.ventAuto : Boolean(patch.ventAuto);
    if (ventAuto && ventTrigger == null) {
      return { ok: false, error: 'Auto-vent needs a vent trigger pressure' };
    }

    // --- values the board will be told about ---
    const before = boardConfig(rt);
    const beforeVent = { trigger: rt.ventTrigger, auto: rt.ventAuto };

    if (patch.setpoint !== undefined) {
      const v = Number(patch.setpoint);
      if (!Number.isFinite(v)) return { ok: false, error: 'setpoint must be a number' };
      rt.setpoint = clamp(v, cfg.setpointMin, cfg.setpointMax);
    }
    if (patch.deadband !== undefined) {
      const v = Number(patch.deadband);
      if (!Number.isFinite(v) || v <= 0) return { ok: false, error: 'deadband must be > 0' };
      rt.deadband = clamp(v, cfg.deadbandMin, cfg.deadbandMax);
    }

    // Retuning a limit mid-test has to be as traceable as opening a valve: the
    // event log and the CSV are what a post-test review reads.
    const changes = [];
    for (const key of Object.keys(LIMITS)) {
      if (limits[key] !== rt[key]) {
        changes.push(`${key} ${rt[key]}${LIMITS[key].units} -> ${limits[key]}${LIMITS[key].units}`);
        rt[key] = limits[key];
      }
    }
    if (abortAbove !== rt.abortAbove) {
      changes.push(`abortAbove ${rt.abortAbove ?? 'off'} -> ${abortAbove ?? 'off'}`);
      rt.abortAbove = abortAbove;
    }
    if (ventTrigger !== rt.ventTrigger || ventAuto !== rt.ventAuto) {
      changes.push(`vent ${rt.ventTrigger ?? 'off'}/${rt.ventAuto ? 'auto' : 'manual'} -> ${ventTrigger ?? 'off'}/${ventAuto ? 'auto' : 'manual'}`);
      rt.ventTrigger = ventTrigger;
      rt.ventAuto = ventAuto;
    }
    if (changes.length) this.stand.log('command', `${cfg.name}: ${changes.join(', ')}`, source);

    // Anything the board holds has changed -> push it and re-arm the echo
    // check, even mid-run. The board applies a new setpoint live; what it must
    // never do is run on a setpoint we only think it has.
    //
    // Only on an actual change: the board shares one serial link with the
    // telemetry stream, and re-pushing an unchanged config on every keystroke
    // is bytes taken from the thing that has to arrive.
    if (!sameBoardConfig(before, boardConfig(rt))) {
      rt.configDirty = true;
      const res = this.pushConfig(cfg, rt, source);
      if (!res.ok) return res;
    } else if (ventTrigger !== beforeVent.trigger || ventAuto !== beforeVent.auto) {
      const res = this.pushVent(cfg, rt, source);
      if (!res.ok) return res;
    }

    // --- overrides: vent and per-side abort ---
    if (patch.vent !== undefined) {
      const open = Boolean(patch.vent);
      const res = this.driverCall(rt, () => this.driver.bbManualVent(rt.side, open));
      if (!res.ok) return { ok: false, error: `Vent command failed: ${res.error}` };
      rt.manualVent = open;
      this.stand.log('command', `${cfg.name}: manual vent ${open ? 'OPEN' : 'CLOSED'}`, source);
    }

    if (patch.abort) {
      const res = this.driverCall(rt, () => this.driver.bbAbort(rt.side));
      if (!res.ok) return { ok: false, error: `Abort command failed: ${res.error}` };
      rt.enabled = false;
      rt.enableSentAt = null;
      rt.fault = 'Aborted (board latch)';
      // Latched on the board. §5.4 says nothing in the protocol clears it, so
      // say so here rather than letting an operator hunt for the reset that
      // does not exist.
      this.stand.log('abort', `${cfg.name}: side ${rt.side} ABORT sent — latched on the board until it is power-cycled or re-armed`, source);
    }

    // --- enable / disable ---
    if (patch.enabled !== undefined) {
      const want = Boolean(patch.enabled);
      if (want && cfg.requiresArm && !this.stand.armed) {
        return { ok: false, error: `${cfg.name} requires the stand to be ARMED` };
      }
      const board = this.board(rt);
      if (want && board?.state === 'ABT') {
        return { ok: false, error: `${cfg.name}: side ${rt.side} is latched in ABORT on the board — it cannot be re-enabled from here` };
      }
      if (want !== rt.enabled) {
        rt.enabled = want;
        rt.fault = null;
        rt.lastError = null;
        rt.enableSentAt = null;
        rt.cycles = 0;
        if (want) {
          // The actual `b<side>1` waits for the config echo; update() sends it.
          // Push now if we have never pushed, so there is something to confirm.
          if (rt.configDirty || rt.configPushedAt == null) {
            const res = this.pushConfig(cfg, rt, source);
            if (!res.ok) { rt.enabled = false; return res; }
          }
          this.stand.log('command',
            `${cfg.name}: requesting board control @ ${rt.setpoint} ±${rt.deadband}`, source);
        } else {
          // Never gate a stop on anything. Straight out on the wire.
          const res = this.driverCall(rt, () => this.driver.bbEnable(rt.side, false));
          this.stand.log('info', `${cfg.name}: control DISABLED`, source);
          if (!res.ok) return { ok: false, error: `Disable failed: ${res.error}` };
        }
      }
    }

    return { ok: true };
  }

  /**
   * Apply one patch to every controller.
   *
   * Every controller is attempted even if one refuses — this is the path a
   * DISARM and an ABORT take, and one bad controller must never stop the rest
   * from being shut down. Refusals are aggregated rather than swallowed so a
   * sequence step targeting `*` can report what did not take.
   */
  setAll(patch, source) {
    const failures = [];
    for (const c of this.stand.config.bangbang) {
      const res = this.set(c.id, patch, source);
      if (!res.ok) failures.push(`${c.id}: ${res.error}`);
    }
    return failures.length ? { ok: false, error: failures.join('; ') } : { ok: true };
  }

  // ------------------------------------------------------------- outbound ---

  /** Push `B` (and `V`, when a vent trigger is configured) for one side. */
  pushConfig(cfg, rt, source) {
    const wire = boardConfig(rt);
    const res = this.driverCall(rt, () => this.driver.bbConfig(rt.side, wire));
    if (!res.ok) return { ok: false, error: `Config push failed: ${res.error}` };

    if (rt.ventTrigger != null) {
      const ventRes = this.pushVent(cfg, rt, source);
      if (!ventRes.ok) return ventRes;
    }

    rt.configDirty = false;
    // Stamped by update() on the next tick, so every handshake timer in this
    // file runs off the control loop's clock rather than a second one. Two
    // clocks in one timeout is a bug that only shows up under load.
    rt.configPushedAt = null;
    rt.awaitingEcho = true;
    // The echo is what confirms it. Until then this is only "the bytes left
    // the host", which says nothing about firmware acceptance (§5.5).
    this.stand.log('control',
      `${cfg.name}: -> board  ${wire.setpoint} psi, band ${wire.deadbandFull} psi full, ` +
      `dwell ${wire.waitMs} ms, pulse ${wire.maxOpenMs || '∞'} ms`, source);
    return { ok: true };
  }

  /** Push `V` alone, for a vent setting changed without touching the band. */
  pushVent(cfg, rt, source) {
    if (rt.ventTrigger == null) return { ok: true };
    const res = this.driverCall(rt, () =>
      this.driver.bbVent(rt.side, { trigger: rt.ventTrigger, auto: rt.ventAuto }));
    if (!res.ok) return { ok: false, error: `Vent config push failed: ${res.error}` };
    return { ok: true };
  }

  /**
   * Subscribe to the board's rejections.
   *
   * `BB_ERROR:`/`CMD_ERROR:` are free text and are never parsed — §4.1.6 is
   * explicit about that, so no attempt is made to read a side out of the
   * message. Attribution is by what was in flight instead: a rejection that
   * arrives while a controller is mid-handshake is that controller's, because
   * nothing else was waiting on an answer. When nothing was in flight the
   * message still reaches the event log via the driver, which is where a
   * rejection nobody can attribute belongs.
   */
  attach() {
    const device = this.stand.driver?.bbDevice?.() ?? this.driver;
    if (!device) return;
    device.onBbError = (message) => {
      const waiting = [...this.runtime.values()].filter((rt) => rt.enabled && this.awaiting(rt, this.board(rt)));
      for (const rt of waiting) rt.lastError = message;
    };
  }

  /**
   * Push every controller's configuration to the board.
   *
   * Called at startup and after a config reload. Failures are logged rather
   * than thrown: a board that is not answering yet must not stop the server
   * from coming up, and the enable handshake will refuse to start a side whose
   * config was never confirmed anyway.
   */
  pushAll(source = 'system') {
    if (!this.driver) return;
    for (const cfg of this.stand.config.bangbang) {
      const rt = this.runtime.get(cfg.id);
      if (!rt?.side) continue;
      const res = this.pushConfig(cfg, rt, source);
      if (!res.ok) this.stand.log('warn', `${cfg.name}: ${res.error}`, source);
    }
  }

  /** One driver call, with the "no driver" case turned into a real error. */
  driverCall(rt, fn) {
    if (!this.driver) {
      return { ok: false, error: `the ${this.stand.driver?.status?.name || 'current'} driver does not support board-side bang-bang` };
    }
    let res;
    try {
      res = fn() || { ok: false, error: 'no response from driver' };
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (res.command) rt.lastCommand = res.command;
    if (!res.ok) rt.lastError = res.error;
    return res;
  }

  // ------------------------------------------------------------ every tick ---

  /**
   * Supervision, mirroring, and the second half of the enable handshake.
   *
   * Nothing here drives a valve. The strongest thing this method can do is
   * tell the board to stop.
   */
  update(readings, now) {
    for (const cfg of this.stand.config.bangbang) {
      const rt = this.runtime.get(cfg.id);
      if (!rt) continue;
      const board = this.board(rt);

      // Every timer in this file is stamped from the tick's clock, including
      // the one that starts when a config goes out.
      if (rt.awaitingEcho && rt.configPushedAt == null) rt.configPushedAt = now;

      this.trackCycles(rt, board, now);
      this.mirrorValves(cfg, rt, board);

      if (!rt.side) continue;

      // Losing ARM drops every controller that depends on it. Retried rather
      // than sent once, because a board that missed the first `b<side>0` is
      // still regulating and the second one is how it finds out — but at
      // 1 Hz, not at the tick rate. Fifty stop commands a second would flood
      // the same serial link the board needs to answer on, and fifty log
      // lines a second would bury the reason it is being stopped.
      if (cfg.requiresArm && !this.stand.armed && (rt.enabled || board?.state === 'SUS')) {
        if (rt.stopRetryAt == null || now - rt.stopRetryAt >= STOP_RETRY_MS) {
          rt.stopRetryAt = now;
          this.stop(cfg, rt, 'Disarmed', 'interlock',
            `${cfg.name}: control dropped (stand disarmed)`, 'warn');
        }
        continue;
      }
      rt.stopRetryAt = null;

      if (this.checkAbortThreshold(cfg, rt, board, readings)) continue;

      if (!rt.enabled) continue;

      if (this.finishEnable(cfg, rt, board, now)) continue;
      if (this.checkLeakTrip(cfg, rt, board, now)) continue;

      // A stale heartbeat does NOT disable the controller. The board keeps
      // regulating on its own — that is the entire reason the loop lives
      // there — so losing the link means we have stopped being able to watch,
      // not that anything has stopped. Say exactly that, and leave it running.
      if (board?.stale) {
        rt.fault = 'No heartbeat from board';
      } else if (rt.fault === 'No heartbeat from board') {
        rt.fault = null;
      }
    }
  }

  /**
   * Send `b<side>1` once the board has confirmed the configuration (§5.6).
   * Returns true if the controller was dropped and the tick should move on.
   */
  finishEnable(cfg, rt, board, now) {
    if (board?.state === 'SUS' || board?.state === 'AV') {
      rt.enableSentAt = null;   // running; nothing left to chase
      return false;
    }

    if (board?.state === 'ABT') {
      this.stop(cfg, rt, 'Board aborted', 'board',
        `${cfg.name}: board latched side ${rt.side} into ABORT — control dropped`, 'error');
      return true;
    }

    if (rt.enableSentAt == null) {
      const gate = this.enableGate(cfg, rt, board, now);
      if (gate === 'wait') return false;
      if (gate === 'timeout') {
        this.stop(cfg, rt, 'Config not confirmed',
          'interlock',
          `${cfg.name}: board did not echo the configuration within ${CONFIRM_TIMEOUT_MS} ms — ` +
          `not enabling on a setpoint it may not have (§5.6)`, 'error');
        return true;
      }
      const res = this.driverCall(rt, () => this.driver.bbEnable(rt.side, true));
      if (!res.ok) {
        this.stop(cfg, rt, 'Enable failed', 'interlock',
          `${cfg.name}: enable failed — ${res.error}`, 'error');
        return true;
      }
      rt.enableSentAt = now;
      return false;
    }

    // Sent, but the board never entered SUS and never said why. §5.8: a
    // command that produces neither an echo nor an error inside a timeout has
    // to be treated as lost.
    if (now - rt.enableSentAt > ENABLE_TIMEOUT_MS) {
      this.stop(cfg, rt, 'Board did not start',
        'interlock',
        `${cfg.name}: board did not enter SUS within ${ENABLE_TIMEOUT_MS} ms of \`b${rt.side}1\` — ` +
        `command lost, or firmware refused it silently`, 'error');
      return true;
    }
    return false;
  }

  /**
   * Whether the board has confirmed the configuration we pushed.
   *
   *   'go'      confirmed, or this firmware does not echo at all
   *   'wait'    pushed, echo not in yet
   *   'timeout' pushed, echo overdue
   *
   * §5.6 says not to enable before the echo confirms the config. Applied
   * literally, that would make a firmware which never echoes impossible to
   * enable — so the requirement is enforced only against boards we have
   * actually seen echo. A board that has never echoed is enabled with a
   * warning, once, naming what we could not verify.
   */
  enableGate(cfg, rt, board, now) {
    if (!board?.echoes) {
      if (!rt.warnedNoEcho) {
        rt.warnedNoEcho = true;
        this.stand.log('warn',
          `${cfg.name}: board has never sent a CFG_PUSH echo — enabling WITHOUT confirmation that ` +
          `it holds ${rt.setpoint} ±${rt.deadband}. Verify the setpoint against the board before pressurising.`,
          'interlock');
      }
      return 'go';
    }
    if (echoMatches(boardConfig(rt), board.confirmed)) { rt.awaitingEcho = false; return 'go'; }
    if (rt.configPushedAt != null && now - rt.configPushedAt > CONFIRM_TIMEOUT_MS) return 'timeout';
    return 'wait';
  }

  /**
   * Leak trip. Measured on the BOARD's press bit, not on anything we command,
   * so it is watching what the valve actually did.
   *
   * The resolution is the heartbeat rate, so this catches "open for thirty
   * seconds" and never "open for eighty milliseconds" — which is correct: the
   * pulse-length limit is the board's job, and this is the "should have
   * reached setpoint by now" trip.
   */
  checkLeakTrip(cfg, rt, board, now) {
    if (!(rt.maxOpenSeconds > 0) || !board?.press || rt.pressSince == null) return false;
    const openFor = (now - rt.pressSince) / 1000;
    if (openFor <= rt.maxOpenSeconds) return false;

    this.stop(cfg, rt, `Valve open > ${rt.maxOpenSeconds}s`, 'interlock',
      `${cfg.name}: ${cfg.valve || `side ${rt.side}`} open ${openFor.toFixed(0)}s without reaching setpoint — ` +
      `control dropped (leak? failed PT?)`, 'error');
    return true;
  }

  /**
   * Stand-wide abort threshold.
   *
   * Checked against BOTH pressures, because they are two different sensors:
   * the board regulates on its own PT, while the stand's process value comes
   * from the DAQ. Either one reading past the limit is enough — if they
   * disagree about a tank being over-pressure, the safe assumption is that the
   * one shouting is right.
   */
  checkAbortThreshold(cfg, rt, board, readings) {
    if (rt.abortAbove == null) return false;
    // Fires once. The stand is already latched in ABORT and this side is
    // already told to stop; re-sending `bL0`/`xL` every tick would flood the
    // serial link at exactly the moment the operator needs it for something
    // else. Re-enabling the controller clears the fault and re-arms this.
    if (rt.fault === 'Abort threshold') return false;

    const boardPsi = board?.stale ? null : board?.pressure;
    const hostPsi = readings?.[cfg.sensor];

    let over = null;
    if (Number.isFinite(boardPsi) && boardPsi > rt.abortAbove) {
      over = { value: boardPsi, from: `board PT (side ${rt.side})` };
    } else if (Number.isFinite(hostPsi) && hostPsi > rt.abortAbove) {
      over = { value: hostPsi, from: cfg.sensor };
    }
    if (!over) return false;

    rt.enabled = false;
    rt.enableSentAt = null;
    rt.fault = 'Abort threshold';
    if (rt.side && this.driver) {
      // Both: the abort latches the side safe, the disable covers a firmware
      // that treats `x` as advisory.
      this.driverCall(rt, () => this.driver.bbEnable(rt.side, false));
      this.driverCall(rt, () => this.driver.bbAbort(rt.side));
    }
    this.stand.abort(`${over.from} = ${over.value.toFixed(1)} exceeded abort limit ${rt.abortAbove}`);
    return true;
  }

  /** Drop one controller: clear intent, tell the board to stop, log why. */
  stop(cfg, rt, fault, source, message, level = 'warn') {
    rt.enabled = false;
    rt.enableSentAt = null;
    rt.awaitingEcho = false;
    rt.fault = fault;
    if (rt.side && this.driver) {
      this.driverCall(rt, () => this.driver.bbEnable(rt.side, false));
    }
    this.stand.log(level, message, source);
  }

  /**
   * Count press cycles as the board reports them.
   *
   * Host-observed, at the heartbeat rate — a pulse shorter than one heartbeat
   * interval is invisible here. It is a trend indicator ("this thing is
   * cycling far more than it was an hour ago"), not an instrument.
   */
  trackCycles(rt, board, now) {
    const press = Boolean(board?.press);
    if (press !== rt.lastPress) {
      rt.lastPress = press;
      rt.cycles++;
      rt.pressSince = press ? now : null;
    } else if (press && rt.pressSince == null) {
      rt.pressSince = now;
    }
  }

  /**
   * Reflect the board's own account of its solenoids into the stand's valve
   * state, so the P&ID and the actuation screen show what is really happening.
   *
   * This deliberately bypasses commandValve(): we are not commanding anything,
   * we are recording an observation, and routing it through the command path
   * would send a redundant `S<ch>` back at the board for a valve it already
   * has open.
   *
   * Only while the board's loop actually owns the valve. In OFF the board's
   * press bit reports its own regulator's demand, which says nothing about a
   * solenoid an operator has since driven by hand — mirroring then would show
   * a manually-opened valve as closed.
   */
  mirrorValves(cfg, rt, board) {
    if (!board || board.stale || board.state === 'OFF') return;

    if (cfg.valve) this.setObservedValve(cfg.valve, board.press);
    if (cfg.ventValve) this.setObservedValve(cfg.ventValve, board.vent);
  }

  setObservedValve(valveId, energized) {
    const valve = this.stand.configStore.valve(valveId);
    if (!valve) return;
    // The board reports COIL state; the stand speaks FLOW state. For a
    // normally-open valve those are opposites, and the same rule that
    // resolves it on the way out has to resolve it on the way back in.
    const state = valve.normallyOpen
      ? (energized ? 'closed' : 'open')
      : (energized ? 'open' : 'closed');
    if (this.stand.valveStates[valveId] === state) return;
    this.stand.valveStates[valveId] = state;
    this.stand.valveMeta[valveId] = { at: Date.now(), source: 'board' };
    this.stand.emit('valve-change', valveId, state);
  }

  // -------------------------------------------------------------- snapshot ---

  snapshot() {
    const out = {};
    for (const cfg of this.stand.config.bangbang) {
      const rt = this.runtime.get(cfg.id);
      if (!rt) continue;
      const board = this.board(rt);
      const wire = boardConfig(rt);
      out[cfg.id] = {
        side: rt.side,
        // What we have asked the board for.
        enabled: rt.enabled,
        setpoint: rt.setpoint,
        deadband: rt.deadband,
        maxOpenMs: rt.maxOpenMs,
        minIntervalMs: rt.minIntervalMs,
        maxOpenSeconds: rt.maxOpenSeconds,
        ventTrigger: rt.ventTrigger,
        ventAuto: rt.ventAuto,
        abortAbove: rt.abortAbove,

        // What the board says it is doing. `null` means it has not said.
        board: board && {
          state: board.state,
          stateValid: board.stateValid,
          press: board.press,
          vent: board.vent,
          pressure: board.pressure,
          stale: board.stale,
          lastBeatAt: board.lastBeatAt,
          echoes: board.echoes,
          confirmed: board.confirmed,
        },

        // Whether the board's echo agrees with what we asked for. The echo is
        // authoritative (§5.5); the values above are only our request.
        confirmed: board ? echoMatches(wire, board.confirmed) : false,
        awaiting: this.awaiting(rt, board),

        // A flat "is the press valve open", for API consumers that do not want
        // to reach into `board`. It is an OBSERVATION of the board's press bit,
        // never something this server commanded.
        //
        // There is deliberately no companion field saying WHY the valve is
        // closed. The board owns the pulse and dwell limits and does not report
        // which one is biting, so any such field here would be this server
        // guessing at the board's reasoning and presenting it as fact.
        output: Boolean(board?.press),

        cycles: rt.cycles,
        fault: rt.fault,
        lastError: rt.lastError,
        lastCommand: rt.lastCommand,
      };
    }
    return out;
  }

  awaiting(rt, board) {
    if (!rt.enabled) return null;
    if (board?.state === 'SUS' || board?.state === 'AV') return null;
    if (rt.enableSentAt != null) return 'enable';
    return 'config';
  }
}

/**
 * Our runtime settings, in the units the board's `B` command wants.
 *
 * THE DOUBLING LIVES HERE. GC-4's `deadband` is a ± half-band; the board's is
 * the full width centred on the setpoint.
 *
 * `minIntervalMs` maps to the board's `wait_ms`, and the two are not quite the
 * same promise. GC-4's is a guaranteed OFF-time measured from the last close,
 * and never delays a close. The board's is documented as a minimum dwell
 * between valve state transitions, which may also delay a close. VERIFY THIS
 * AGAINST FIRMWARE before relying on the difference — a dwell that can hold a
 * press valve open past setpoint is a materially different safety property
 * from one that cannot.
 */
export function boardConfig(rt) {
  return {
    setpoint: rt.setpoint,
    deadbandFull: rt.deadband * 2,
    waitMs: rt.minIntervalMs,
    maxOpenMs: rt.maxOpenMs,
  };
}

function sameBoardConfig(a, b) {
  return a.setpoint === b.setpoint && a.deadbandFull === b.deadbandFull &&
         a.waitMs === b.waitMs && a.maxOpenMs === b.maxOpenMs;
}

/**
 * Does the board's CFG_PUSH echo agree with what we pushed?
 *
 * Only the four core fields are compared. The vent settings are echoed too,
 * but a controller with no vent trigger configured never pushed them, and
 * holding an enable hostage to a field we never sent would deadlock it.
 */
export function echoMatches(wire, confirmed) {
  if (!confirmed || confirmed.setpoint === undefined) return false;
  return near(confirmed.setpoint, wire.setpoint) &&
         near(confirmed.deadbandFull, wire.deadbandFull) &&
         near(confirmed.waitMs, wire.waitMs, 1) &&
         near(confirmed.maxOpenMs, wire.maxOpenMs, 1);
}

function near(a, b, epsilon = ECHO_EPSILON) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
}

function clamp(v, lo, hi) {
  if (Number.isFinite(lo)) v = Math.max(lo, v);
  if (Number.isFinite(hi)) v = Math.min(hi, v);
  return v;
}
