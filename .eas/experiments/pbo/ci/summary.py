"""Summarize an EAS PBO comparison; fail missing, undecodable or torn captures."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
print('| Device/window | Page FPS | Role | Changed FPS | Torn | Unknown | Arrival p95 ms |')
print('|---|---:|---|---:|---:|---:|---:|')
failures = []
for window in sorted(root.glob('*/*-*')):
    if not window.is_dir():
        continue
    a, b = window / 'page-a.json', window / 'page-b.json'
    if not a.exists() or not b.exists():
        failures.append(f'{window}: missing page readings')
        continue
    page_fps = subprocess.check_output([
        sys.executable, str(pathlib.Path(__file__).with_name('page-fps.py')), str(a), str(b)
    ], text=True).strip()
    roles = ['stream'] + (['recording'] if (window / 'recording.json').exists() else [])
    for role in roles:
        path = window / f'{role}.analysis.json'
        if not path.exists():
            failures.append(f'{window}/{role}: missing decoded analysis')
            continue
        data = json.loads(path.read_text())
        if not data['windows'] or data['decoded'] != data['totalFrames']:
            failures.append(f'{window}/{role}: incomplete decode')
        for stats in data['windows']:
            latency = (stats.get('ptsToArrivalMs') or {}).get('p95', '')
            print(f"| {window.parent.name}/{window.name} | {page_fps} | {role} | "
                  f"{stats['changedFps']} | {stats['torn']} | {stats['unknown']} | {latency} |")
            if not stats['frames'] or not stats['changedFps'] or stats['torn'] or stats['unknown']:
                failures.append(f'{window}/{role}: empty/torn/unknown frames')
if failures:
    sys.exit('\n'.join(failures))
