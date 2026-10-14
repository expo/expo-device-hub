# How often each recording shows a new picture while the finger moves, per gesture.
#   python3 newpic.py [--json out.json] six-1.h264 six-2.h264 ...   (each with its .json beside it)
# Uses the route (ROUTE, default route-maps.json) for gesture kinds and durations, and the
# recorder's marks (page-side pointerdown, in recorder frames) for where each gesture starts.
# A frame is new when the screen area differs from the previous frame by more than THR (mean
# absolute luma difference, 0-255, at quarter size). The recorder's own H.264 leaves ~0.0-0.3 of
# refinement on repeated frames; pans change ~10 per new picture, and fling momentum decays from ~4
# to below the threshold as the map slows (under ~1 px per frame).
# Windows start at the first change after each press (so each pane's latency cancels) and last as
# long as the finger moves; for flings, "momentum" is the half second after the finger lifts.
import json, os, subprocess, sys
import numpy as np

THR = float(os.environ.get("THR", 0.4))
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
out_json = None
if args[:1] == ["--json"]: out_json, args = args[1], args[2:]
ops = [s for s in json.load(open(os.environ.get("ROUTE", os.path.join(here, "route-maps.json")))) if s["op"] != "wait"]

def diffs(src):
    W, H = 201, 437
    raw = subprocess.run(["ffmpeg", "-v", "error", "-r", "60", "-i", src, "-vf",
                          f"crop=804:1748:0:96,scale={W}:{H}:flags=area,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    f = np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.int16)
    return np.concatenate([[0.0], np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))])

def moving_ms(op):
    """How long the finger moves: up to the last point that differs from the one before it."""
    pts = op["pts"]
    return max((t for (t, x, y), (_, px, py) in zip(pts[1:], pts) if (x, y) != (px, py)), default=0)

def rate(d, a, b):
    return None if b <= a else round(float((d[a:b] > THR).sum()) * 60 / (b - a), 1)

def stall(d, a, b):
    """The longest stretch (ms) with no new picture in frames a..b."""
    longest = run = 0
    for x in d[a:b] > THR:
        run = 0 if x else run + 1; longest = max(longest, run)
    return round(longest * 1000 / 60)

results = {}
for src in args:
    meta = json.load(open(src.rsplit(".", 1)[0] + ".json"))
    d, marks = diffs(src), meta["marks"]
    rows = {}
    if len(marks) != len(ops):
        print(f"{src}: {len(marks)} presses for {len(ops)} route inputs; windows may be off", file=sys.stderr)
    for k, (op, mark) in enumerate(zip(ops, marks)):
        kind = op.get("kind")
        if kind not in ("pan", "zoom", "jiggle", "fling"): continue
        nxt = marks[k + 1] if k + 1 < len(marks) else len(d)
        hits = np.nonzero(d[mark:min(nxt, mark + 30)] > THR)[0]
        if not len(hits):
            rows.setdefault(kind, []).append({"k": k, "response": None}); continue
        first = mark + int(hits[0]); move = round(moving_ms(op) * 60 / 1000)
        row = {"k": k, "response": int(hits[0]), "drag": rate(d, first, first + move), "stall": stall(d, first, first + move)}
        if meta.get("moves") is not None and move:
            # Pointermoves the page received while the finger moved (recorded from the same press).
            got = [c for f, c in meta["moves"] if mark <= f < mark + move]
            row["input"] = round(len(got) * 60 / move, 1)
            row["coalesced"] = round(sum(got) / len(got), 2) if got else None
        if kind == "fling":
            a = first + move; b = min(nxt, a + 30)
            row["momentum"] = rate(d, a, b)
            row["stall"] = max(row["stall"], stall(d, a, a + 15))  # the first quarter second of momentum
            row["energy"] = round(float(d[a:nxt].sum()), 1)  # total picture change after the lift
        rows.setdefault(kind, []).append(row)
    mean = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    summary = {
        "pan": mean([r["drag"] for r in rows.get("pan", []) if r.get("drag") is not None]),
        "zoom": mean([r["drag"] for r in rows.get("zoom", []) if r.get("drag") is not None]),
        "jiggle": mean([r["drag"] for r in rows.get("jiggle", []) if r.get("drag") is not None]),
    }
    # Zooms are left out: Maps stops zooming at the whole-earth view, so their stills are the app's.
    stalls = [r["stall"] for kind, rs in rows.items() if kind != "zoom" for r in rs if r.get("stall") is not None]
    summary["worst stall"] = max(stalls) if stalls else None       # ms, while the picture should move
    summary["stalls >100 ms"] = sum(x > 100 for x in stalls)
    for kind in ("pan", "zoom", "jiggle"):
        summary["input " + kind] = mean([r["input"] for r in rows.get(kind, []) if r.get("input") is not None])
    if meta.get("dispatch"): summary["dispatch"] = meta["dispatch"]
    for name, r in zip(("fling L", "fling R", "fling L2", "final fling"), rows.get("fling", [])):
        summary[name] = r.get("momentum")
        summary[name + " energy"] = r.get("energy")
    results[os.path.basename(src)] = {"summary": summary, "rows": rows}

names = [n for n in next(iter(results.values()))["summary"] if "energy" not in n and not n.startswith(("input", "dispatch", "worst", "stalls"))] if results else []
print(f"new pictures per second (THR {THR}); fling columns are the half second after the lift")
print(f"{'':12}" + "".join(f"{n:>13}" for n in names))
for src, r in results.items():
    print(f"{src:12}" + "".join(f"{'-' if r['summary'][n] is None else r['summary'][n]:>13}" for n in names))
print("longest stretch with no new picture while it should move (ms) / gestures with one over 100 ms:")
for src, r in results.items():
    print(f"{src:12}{r['summary']['worst stall']:>13}{r['summary']['stalls >100 ms']:>13}")
print("picture change after the lift (sum of per-frame differences):")
for src, r in results.items():
    print(f"{src:12}" + "".join(f"{str(r['summary'].get(n + ' energy', '-')):>13}" for n in names if n.startswith(("fling", "final"))))
if any(r["summary"].get("input pan") is not None for r in results.values()):
    print("pointermoves per second at the page while the finger moves; recorder dispatch lateness p95 / CDP call p95 (ms):")
    for src, r in results.items():
        sm = r["summary"]; dp = sm.get("dispatch") or {}
        print(f"{src:12}" + "".join(f"{str(sm.get('input ' + k)):>13}" for k in ("pan", "zoom", "jiggle")) + f"   late {dp.get('lateP95')} / call {dp.get('callP95')}")
if out_json: json.dump(results, open(out_json, "w"), indent=1)
