"""Quick plot of a Draco run CSV: LOX vs Fuel PTs paired by station, plus
chamber pressure and thrust when the log has them.

    python plot_waterflow.py [csv] [t_start] [t_end]

t_start/t_end are elapsed seconds; a negative t_start counts back from the end
of the run, so `-20` plots the last 20 seconds. With no window the script zooms
to the firing window (first runline open through the following shutdown/abort)
if it can find one, otherwise it plots the whole run.
"""
import re
import sys
import pandas as pd
import matplotlib.pyplot as plt

CSV = sys.argv[1] if len(sys.argv) > 1 else "data/Draco_20260911_124919_hotfire.csv"
T0 = float(sys.argv[2]) if len(sys.argv) > 2 else None
T1 = float(sys.argv[3]) if len(sys.argv) > 3 else None

# (panel title, [(column, legend label, color), ...])
PANELS = [
    ("GN2 Supply", [
        ("PT1 LOX GN2 (psi)", "PT1 LOX", "tab:blue"),
        ("PT11 Fuel GN2 (psi)", "PT11 Fuel", "tab:red"),
    ]),
    ("Tank Upstream", [
        ("PT2 LOX Upstream (psi)", "PT2 LOX", "tab:blue"),
        ("PT12 Fuel Upstream (psi)", "PT12 Fuel", "tab:red"),
    ]),
    ("Tank Downstream", [
        ("PT4 LOX Tank Downstream (psi)", "PT4 LOX", "tab:blue"),
        ("PT14 Fuel Tank Downstream (psi)", "PT14 Fuel", "tab:red"),
    ]),
    # Chamber rides along with the manifolds so injector dP is readable at a glance.
    ("Manifold + Chamber", [
        ("PT5 LOX Manifold (psi)", "PT5 LOX", "tab:blue"),
        ("PT15 Fuel Engine Manifold (psi)", "PT15 Fuel", "tab:red"),
        ("PT0 Chamber (psi)", "PT0 Chamber", "tab:purple"),
    ]),
    ("Venturi Inlet", [
        ("PT21 LOX Venturi Inlet (psi)", "PT21 LOX", "tab:blue"),
        ("PT23 Fuel Venturi Inlet (psi)", "PT23 Fuel", "tab:red"),
    ]),
    ("Venturi Throat", [
        ("PT22 LOX Venturi Throat (psi)", "PT22 LOX", "tab:blue"),
        ("PT24 Fuel Venturi Throat (psi)", "PT24 Fuel", "tab:red"),
    ]),
    ("Thrust", [
        ("Thrust Combined (lbf)", "Combined", "tab:green"),
        ("LC1 TLCA (lbf)", "LC1", "tab:gray"),
        ("LC2 TLCB (lbf)", "LC2", "tab:olive"),
        ("LC3 TLCC (lbf)", "LC3", "tab:cyan"),
    ]),
]

# Event lines worth drawing: (regex on the event text, color, short label).
MARKS = [
    (r"MV-LOX .*-> OPEN", "tab:blue", "MV-LOX open"),
    (r"MV-F \(.*-> OPEN", "tab:red", "MV-F open"),
    (r"\[abort\]", "black", "ABORT"),
    (r"SEQUENCE START: HOT ?FIRE", "tab:orange", "seq start"),
]

df = pd.read_csv(CSV)

# Older waterflow logs lack the chamber/thrust/venturi channels; drop whatever
# this file does not carry so one script covers every run.
panels = [(title, [s for s in series if s[0] in df.columns]) for title, series in PANELS]
panels = [p for p in panels if p[1]]

events = (
    df.loc[df["event"].notna(), ["elapsed_s", "event"]].astype({"event": str})
    if "event" in df.columns
    else pd.DataFrame(columns=["elapsed_s", "event"])
)
marks = [
    (t, color, label)
    for pattern, color, label in MARKS
    for t in events.loc[events["event"].str.contains(pattern, regex=True), "elapsed_s"]
]

# Window the data before plotting so each panel autoscales to what is shown.
t_end = df["elapsed_s"].iloc[-1]
lo = t_end + T0 if (T0 is not None and T0 < 0) else T0
hi = T1
if lo is None and hi is None and marks:
    # Auto-zoom around the fire: 5 s of lead-in, 10 s of tail past the last mark.
    lo = max(0.0, min(t for t, _, _ in marks) - 5)
    hi = min(t_end, max(t for t, _, _ in marks) + 10)
if lo is not None:
    df = df[df["elapsed_s"] >= lo]
if hi is not None:
    df = df[df["elapsed_s"] <= hi]
t = df["elapsed_s"]

rows = -(-len(panels) // 2)
fig, axes = plt.subplots(rows, 2, figsize=(14, 3 * rows), sharex=True, squeeze=False)
for ax, (title, series) in zip(axes.flat, panels):
    for col, label, color in series:
        ax.plot(t, df[col], color=color, lw=0.8, label=label)
    for mt, mcolor, mlabel in marks:
        if t.iloc[0] <= mt <= t.iloc[-1]:
            ax.axvline(mt, color=mcolor, ls="--", lw=0.7, alpha=0.6)
    ax.set_title(title, fontsize=10)
    ax.set_ylabel("lbf" if "(lbf)" in series[0][0] else "psi")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8, loc="upper right")

for ax in axes.flat[len(panels):]:
    ax.axis("off")
# Label the lowest *used* axis in each column; a trailing blank cell would
# otherwise leave its column's last plot without tick labels.
for col in range(axes.shape[1]):
    used = [r for r in range(rows) if r * 2 + col < len(panels)]
    if used:
        ax = axes[used[-1]][col]
        ax.set_xlabel("elapsed (s)")
        ax.tick_params(labelbottom=True)

name = CSV.replace("\\", "/").split("/")[-1]
span = "" if T0 is None and T1 is None and not marks else f"  [{t.iloc[0]:.1f}-{t.iloc[-1]:.1f} s]"
if marks:
    seen = [
        f"{mlabel} @ {mt:.2f}s"
        for mt, _, mlabel in sorted(marks)
        if t.iloc[0] <= mt <= t.iloc[-1]
    ]
    span += "   " + " | ".join(seen[:6])
fig.suptitle(name + span, fontsize=11)
fig.tight_layout()
out = CSV.rsplit(".", 1)[0] + ("_PTs.png" if not span else "_PTs_zoom.png")
fig.savefig(out, dpi=120)
print("wrote", out)
