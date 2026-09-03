"""Quick plot of a reorganized waterflow CSV: LOX vs Fuel PTs, paired by station.

    python plot_waterflow.py [csv] [t_start] [t_end]

t_start/t_end are elapsed seconds; a negative t_start counts back from the end
of the run, so `-20` plots the last 20 seconds.
"""
import sys
import pandas as pd
import matplotlib.pyplot as plt

CSV = sys.argv[1] if len(sys.argv) > 1 else "data/Waterflow_2238.csv"
T0 = float(sys.argv[2]) if len(sys.argv) > 2 else None
T1 = float(sys.argv[3]) if len(sys.argv) > 3 else None

# (panel title, [(column, legend label, color), ...])
PANELS = [
    ("GN2 Supply", [
        ("PT1 LOX GN2 (psi)", "PT1 LOX", "tab:blue"),
        ("PT11 Fuel GN2 (psi)", "PT11 Fuel", "tab:red"),
    ]),
    ("Tank Upstream", [
        ("PT3 LOX Tank Upstream (psi)", "PT3 LOX", "tab:blue"),
        ("PT13 Fuel Tank Upstream (psi)", "PT13 Fuel", "tab:red"),
    ]),
    ("Tank Downstream", [
        ("PT4 LOX Tank Downstream (psi)", "PT4 LOX", "tab:blue"),
        ("PT14 Fuel Tank Downstream (psi)", "PT14 Fuel", "tab:red"),
    ]),
    ("Manifold", [
        ("PT5 LOX Manifold (psi)", "PT5 LOX", "tab:blue"),
        ("PT15 Fuel Engine Manifold (psi)", "PT15 Fuel", "tab:red"),
    ]),
    ("Venturi Inlet", [
        ("PT21 LOX Venturi Inlet (psi)", "PT21 LOX", "tab:blue"),
        ("PT24 Fuel Venturi Inlet (psi)", "PT24 Fuel", "tab:red"),
    ]),
    ("Venturi Throat", [
        ("PT22 LOX Venturi Throat (psi)", "PT22 LOX", "tab:blue"),
        ("PT23 Fuel Venturi Throat (psi)", "PT23 Fuel", "tab:red"),
    ]),
]

df = pd.read_csv(CSV)

# Window the data before plotting so each panel autoscales to what is shown.
t_end = df["elapsed_s"].iloc[-1]
lo = t_end + T0 if (T0 is not None and T0 < 0) else T0
hi = T1
if lo is not None:
    df = df[df["elapsed_s"] >= lo]
if hi is not None:
    df = df[df["elapsed_s"] <= hi]
t = df["elapsed_s"]

fig, axes = plt.subplots(3, 2, figsize=(14, 9), sharex=True)
for ax, (title, series) in zip(axes.flat, PANELS):
    for col, label, color in series:
        ax.plot(t, df[col], color=color, lw=0.8, label=label)
    ax.set_title(title, fontsize=10)
    ax.set_ylabel("psi")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8, loc="upper right")

for ax in axes[-1]:
    ax.set_xlabel("elapsed (s)")

name = CSV.split("/")[-1]
span = "" if lo is None and hi is None else f"  [{t.iloc[0]:.1f}–{t.iloc[-1]:.1f} s]"
fig.suptitle(name + span, fontsize=12)
fig.tight_layout()
out = CSV.rsplit(".", 1)[0] + ("_PTs.png" if not span else "_PTs_zoom.png")
fig.savefig(out, dpi=120)
print("wrote", out)
