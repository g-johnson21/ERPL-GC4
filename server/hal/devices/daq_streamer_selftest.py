"""Self-test for the NI-DAQ sidecar's tare path. No hardware, no NI-DAQmx.

    python server/hal/devices/daq_streamer_selftest.py

Run from daq_streamer.test.js so it rides along with `npm test`, and skipped
there when the host has no Python.

WHY THIS EXISTS
    Tare against real hardware was broken for every PT channel and no test in
    the repo could see it. The sidecar is a separate process that the Node
    suite never starts, and the simulator implements its own tareSensors(), so
    the whole card -> convert -> tare path had no coverage on either side.

    The bug: build_frame stored convert()'s RETURN value as the latest raw
    sample, and tare fed that back into convert(). For LC and TC those units
    match and it round-tripped fine. PtCard takes amps and returns milliamps,
    so a healthy 12 mA channel came back as 12 A, tripped the >25 mA
    disconnected guard, and was refused -- while the stand had already logged
    the tare as successful.

    So the property under test is not "tare works" but "the value stashed for
    tare is in the units convert() accepts", asserted per card.
"""
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import daq_streamer as d  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want or (
        isinstance(got, float) and isinstance(want, float)
        and math.isclose(got, want, rel_tol=1e-9, abs_tol=1e-9)
    )
    if not ok:
        FAILURES.append('%s: got %r, want %r' % (label, got, want))
    print('%s %s' % ('ok  ' if ok else 'FAIL', label))


def streamer(cards=(), tc=None, samples=None):
    """A Streamer whose only stub is the DAQmx read.

    `_last_raw` is deliberately NOT populated by hand. The bug this file exists
    for lived in build_frame, so a test that seeds _last_raw itself asserts
    nothing: the first version of this file did exactly that and passed against
    the buggy code. Everything here goes through build_frame, so the stashed
    value is whatever the real path stashes.

    `samples` maps card kind -> per-channel sample lists, in the card's native
    DAQmx units (amps for PT, V/V for LC).
    """
    st = d.Streamer.__new__(d.Streamer)
    st.cards = list(cards)
    st.tc = tc
    st._last_raw = {}
    st.misses = defaultdict(int)
    st.restarts = defaultdict(int)
    st.latency_ms = []
    st.loop_index = 0
    st.rate_hz = 100.0
    st.read_card = lambda card: (samples or {}).get(card.kind)
    return st


def frame(st):
    """One acquisition cycle, exactly as run() drives it."""
    return st.build_frame(0.0)


def pt_samples(overrides, count=16, default=0.012):
    """DAQmx shape for a PT read: [channel][sample], in AMPS.

    Unlisted channels sit at a healthy mid-scale reading, so a test that cares
    about one channel does not accidentally depend on the others being broken.
    """
    return [[overrides.get(ch, default)] for ch in range(count)]


def pt_card(meta):
    card = d.PtCard.__new__(d.PtCard)
    card.cfg = {'channelMeta': meta}
    card.tare = defaultdict(float)
    card.count = 16
    return card


def lc_card(meta):
    card = d.LcCard.__new__(d.LcCard)
    card.cfg = {'channelMeta': meta}
    card.tare = defaultdict(float)
    card.count = 4
    return card


def acks():
    """Capture what the sidecar would have written to stdout."""
    out = []
    d.emit = lambda obj: out.append(obj)
    return out


# --- the regression itself ---------------------------------------------------

def test_pt_tare_zeroes_a_healthy_channel():
    card = pt_card({'2': {'maxPsi': 10000.0, 'zeroMa': 4.0}})
    amps = 0.012                                  # 12 mA, mid-scale and healthy
    st = streamer([card], samples={'pt': pt_samples({2: amps})})
    frame(st)                                     # the real acquisition path

    check('PT reads before tare', card.convert(2, amps)[1], 5000.0)

    out = acks()
    st.handle_command({'action': 'tare', 'card': 'pt', 'channel': 2})
    check('PT tare accepted', out[-1]['skipped'], [])
    check('PT tare reports the channel', out[-1]['tared'], ['pt2'])
    check('PT reads zero after tare', card.convert(2, amps)[1], 0.0)


def test_pt_tare_does_not_stack():
    card = pt_card({'2': {'maxPsi': 10000.0, 'zeroMa': 4.0}})
    st = streamer([card], samples={'pt': pt_samples({2: 0.012})})
    frame(st)
    acks()
    st.handle_command({'action': 'tare', 'card': 'pt', 'channel': 2})
    frame(st)                                     # the board keeps streaming
    st.handle_command({'action': 'tare', 'card': 'pt', 'channel': 2})
    check('taring twice lands in the same place', card.tare[2], 5000.0)
    check('and still reads zero', card.convert(2, 0.012)[1], 0.0)


def test_clear_restores_the_real_reading():
    card = pt_card({'2': {'maxPsi': 10000.0, 'zeroMa': 4.0}})
    st = streamer([card], samples={'pt': pt_samples({2: 0.012})})
    frame(st)
    acks()
    st.handle_command({'action': 'tare', 'card': 'pt', 'channel': 2})
    st.handle_command({'action': 'tare', 'card': 'pt', 'channel': 2, 'clear': True})
    check('clear removes the offset', card.tare[2], 0.0)
    check('and the reading comes back', card.convert(2, 0.012)[1], 5000.0)


def test_a_dead_channel_is_still_refused():
    # The guard has to keep working. A broken 4-20 mA loop reads near zero, and
    # zeroing against that would bake a bogus offset into a channel that is
    # simply not connected.
    card = pt_card({'3': {'maxPsi': 1500.0, 'zeroMa': 4.0}})
    st = streamer([card], samples={'pt': pt_samples({3: 0.0005})})  # 0.5 mA: loop open
    frame(st)
    out = acks()
    st.handle_command({'action': 'tare', 'card': 'pt', 'channel': 3})
    check('dead channel refused', out[-1]['skipped'], ['pt3'])
    check('dead channel not silently zeroed', card.tare[3], 0.0)


def test_a_dead_channel_keeps_the_tare_it_had():
    card = pt_card({'3': {'maxPsi': 1500.0, 'zeroMa': 4.0}})
    st = streamer([card], samples={'pt': pt_samples({3: 0.0005})})
    card.tare[3] = 42.0                           # a good zero, taken earlier
    frame(st)
    acks()
    st.handle_command({'action': 'tare', 'card': 'pt', 'channel': 3})
    check('a momentary dropout does not undo a good zero', card.tare[3], 42.0)


def test_a_channel_never_sampled_is_refused():
    card = pt_card({'5': {'maxPsi': 1500.0, 'zeroMa': 4.0}})
    st = streamer([card])                          # _last_raw empty
    out = acks()
    st.handle_command({'action': 'tare', 'card': 'pt', 'channel': 5})
    check('never-sampled channel refused', out[-1]['skipped'], ['pt5'])


def test_lc_tare_still_works():
    # LC round-tripped even with the bug, because its convert() returns the
    # units it takes. It is here so a future change to _last_raw cannot fix PT
    # by breaking this.
    card = lc_card({'0': {'slope': 1000.0, 'offset': 0.0}})
    st = streamer([card], samples={'lc': [[0.002]] * 4})   # V/V
    frame(st)
    out = acks()
    st.handle_command({'action': 'tare', 'card': 'lc', 'channel': 0})
    check('LC tare accepted', out[-1]['skipped'], [])
    check('LC reads zero after tare', card.convert(0, 0.002)[1], 0.0)


def test_every_card_stashes_what_its_convert_accepts():
    # THE invariant the bug violated, stated directly and checked against what
    # the real path actually stored: the value build_frame stashes must be a
    # legal ARGUMENT to that card's convert(), never one of its return values.
    #
    # This is the assertion that fails if the bug comes back. Every other test
    # in this file would still pass if _last_raw were seeded by hand, which is
    # exactly how the first draft of this file managed to pass against the
    # broken code.
    pt = pt_card({'0': {'maxPsi': 1000.0, 'zeroMa': 4.0}})
    lc = lc_card({'0': {'slope': 1000.0, 'offset': 0.0}})
    st = streamer([pt, lc], samples={'pt': pt_samples({0: 0.012}),
                                     'lc': [[0.002]] * 4})
    frame(st)

    for card in (pt, lc):
        stashed = st._last_raw.get((card.kind, 0))
        check('%s: build_frame stashed a sample' % card.kind, stashed is not None, True)
        # Fed back exactly as the tare handler feeds it.
        _, eng, status = card.convert(0, stashed)
        check('%s: the stashed value re-converts cleanly' % card.kind, status, 'ok')
        check('%s: and yields a real value' % card.kind, eng is not None, True)


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
    if FAILURES:
        print('\n%d failure(s):' % len(FAILURES))
        for f in FAILURES:
            print('  ' + f)
        return 1
    print('\nall sidecar tare checks passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
