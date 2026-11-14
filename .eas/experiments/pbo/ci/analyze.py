"""analyze.py: frame rates and color steps of a capture on the page that paints each frame in
the next of eight colors (fixtures/frame-counter.html).

  analyze.py stream <file.h264> <frames.csv> <label> <skip s> <window s> [<window s> ...]
  analyze.py mp4 <file.mp4> <label> <skip s> <window s> [<window s> ...]

stream: rows of frames.csv are "arrival ms, ..., key" (consumer.mjs: arrival, pts us, pts on the
host clock ms, bytes, key; webrtc-viewer.mjs: arrival, rtp, bytes, key, packets, lost). Windows
start <skip> seconds after the first frame and follow one another. mp4: the windows use the
presentation times.

Per window: received fps, changed fps (frames whose color differs from the frame before), color
steps (0 repeated, 1 next color, 2 one page frame missing, 3+ more, 7 one step back or six
missing), torn frames (two page colors in one frame), unknown frames (no page color), Mbit/s, and
for consumer.mjs the time from the agent's timestamp to the arrival.
"""
import json
import subprocess
import sys

PALETTE = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (0, 255, 255), (255, 0, 255),
           (255, 255, 255), (0, 0, 0)]
SAMPLES = 8


def classify(rgb):
    best, dist = None, 1e9
    for index, color in enumerate(PALETTE):
        d = sum((a - b) ** 2 for a, b in zip(rgb, color)) ** 0.5
        if d < dist:
            best, dist = index, d
    return best if dist < 110 else None


def colors(path):
    """One entry per decoded frame: (page color or None, torn)."""
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-fps_mode", "passthrough", "-vf",
         f"crop=iw/2:ih/2:iw/4:ih/4,scale=1:{SAMPLES}:flags=area,format=rgb24", "-f", "rawvideo",
         "-"], capture_output=True, timeout=1800).stdout
    frame_bytes = SAMPLES * 3
    result = []
    for offset in range(0, len(out) - frame_bytes + 1, frame_bytes):
        chunk = out[offset:offset + frame_bytes]
        classes = [classify(tuple(chunk[i * 3:i * 3 + 3])) for i in range(SAMPLES)]
        known = [c for c in classes if c is not None]
        if not known:
            result.append((None, False))
            continue
        majority = max(set(known), key=known.count)
        result.append((majority, len(set(known)) > 1))
    return result


def mp4_times(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "frame=pts_time,pkt_size,key_frame", "-of", "csv=p=0", path],
                         capture_output=True, text=True, timeout=1800).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) >= 3 and parts[1] not in ("", "N/A"):
            rows.append({"t": float(parts[1]) * 1000, "key": parts[0] == "1",
                         "bytes": int(parts[2]) if parts[2].isdigit() else 0})
    return rows


def window_stats(frames, start, end):
    inside = [f for f in frames if start <= f["t"] < end]
    seconds = (end - start) / 1000
    steps = {"0": 0, "1": 0, "2": 0, "3+": 0, "7": 0}
    changed = torn = unknown = 0
    previous = None
    latencies = []
    for f in inside:
        if f["torn"]:
            torn += 1
        if f["color"] is None:
            unknown += 1
        elif previous is not None:
            step = (f["color"] - previous) % 8
            if step != 0:
                changed += 1
            key = "0" if step == 0 else "1" if step == 1 else "2" if step == 2 else "7" if step == 7 else "3+"
            steps[key] += 1
        if f["color"] is not None:
            previous = f["color"]
        if f.get("latency") is not None:
            latencies.append(f["latency"])
    latencies.sort()
    return {
        "frames": len(inside),
        "fps": round(len(inside) / seconds, 2),
        "changedFps": round(changed / seconds, 2),
        "steps": steps,
        "torn": torn,
        "unknown": unknown,
        "mbps": round(sum(f["bytes"] for f in inside) * 8 / seconds / 1e6, 2),
        "ptsToArrivalMs": None if not latencies else {
            "mean": round(sum(latencies) / len(latencies), 1),
            "p95": round(latencies[int(len(latencies) * 0.95)], 1),
            "max": round(latencies[-1], 1)},
    }


def main():
    kind = sys.argv[1]
    if kind == "stream":
        path, csv, label = sys.argv[2], sys.argv[3], sys.argv[4]
        skip, windows = float(sys.argv[5]), [float(w) for w in sys.argv[6:]]
        rows = [line.split(",") for line in open(csv).read().splitlines() if line.strip()]
        # webrtc-viewer.mjs writes a header row.
        rows = [row for row in rows if row[0].replace(".", "", 1).isdigit()]
        frames = []
        consumer = len(rows[0]) == 5 if rows else False
        for row in rows:
            frame = {"t": float(row[0]), "bytes": int(row[3] if consumer else row[2]),
                     "key": (row[4] if consumer else row[3]) == "1"}
            if consumer and row[2]:
                frame["latency"] = float(row[0]) - float(row[2])
            frames.append(frame)
    else:
        path, label = sys.argv[2], sys.argv[3]
        skip, windows = float(sys.argv[4]), [float(w) for w in sys.argv[5:]]
        frames = mp4_times(path)
    decoded = colors(path)
    if len(decoded) != len(frames):
        sys.stderr.write(f"{label}: {len(decoded)} decoded frames, {len(frames)} rows\n")
    for frame, (color, torn) in zip(frames, decoded):
        frame["color"], frame["torn"] = color, torn
    for frame in frames[len(decoded):]:
        frame["color"], frame["torn"] = None, False
    result = {"label": label, "totalFrames": len(frames), "decoded": len(decoded), "windows": []}
    if frames:
        start = frames[0]["t"] + skip * 1000
        for seconds in windows:
            end = start + seconds * 1000
            result["windows"].append({"fromS": round((start - frames[0]["t"]) / 1000, 1),
                                      **window_stats(frames, start, end)})
            start = end
    print(json.dumps(result))


main()
