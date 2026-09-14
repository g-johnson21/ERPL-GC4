"""Plot the LOX Dragon thermocouple (TC3) from a Draco run CSV.

    python plot_dragon_temp.py [csv] [t_start] [t_end]

Top panel is the whole run, bottom panel zooms to the firing window (or to the
t_start/t_end window if given). Other LOX-side TCs are drawn faintly for
context.
"""
import sys
import pandas as pd
import matplotlib.pyplot as plt

CSV = sys.argv[1] if len(sys.argv) > 1 else "data/Draco_20260911_124919_hotfire.csv"
T0 = float(sys.argv[2]) if len(sys.argv) > 2 else None
T1 = float(sys.argv[3]) if len(sys.argv) > 3 else None

MAIN = ("TC3 Dragon (degF)", "TC3 Dragon", "tab:orange", 1.4, 1.0)
CONTEXT = [
    ("TC1 LOX Tank Bottom (degF)", "TC1 LOX Tank Bottom", "tab:blue", 0.8, 0.45),
    ("TC2 LOX Tank Top (degF)", "TC2 LOX Tank Top", "tab:cyan", 0.8, 0.45),
    ("TC4 Venturi (degF)", "TC4 Venturi", "tab:green", 0.8, 0.45),
]

MARKS = [
    (r"MV-LOX .*-> OPEN", "tab:blue", "MV-LOX open"),
    (r"MV-F \(.*-> OPEN", "tab:red", "MV-F open"),
    (r"\[abort\]", "black", "ABORT"),
]

df = pd.read_csv(CSV)
series = [MAIN] + [c for c in CONTEXT if c[0] in df.columns]

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

t_end = df["elapsed_s"].iloc[-1]
lo = t_end + T0 if (T0 is not None and T0 < 0) else T0
hi = T1
if lo is None and hi is None and marks:
    lo = max(0.0, min(t for t, _, _ in marks) - 5)
    hi = min(t_end, max(t for t, _, _ in marks) + 20)

zoom = df
if lo is not None:
    zoom = zoom[zoom["elapsed_s"] >= lo]
if hi is not None:
    zoom = zoom[zoom["elapsed_s"] <= hi]

fig, axes = plt.subplots(2, 1, figsize=(12, 7))
for ax, data, title in (
    (axes[0], df, "full run"),
    (axes[1], zoom, f"firing window [{zoom['elapsed_s'].iloc[0]:.1f}-{zoom['elapsed_s'].iloc[-1]:.1f} s]"),
):
    t = data["elapsed_s"]
    for col, label, color, lw, alpha in series:
        ax.plot(t, data[col], color=color, lw=lw, alpha=alpha, label=label)
    for mt, mcolor, mlabel in marks:
        if t.iloc[0] <= mt <= t.iloc[-1]:
            ax.axvline(mt, color=mcolor, ls="--", lw=0.7, alpha=0.6)
            ax.annotate(
                mlabel, xy=(mt, 1.0), xycoords=("data", "axes fraction"),
                xytext=(2, -10), textcoords="offset points",
                fontsize=7, color=mcolor, rotation=90, va="top",
            )
    ax.set_title(title, fontsize=10)
    ax.set_ylabel("degF")
    ax.set_xlabel("elapsed (s)")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8, loc="lower left")

name = CSV.replace("\\", "/").split("/")[-1]
fig.suptitle(f"LOX Dragon temperature - {name}", fontsize=12)
fig.tight_layout()
out = CSV.rsplit(".", 1)[0] + "_dragon_temp.png"
fig.savefig(out, dpi=120)
print("wrote", out)
