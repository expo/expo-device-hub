"""Scenario matrix: MB per minute of video per scenario and recorder, mean of the passes.
python3 scen_analyze.py <scen dir>  -> prints tables and writes scen-results.json"""
import collections, json, os, re, statistics as st, subprocess, sys

runs = sys.argv[1]
by = collections.defaultdict(list)
for name in sorted(os.listdir(runs)):
    m = re.fullmatch(r"(still|navigate|scroll)-(.+)-p(\d)", name)
    mp4 = os.path.join(runs, name, "recording", "recording.mp4")
    if not m or not os.path.exists(mp4):
        continue
    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "packet=pts_time,flags,size:format=duration,size", "-of", "json", mp4], capture_output=True, text=True, check=True).stdout)
    pk = [p for p in probe["packets"] if p.get("pts_time") not in (None, "N/A")]
    keys = sorted(float(p["pts_time"]) for p in pk if "K" in p["flags"])
    seconds = float(probe["format"]["duration"])
    by[(m[1], m[2])].append(dict(
        pass_=int(m[3]), seconds=seconds, sizeMB=int(probe["format"]["size"]) / 1e6,
        mbPerMin=int(probe["format"]["size"]) / 1e6 / seconds * 60, frames=len(pk), keyframes=len(keys),
        keyGapMax=max((b - a for a, b in zip(keys, keys[1:])), default=None),
        keyShare=sum(int(p["size"]) for p in pk if "K" in p["flags"]) / sum(int(p["size"]) for p in pk),
    ))

order = ["record-sim", "serve-sim-120", "serve-sim-60", "serve-sim-30", "serve-sim-15"]
rows = []
for scenario in ["still", "navigate", "scroll"]:
    for config in order:
        passes = by.get((scenario, config))
        if not passes:
            continue
        mean = lambda k: st.mean(p[k] for p in passes)
        rows.append(dict(scenario=scenario, config=config, passes=passes, mbPerMin=mean("mbPerMin"),
                         spread=[round(p["mbPerMin"], 2) for p in passes], sizeMB=mean("sizeMB"),
                         seconds=mean("seconds"), keyframes=mean("keyframes"), keyShare=mean("keyShare"),
                         keyGapMax=max((p["keyGapMax"] or 0) for p in passes)))
json.dump(rows, open(os.path.join(runs, "scen-results.json"), "w"), indent=1)

print("| Scenario | Recorder | MB/min (mean) | MB/min per pass | File MB | Length s | Keyframes | Max keyframe gap s | Keyframe share of bytes |")
print("|---|---|---:|---|---:|---:|---:|---:|---:|")
for r in rows:
    print(f"| {r['scenario']} | {r['config']} | {r['mbPerMin']:.1f} | {' / '.join(map(str, r['spread']))} | {r['sizeMB']:.1f} | "
          f"{r['seconds']:.1f} | {r['keyframes']:.0f} | {r['keyGapMax']:.2f} | {100 * r['keyShare']:.0f}% |")
