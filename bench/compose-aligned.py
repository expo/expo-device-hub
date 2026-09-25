#!/usr/bin/env python3
"""Side-by-side composition with every scripted input on the same output frame in every pane.

compose-aligned.py [--touches] OUT.mp4 base1 base2 ...

Each recording (base.h264 + base.json from record-fork.mjs) carries `marks`, the recording frame on
which each input's pointerdown landed, and `plan`, the scheduled time of each input (ms) plus the end.
The output timeline follows the plan: segment k runs from input k to input k+1 and each pane's segment
is trimmed or padded (holding its last frame) to the planned length. Within a segment every pane plays
in real time, so each mode's reaction delay after the input stays visible.

--touches draws a finger dot where and when each input was sent (taps, and swipes as a moving dot), from
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
    here = os.path.dirname(os.path.abspath(__file__))
    ops = [s for s in json.load(open(os.path.join(here, "route-fork.json"))) if s["op"] != "wait"]
    dot = "/tmp/touch-dot.png"
    r = DOT // 2
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color=black@0:s={DOT}x{DOT},format=rgba",
                    "-vf", f"geq=r=255:g=255:b=255:a='if(lt(hypot(X-{r},Y-{r}),{r - 8}),120,if(lt(hypot(X-{r},Y-{r}),{r - 2}),235,0))'",
                    "-frames:v", "1", dot], check=True)
    inputs += ["-loop", "1", "-framerate", str(FPS), "-i", dot]
    dot_input = len(bases)
    graph.append(f"[{dot_input}:v]split={len(bases) * len(ops)}" +
                 "".join(f"[d{i}_{k}]" for i in range(len(bases)) for k in range(len(ops))))
    px = lambda fx: round(fx * PANE_W) - r
    py = lambda fy: BAND + round(fy * SCREEN_H) - r
    for i in range(len(bases)):
        label = f"v{i}"
        for k, op in enumerate(ops):
            t0 = (LEAD_IN + target[k] - target[0]) / FPS
            if op["op"] == "tap":
                x, y, end = str(px(op["x"])), str(py(op["y"])), t0 + 0.25
            else:
                u = f"clip((t-{t0:.4f})/0.24,0,1)"
                x = f"{px(op['x0'])}+({px(op['x1']) - px(op['x0'])})*{u}"
                y = f"{py(op['y0'])}+({py(op['y1']) - py(op['y0'])})*{u}"
                end = t0 + 0.24 + 0.15
            graph.append(f"[{label}][d{i}_{k}]overlay=x='{x}':y='{y}':shortest=1:enable='between(t,{t0:.4f},{end:.4f})'[t{i}_{k}]")
            label = f"t{i}_{k}"
        stacked[i] = f"[{label}]"
graph.append("".join(stacked) + f"hstack=inputs={len(bases)},format=yuv420p[o]")

subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(graph),
                "-map", "[o]", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-r", str(FPS),
                "-movflags", "+faststart", out], check=True)
print(out)
