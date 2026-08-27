#!/usr/bin/env python3
"""
daq_streamer.py -- NI cDAQ acquisition sidecar for ERPL GC-4.

Spawned by server/hal/nidaq.js. Speaks newline-delimited JSON:

    stdout  telemetry + status frames  (one JSON object per line)
    stdin   commands                   (one JSON object per line)
    stderr  human-readable diagnostics (forwarded to the GC console)

This replaces the old two-process split (Python -> TCP 5001 -> Node) and the
sentinel-file command channel that existed only because that TCP hop was
one-way. stdin is a real back-channel, so tare/calibration commands are issued
in band.

Cards (auto-detected by product type, falling back to the configured slot):

    NI-9237  bridge / load cells    Delta-sigma. Tries HIGH_RESOLUTION so it
                                    can decimate to the requested rate, but
                                    the DSUB variant on the Draco chassis does
                                    not expose ai_adc_timing_mode (-200452).
                                    There the rate coerces to 12800/8 =
                                    1612.9 Hz. Reads drain the buffer each
                                    pass, which sustains that without overruns.
    NI-9208  4-20 mA / pressure     HIGH_SPEED is mandatory at 100 Hz;
                                    HIGH_RESOLUTION is 52 ms/ch (~19 S/s).
    NI-9211  thermocouples          Has NO sample clock. Never call
                                    cfg_samp_clk_timing on it. Read on demand
                                    from a dedicated thread (~350 ms/call).
                                    Several 9211s may be chained: `modules`
                                    lists them and their channels concatenate.

The 9237 (simultaneous) and 9208 (multiplexed) have incompatible ADC
architectures and cannot share a sample clock -- each task runs on its own
timebase and alignment is done by host timestamping at the loop rate.
"""

import json
import math
import sys
import threading
import time
from collections import defaultdict

try:
    import nidaqmx
    from nidaqmx.constants import (
        AcquisitionType, ADCTimingMode, AutoZeroType, BridgeConfiguration,
        BridgeUnits, CJCSource, ExcitationSource, ReadRelativeTo,
        TemperatureUnits, TerminalConfiguration, ThermocoupleType,
    )
except ImportError:  # pragma: no cover - depends on host having NI-DAQmx
    nidaqmx = None


def emit(obj):
    """One JSON object per line on stdout. Never let a write kill the loop."""
    try:
        sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        raise SystemExit(0)


def note(msg):
    sys.stderr.write(str(msg) + '\n')
    sys.stderr.flush()


TC_TYPES = {
    'K': ThermocoupleType.K if nidaqmx else None,
    'J': ThermocoupleType.J if nidaqmx else None,
    'T': ThermocoupleType.T if nidaqmx else None,
    'E': ThermocoupleType.E if nidaqmx else None,
    'N': ThermocoupleType.N if nidaqmx else None,
    'R': ThermocoupleType.R if nidaqmx else None,
    'S': ThermocoupleType.S if nidaqmx else None,
    'B': ThermocoupleType.B if nidaqmx else None,
}


def _try_set(target, prop, value, label):
    """Set an optional DAQmx property, tolerating modules that lack it.

    Property support varies by module variant and by nidaqmx version. These
    are all performance tuning, never correctness, so a missing property must
    degrade the stream rather than abort the task.
    """
    try:
        setattr(target, prop, value)
        return True
    except Exception as exc:
        note(f'[daq] {label} unavailable: {str(exc).splitlines()[0]}')
        return False


def find_device(chassis, model, slot, exclude=()):
    """Scan for <chassis>Mod* whose product_type contains the model number.

    `exclude` skips modules already claimed, so a chassis carrying two of the
    same card (this one has a 9211 in both slot 3 and slot 4) resolves each to
    a distinct module instead of both to the first match.
    """
    fallback = f'{chassis}Mod{slot}'
    try:
        system = nidaqmx.system.System.local()
        # Prefer the configured slot when it is the right model and unclaimed.
        candidates = []
        for dev in system.devices:
            if not dev.name.startswith(chassis) or dev.name in exclude:
                continue
            try:
                product = dev.product_type or ''
            except Exception:
                continue
            if model in product:
                candidates.append(dev.name)
        if fallback in candidates:
            return fallback
        if candidates:
            return candidates[0]
    except Exception as exc:
        note(f'[daq] device scan failed ({exc}); using {fallback}')
    return fallback


# ------------------------------------------------------------------- cards ----

class PtCard:
    """NI-9208, 16x 4-20 mA. HIGH_SPEED timing is required at 100 Hz."""

    kind = 'pt'
    label = 'PT Card (NI-9208)'

    def __init__(self, cfg, rate_hz):
        self.cfg = cfg
        self.rate_hz = rate_hz
        self.count = int(cfg.get('channels', 16))
        self.device = find_device(cfg['chassis'], '9208', cfg.get('slot', 2))
        self.task = None
        self.tare = defaultdict(float)
        self.actual_rate_hz = float(cfg.get('sampleClockHz', rate_hz or 100.0))

    def start(self):
        self.task = nidaqmx.Task(new_task_name='')
        self.task.ai_channels.add_ai_current_chan(
            f'{self.device}/ai0:{self.count - 1}',
            min_val=-0.022, max_val=0.022,
            terminal_config=TerminalConfiguration.DEFAULT)
        self.task.timing.cfg_samp_clk_timing(
            rate=self.rate_hz,
            sample_mode=AcquisitionType.CONTINUOUS,
            samps_per_chan=int(self.rate_hz * 10))
        self.task.in_stream.input_buf_size = int(self.rate_hz * 60)
        # 2 ms/channel. HIGH_RESOLUTION is 52 ms/channel (~19 S/s) and cannot
        # keep up at 100 Hz. Both of these are tuning, not correctness: a
        # module that does not expose them must still stream, so never let an
        # unsupported property abort the task.
        _try_set(self.task.ai_channels.all, 'ai_adc_timing_mode',
                 ADCTimingMode.HIGH_SPEED, '9208 ADC timing mode')
        _try_set(self.task.ai_channels.all, 'ai_filter_enable',
                 False, '9208 filter disable')
        self.task.start()

    def convert(self, ch, amps):
        """4-20 mA -> psi. Span is fixed at 16 mA above zero_ma."""
        meta = self.cfg.get('channelMeta', {}).get(str(ch), {})
        ma = amps * 1000.0
        if not math.isfinite(ma) or ma < 3.0 or ma > 25.0:
            return ma, None, 'disconnected'
        zero_ma = float(meta.get('zeroMa', 4.0))
        max_psi = meta.get('maxPsi')
        if max_psi is None:
            return ma, None, 'unconfigured'
        psi = (ma - zero_ma) * (float(max_psi) / 16.0) - self.tare[ch]
        return ma, psi, 'ok'


class LcCard:
    """NI-9237 bridge input. See the module docstring on ADC timing mode."""

    kind = 'lc'
    label = 'LC Card (NI-9237)'

    def __init__(self, cfg, rate_hz):
        self.cfg = cfg
        self.rate_hz = rate_hz
        self.count = int(cfg.get('channels', 4))
        self.device = find_device(cfg['chassis'], '9237', cfg.get('slot', 1))
        self.task = None
        self.tare = defaultdict(float)
        self.actual_rate_hz = float(cfg.get('sampleClockHz', rate_hz or 100.0))

    def start(self):
        self.task = nidaqmx.Task(new_task_name='')
        self.task.ai_channels.add_ai_bridge_chan(
            f'{self.device}/ai0:{self.count - 1}',
            min_val=-0.025, max_val=0.025,
            units=BridgeUnits.VOLTS_PER_VOLT,
            bridge_config=BridgeConfiguration.FULL_BRIDGE,
            voltage_excit_source=ExcitationSource.INTERNAL,
            voltage_excit_val=float(self.cfg.get('excitationV', 10.0)),
            nominal_bridge_resistance=float(self.cfg.get('bridgeOhms', 350.0)))
        self.task.timing.cfg_samp_clk_timing(
            rate=self.rate_hz,
            sample_mode=AcquisitionType.CONTINUOUS,
            samps_per_chan=int(self.rate_hz * 10))
        # Where the part supports it, HIGH_RESOLUTION lets the delta-sigma ADC
        # decimate down to the requested rate. The NI 9237 (DSUB) on this
        # chassis does NOT expose ai_adc_timing_mode and returns -200452, so
        # this is best-effort: if it is unavailable the rate coerces to
        # 12800/8 = 1612.9 Hz and we fall through to drain mode below, which
        # sustains that rate with no overruns.
        _try_set(self.task.ai_channels.all, 'ai_adc_timing_mode',
                 ADCTimingMode.HIGH_RESOLUTION, '9237 ADC timing mode')
        for ch in self.task.ai_channels:
            _try_set(ch, 'ai_auto_zero_mode', AutoZeroType.NONE, '9237 auto-zero')
        self.task.in_stream.input_buf_size = int(self.rate_hz * 60)
        self.task.start()

        coerced = float(self.task.timing.samp_clk_rate)
        if coerced > self.rate_hz * 1.5:
            # Oversampled: drain everything each pass rather than asking for a
            # window that the hardware races past. Grow the host buffer to match.
            try:
                self.task.stop()
                self.task.in_stream.input_buf_size = int(coerced * 60)
                self.task.start()
            except Exception as exc:
                note(f'[daq] could not resize 9237 buffer: {exc}')
            note(f'[daq] 9237 coerced to {coerced:.1f} Hz; buffer sized to match')
            self.actual_rate_hz = coerced

    def convert(self, ch, v_per_v):
        """V/V -> lbf. slope*x + offset, with slope derived from capacity if absent."""
        meta = self.cfg.get('channelMeta', {}).get(str(ch), {})
        if not math.isfinite(v_per_v):
            return v_per_v, None, 'disconnected'
        slope = meta.get('slopeAlt') if meta.get('useAlt') else meta.get('slope')
        if slope is None:
            capacity = meta.get('capacityLbf')
            if capacity is None:
                return v_per_v, None, 'unconfigured'
            rated = float(meta.get('ratedMvPerV', 3.0)) / 1000.0
            slope = float(capacity) / rated * float(meta.get('mechanicalGain', 1.0))
        lbf = float(slope) * v_per_v + float(meta.get('offset', 0.0)) - self.tare[ch]
        return v_per_v, lbf, 'ok'


class TcCard:
    """NI-9211. No sample clock -- on-demand reads from a background thread."""

    kind = 'tc'
    label = 'TC Card (NI-9211)'

    def __init__(self, cfg, rate_hz=None):
        self.cfg = cfg
        # One or more 9211s. Channels concatenate in `modules` order, so a
        # second module's ai0 is logical channel 4.
        mods = cfg.get('modules')
        if not mods:
            mods = [{'slot': cfg.get('slot', 3), 'channels': cfg.get('channels', 4)}]
        self.modules = []
        used = set()
        for spec in mods:
            name = spec.get('device') or find_device(
                cfg['chassis'], '9211', spec.get('slot', 3), exclude=used)
            used.add(name)
            self.modules.append({'device': name,
                                 'channels': int(spec.get('channels', 4))})
        self.count = sum(m['channels'] for m in self.modules)
        self.device = ', '.join(m['device'] for m in self.modules)
        self.task = None
        self.tare = defaultdict(float)
        self.actual_rate_hz = float(cfg.get('sampleClockHz', rate_hz or 100.0))
        self.lock = threading.Lock()
        self.latest = None
        self.thread = None
        self.running = False

    def start(self):
        self.task = nidaqmx.Task(new_task_name='')
        meta = self.cfg.get('channelMeta', {})
        logical = 0
        for mod in self.modules:
            for ch in range(mod['channels']):
                kind = str(meta.get(str(logical), {}).get('type', 'K')).upper()
                tc_type = TC_TYPES.get(kind) or ThermocoupleType.K
                self.task.ai_channels.add_ai_thrmcpl_chan(
                    f"{mod['device']}/ai{ch}",
                    min_val=-320.0, max_val=2282.0,  # degF; -328 is the Type-K floor
                    units=TemperatureUnits.DEG_F,
                    thermocouple_type=tc_type,
                    cjc_source=CJCSource.BUILT_IN, cjc_val=77.0)
                logical += 1
        # Deliberately NO cfg_samp_clk_timing: the 9211 has no sample clock.
        self.task.start()
        self.running = True
        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()

    def _reader(self):
        """~350 ms per read. Runs off the main loop so nothing ever blocks on it."""
        while self.running:
            try:
                raw = self.task.read(number_of_samples_per_channel=1, timeout=5.0)
                if self.count == 1:
                    values = [raw[0] if isinstance(raw, list) else raw]
                else:
                    values = [row[0] if isinstance(row, list) else row for row in raw]
                with self.lock:
                    self.latest = values
            except Exception as exc:
                note(f'[daq] tc read failed: {exc}')
                with self.lock:
                    self.latest = None
                time.sleep(0.5)

    def snapshot(self):
        with self.lock:
            return list(self.latest) if self.latest else None

    def convert(self, ch, degf):
        meta = self.cfg.get('channelMeta', {}).get(str(ch), {})
        # -350 degF is a VALID LOX reading, so the floor must stay below it.
        if degf is None or not math.isfinite(degf) or degf < -450.0 or degf > 3500.0:
            return degf, None, 'disconnected'
        return degf, degf + float(meta.get('offset', 0.0)) - self.tare[ch], 'ok'

    def stop(self):
        self.running = False


# ----------------------------------------------------------------- streamer ----

class Streamer:
    def __init__(self, cfg):
        self.cfg = cfg
        self.rate_hz = float(cfg.get('sampleClockHz', 100.0))
        self.per_read = int(cfg.get('samplesPerRead', 10))
        self.period = self.per_read / self.rate_hz
        self.cards = []
        self.tc = None
        self.misses = defaultdict(int)
        self.restarts = defaultdict(int)
        self.loop_index = 0
        self.running = True
        self.latency_ms = []
        # Most recent raw sample per (card, channel). Tare zeroes against this,
        # so it must exist before the stdin thread can ever read it.
        self._last_raw = {}

        for kind, klass in (('pt', PtCard), ('lc', LcCard), ('tc', TcCard)):
            card_cfg = cfg.get('cards', {}).get(kind)
            if not card_cfg or not card_cfg.get('enabled', True):
                continue
            card_cfg.setdefault('chassis', cfg.get('chassis', ''))
            card = klass(card_cfg, self.rate_hz)
            if kind == 'tc':
                self.tc = card
            else:
                self.cards.append(card)

    def start(self):
        for card in self.cards + ([self.tc] if self.tc else []):
            try:
                card.start()
                note(f'[daq] {card.label} on {card.device}')
            except Exception as exc:
                note(f'[daq] FAILED to start {card.label}: {exc}')
                emit({'type': 'status', 'ok': False,
                      'message': f'{card.label}: {exc}'})

    def read_card(self, card):
        """Drain what the card has buffered since the last pass.

        The obvious alternative -- asking for the most recent N samples via
        MOST_RECENT_SAMPLE + a negative offset -- reads better on paper
        (freshness over throughput) but is measurably worse here. When the
        loop period and the requested window are close in duration the buffer
        has often not advanced a full window, and DAQmx rejects the read with
        -200277; on this chassis that fired on roughly a quarter of PT reads
        and the recovery path dropped the loop from 10 Hz to 3.6 Hz.

        Draining is both faster (0.4 ms vs 2.7 ms per read, measured) and
        total: no sample is skipped, so the per-sample CSV stays contiguous.
        The read is capped at two periods' worth so a backlog -- a stalled
        host, a paused debugger -- unwinds over several passes instead of
        pacing the loop.
        """
        task = card.task
        if task is None:
            return None
        try:
            task.in_stream.relative_to = ReadRelativeTo.CURRENT_READ_POSITION
            task.in_stream.offset = 0
            avail = int(task.in_stream.avail_samp_per_chan)
            if avail <= 0:
                return None
            cap = max(1, int(card.actual_rate_hz * self.period * 2))
            return task.read(number_of_samples_per_channel=min(avail, cap),
                             timeout=0.5)
        except Exception as exc:
            text = str(exc)
            if '-200279' in text or 'keep up with the hardware' in text:
                # Host fell behind and the onboard buffer overflowed. The
                # backlog is unrecoverable; take one sample to resynchronise.
                try:
                    return task.read(number_of_samples_per_channel=1, timeout=0.5)
                except Exception as exc2:
                    text = f'{text} / recovery: {exc2}'

            self.misses[card.kind] += 1
            if self.misses[card.kind] >= 5:
                self.restart_card(card, text)
            return None

    def restart_card(self, card, reason):
        note(f'[daq] restarting {card.label}: {reason}')
        self.misses[card.kind] = 0
        self.restarts[card.kind] += 1
        try:
            card.task.stop()
            card.task.close()
        except Exception:
            pass
        card.task = None
        try:
            card.start()
        except Exception as exc:
            note(f'[daq] restart of {card.label} failed: {exc}')

    def build_frame(self, now):
        channels = []
        for card in self.cards:
            raw = self.read_card(card)
            if raw is None:
                continue
            self.misses[card.kind] = 0
            # DAQmx returns [channel][sample] for multi-channel tasks.
            if card.count == 1:
                raw = [raw]
            for ch, samples in enumerate(raw):
                if not isinstance(samples, list):
                    samples = [samples]
                if not samples:
                    continue
                # PT uses the latest sample; LC uses the window mean.
                value = samples[-1] if card.kind == 'pt' \
                    else sum(samples) / len(samples)
                rawv, eng, status = card.convert(ch, value)
                entry = {'card': card.kind, 'channel': ch,
                         'status': status, 'raw': _finite(rawv),
                         # The offset currently subtracted from this channel.
                         # Sent every frame rather than only in the tare ack:
                         # the host then re-learns it after a sidecar restart
                         # instead of showing a stale zero as if it were live.
                         'tare': _finite(card.tare[ch]),
                         'samples': [_finite(s) for s in samples]}
                if card.kind == 'pt':
                    entry['current_ma'] = _finite(rawv)
                    entry['pressure_psi'] = _finite(eng)
                    entry['units'] = 'psi'
                else:
                    entry['v_per_v'] = _finite(rawv)
                    entry['lbf'] = _finite(eng)
                    entry['units'] = 'lbf'
                channels.append(entry)

        if self.tc:
            values = self.tc.snapshot()
            if values:
                for ch, degf in enumerate(values):
                    rawv, eng, status = self.tc.convert(ch, degf)
                    channels.append({'card': 'tc', 'channel': ch, 'status': status,
                                     'raw': _finite(rawv), 'temp_f': _finite(eng),
                                     'tare': _finite(self.tc.tare[ch]),
                                     'units': 'degF', 'samples': [_finite(rawv)]})

        avg = sum(self.latency_ms) / len(self.latency_ms) if self.latency_ms else 0.0
        return {
            'type': 'data',
            'timestamp': now,
            'channels': channels,
            'performance': {
                'loop_index': self.loop_index,
                'sample_rate_hz': self.rate_hz,
                'avg_latency_ms': round(avg, 3),
                'restarts': dict(self.restarts),
            },
        }

    def handle_command(self, cmd):
        action = cmd.get('action')
        by_kind = {c.kind: c for c in self.cards}
        if self.tc:
            by_kind['tc'] = self.tc

        if action == 'tare':
            kind = cmd.get('card')
            channel = cmd.get('channel')
            clear = bool(cmd.get('clear'))
            targets = [by_kind[kind]] if kind in by_kind else list(by_kind.values())
            tared, skipped = [], []
            for card in targets:
                chans = [int(channel)] if channel is not None else range(card.count)
                for ch in chans:
                    label = '%s%d' % (card.kind, ch)
                    if clear:
                        card.tare[ch] = 0.0
                        tared.append(label)
                        continue
                    # Tare against the last raw value so the offset zeroes
                    # exactly what the operator is currently looking at. The
                    # existing offset is removed first, so taring twice in a
                    # row lands in the same place instead of stacking.
                    rawv = self._last_raw.get((card.kind, ch))
                    if rawv is None:
                        skipped.append(label)
                        continue
                    previous = card.tare[ch]
                    card.tare[ch] = 0.0
                    _, eng, status = card.convert(ch, rawv)
                    if status == 'ok' and eng is not None:
                        card.tare[ch] = eng
                        tared.append(label)
                    else:
                        # A channel reading 'disconnected' keeps the tare it
                        # already had. Silently zeroing it would quietly undo
                        # a good zero every time a wire was momentarily out.
                        card.tare[ch] = previous
                        skipped.append(label)
            emit({'type': 'ack', 'action': action, 'ok': not skipped,
                  'cleared': clear, 'tared': tared, 'skipped': skipped})

        elif action == 'set_cal_mode':
            card = by_kind.get(cmd.get('card'))
            if card is not None:
                meta = card.cfg.setdefault('channelMeta', {})
                entry = meta.setdefault(str(int(cmd.get('channel', 0))), {})
                entry['useAlt'] = bool(cmd.get('useAlt'))
            emit({'type': 'ack', 'action': action, 'ok': card is not None})

        elif action == 'shutdown':
            self.running = False

        else:
            emit({'type': 'ack', 'action': action, 'ok': False,
                  'error': 'unknown action "%s"' % action})

    def stdin_reader(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self.handle_command(json.loads(line))
            except Exception as exc:
                note('[daq] bad command %r: %s' % (line, exc))
        self.running = False

    def run(self):
        threading.Thread(target=self.stdin_reader, daemon=True).start()
        emit({'type': 'status', 'ok': True, 'message': 'streaming',
              'cards': [c.kind for c in self.cards] + (['tc'] if self.tc else [])})

        deadline = time.perf_counter()
        while self.running:
            began = time.perf_counter()
            frame = self.build_frame(time.time())
            for entry in frame['channels']:
                self._last_raw[(entry['card'], entry['channel'])] = entry['raw']
            emit(frame)

            self.latency_ms.append((time.perf_counter() - began) * 1000.0)
            if len(self.latency_ms) > 100:
                self.latency_ms.pop(0)
            self.loop_index += 1

            # Absolute deadline, resynced if we ever slip a whole period.
            deadline += self.period
            slack = deadline - time.perf_counter()
            if slack > 0:
                time.sleep(slack)
            elif slack < -self.period:
                deadline = time.perf_counter()

        self.shutdown()

    def shutdown(self):
        if self.tc:
            self.tc.stop()
        for card in self.cards + ([self.tc] if self.tc else []):
            try:
                card.task.stop()
                card.task.close()
            except Exception:
                pass


def _finite(v):
    """JSON has no NaN/Infinity; send null so the consumer sees 'no reading'."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else '{}'
    try:
        cfg = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit({'type': 'status', 'ok': False, 'message': 'bad config: %s' % exc})
        return 2

    if nidaqmx is None:
        emit({'type': 'status', 'ok': False,
              'message': 'nidaqmx not installed (pip install nidaqmx, plus the '
                         'NI-DAQmx Runtime)'})
        return 3

    streamer = Streamer(cfg)
    try:
        streamer.start()
        streamer.run()
    except KeyboardInterrupt:
        streamer.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())

