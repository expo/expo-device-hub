#!/usr/bin/env python3
"""Side-by-side composition with every scripted input on the same output frame in every pane.

compose-aligned.py OUT.mp4 base1 base2 ...

Each recording (base.h264 + base.json from record-fork.mjs) carries `marks`, the recording frame on
which each input's pointerdown landed, and `plan`, the scheduled time of each input (ms) plus the end.
The output timeline follows the plan: segment k runs from input k to input k+1 and each pane's segment
is trimmed or padded (holding its last frame) to the planned length. Within a segment every pane plays
in real time, so each mode's reaction delay after the input stays visible.
"""
import json
import subprocess
import sys

FPS = 60
LEAD_IN = 60  # frames before the first input

out, bases = sys.argv[1], sys.argv[2:]
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
graph.append("".join(stacked) + f"hstack=inputs={len(bases)},format=yuv420p[o]")

subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(graph),
                "-map", "[o]", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-r", str(FPS),
                "-movflags", "+faststart", out], check=True)
print(out)
