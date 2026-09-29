#!/usr/bin/env python3
"""Side-by-side composition with every scripted input on the same output frame in every pane.

compose-aligned.py [--touches] OUT.mp4 base1 base2 ...

Each recording (base.h264 + base.json from record-fork.mjs) carries `marks`, the recording frame on
which each input's pointerdown landed, and `plan`, the scheduled time of each input (ms) plus the end.
The output timeline follows the plan: segment k runs from input k to input k+1 and each pane's segment
is trimmed or padded (holding its last frame) to the planned length. Within a segment every pane plays
in real time, so each mode's reaction delay after the input stays visible.

--touches (ROUTE=route file, default route-fork.json) draws a finger dot where and when each input was sent (taps, and swipes as a moving dot), from
route-fork.json, identically on every pane: the gap between the dot and each pane's response is that
mode's input-to-display delay.
"""
import json
import os
import subprocess
import sys

FPS = 60
LEAD_IN = 60  # frames before the first input

args = sys.argv[1:]
touches = "--touches" in args
args = [a for a in args if a != "--touches"]
out, bases = args[0], args[1:]
# Pane geometry from record-fork.mjs: 804 wide, a 96 px caption band above the 804x1748 screen.
PANE_W, BAND, SCREEN_H, DOT = 804, 96, 1748, 84
recs = [json.load(open(f"{b}.json")) for b in bases]
plan = recs[0]["plan"]
steps = len(plan) - 1
for b, r in zip(bases, recs):
    if len(r["marks"]) != steps:
        sys.exit(f"{b}: {len(r['marks'])} input marks, expected {steps}")

target = [round(ms * FPS / 1000) for ms in plan]
lengths = [target[k + 1] - target[k] for k in range(steps)]

inputs, graph, stacked = [], [], []
for i, (b, r) in enumerate(zip(bases, recs)):
    inputs += ["-r", str(FPS), "-i", f"{b}.h264"]
    marks = r["marks"]
    segments = [(marks[0] - LEAD_IN, marks[0], LEAD_IN)]
    for k in range(steps):
        start = marks[k]
        end = marks[k + 1] if k + 1 < steps else min(start + lengths[k], r["frames"])
        segments.append((start, min(end, start + lengths[k]), lengths[k]))
    drift = [marks[k] - marks[0] - (target[k] - target[0]) for k in range(steps)]
    print(f"{r['label']}: input drift vs plan {min(drift)}..{max(drift)} frames")
    names = [f"s{i}_{j}" for j in range(len(segments))]
    graph.append(f"[{i}:v]split={len(segments)}" + "".join(f"[{n}in]" for n in names))
    for n, (a, e, length) in zip(names, segments):
        pad = max(0, length - (e - a))
        graph.append(f"[{n}in]trim=start_frame={a}:end_frame={e},setpts=PTS-STARTPTS,"
                     f"tpad=stop_mode=clone:stop={pad}[{n}]")
    graph.append("".join(f"[{n}]" for n in names) + f"concat=n={len(names)}:v=1:a=0[v{i}]")
    stacked.append(f"[v{i}]")
if touches:
    # One transparent video of the finger, drawn frame by frame from the route and the plan, laid
    # over every pane: taps (a quarter second), swipes and arbitrary paths (flings, jiggles, zooms).
    here = os.path.dirname(os.path.abspath(__file__))
    ops = [s for s in json.load(open(os.path.join(here, os.environ.get("ROUTE", "route-fork.json")))) if s["op"] != "wait"]
    track = "/tmp/touch-track.mov"
    total = LEAD_IN + target[-1] - target[0]
    def where(op, ms):
        """Finger position ms into an op, or None once it has lifted."""
        if op["op"] == "tap":
            return (op["x"], op["y"]) if ms <= 250 else None
        if op["op"] == "swipe":
            if ms > 240 + 150: return None
            u = min(1, ms / 240)
            return (op["x0"] + (op["x1"] - op["x0"]) * u, op["y0"] + (op["y1"] - op["y0"]) * u)
        pts = op["pts"]
        if ms > pts[-1][0] + 150: return None
        for (t0, x0, y0), (t1, x1, y1) in zip(pts, pts[1:]):
            if ms <= t1:
                u = 0 if t1 == t0 else max(0, (ms - t0) / (t1 - t0))
                return (x0 + (x1 - x0) * u, y0 + (y1 - y0) * u)
        return (pts[-1][1], pts[-1][2])
    from PIL import Image, ImageDraw
    r = DOT // 2
    enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
                            "-s", f"{PANE_W}x{BAND + SCREEN_H}", "-r", str(FPS), "-i", "-", "-c:v", "qtrle", track],
                           stdin=subprocess.PIPE)
    starts = [(LEAD_IN + target[k] - target[0]) for k in range(len(ops))]
    blank = Image.new("RGBA", (PANE_W, BAND + SCREEN_H), (0, 0, 0, 0)).tobytes()
    for f in range(total):
        img = None
        for op, st in zip(ops, starts):
            if f < st: continue
            p = where(op, (f - st) * 1000 / FPS)
            if p is None: continue
            img = img or Image.new("RGBA", (PANE_W, BAND + SCREEN_H), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            cx, cy = round(p[0] * PANE_W), BAND + round(p[1] * SCREEN_H)
            d.ellipse([cx - r + 2, cy - r + 2, cx + r - 2, cy + r - 2], fill=(255, 255, 255, 235))
            d.ellipse([cx - r + 8, cy - r + 8, cx + r - 8, cy + r - 8], fill=(255, 255, 255, 120))
        enc.stdin.write(img.tobytes() if img else blank)
    enc.stdin.close(); enc.wait()
    inputs += ["-i", track]
    graph.append(f"[{len(bases)}:v]split={len(bases)}" + "".join(f"[d{i}]" for i in range(len(bases))))
    for i in range(len(bases)):
        graph.append(f"[v{i}][d{i}]overlay=0:0:shortest=0:eof_action=pass[t{i}]")
        stacked[i] = f"[t{i}]"
cols = int(os.environ.get("GRID", len(bases)))
if cols >= len(bases):
    graph.append("".join(stacked) + f"hstack=inputs={len(bases)},format=yuv420p[o]")
else:
    H = BAND + SCREEN_H
    layout = "|".join(f"{(i % cols) * PANE_W}_{(i // cols) * H}" for i in range(len(bases)))
    graph.append("".join(stacked) + f"xstack=inputs={len(bases)}:layout={layout}:fill=black,format=yuv420p[o]")

subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(graph),
                "-map", "[o]", *(["-c:v", "hevc_videotoolbox", "-b:v", os.environ.get("BITRATE", "60M"), "-tag:v", "hvc1"]
                   if os.environ.get("ENC") == "hevc" else ["-c:v", "libx264", "-preset", "slow", "-crf", "16"]), "-r", str(FPS),
                "-movflags", "+faststart", out], check=True)
print(out)
