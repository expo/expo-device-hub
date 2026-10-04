#!/usr/bin/env python3
"""Recalculate PR243 size/keyframe/timestamp tables from ffprobe JSON exports.

python3 analyze.py raw > recalculated.json
python3 analyze.py --csv raw > recalculated.csv
python3 analyze.py --verify raw original-size-results.json
"""
import argparse
import csv
import json
import math
from pathlib import Path
import statistics
import sys


def summarize(probe):
    packets = [p for p in probe['packets'] if p.get('pts_time') not in (None, 'N/A')]
    pts = [float(p['pts_time']) for p in packets]
    sorted_pts = sorted(pts)
    gaps = [b - a for a, b in zip(sorted_pts, sorted_pts[1:])]
    keys = sorted(float(p['pts_time']) for p in packets if 'K' in p.get('flags', ''))
    key_gaps = [b - a for a, b in zip(keys, keys[1:])]
    seconds = float(probe['format']['duration'])
    size = int(probe['format']['size'])
    pts_dts = [float(p['pts_time']) - float(p['dts_time']) for p in packets if p.get('dts_time') not in (None, 'N/A')]
    return {
        'run': probe['run'], 'sizeBytes': size, 'seconds': seconds,
        'mbPerMin': size / 1_000_000 / seconds * 60,
        'packets': len(packets), 'packetFps': len(packets) / seconds,
        'ptsSpanSeconds': sorted_pts[-1] - sorted_pts[0],
        'ptsSpanFps': (len(packets) - 1) / (sorted_pts[-1] - sorted_pts[0]),
        'presentationGapMaxMs': max(gaps) * 1000 if gaps else None,
        'keyframes': len(keys), 'keyGapMinSeconds': min(key_gaps) if key_gaps else None,
        'keyGapMaxSeconds': max(key_gaps) if key_gaps else None,
        'keyShare': sum(int(p['size']) for p in packets if 'K' in p.get('flags', '')) / sum(int(p['size']) for p in packets),
        'ptsBackstepsInPacketOrder': sum(b < a for a, b in zip(pts, pts[1:])),
        'ptsDtsMaxMs': max(pts_dts) * 1000 if pts_dts else None,
        'width': probe['streams'][0]['width'], 'height': probe['streams'][0]['height'],
        'hasBFrames': probe['streams'][0].get('has_b_frames'),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--csv', action='store_true')
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('raw_dir', type=Path)
    parser.add_argument('original_results', nargs='?', type=Path)
    args = parser.parse_args()
    rows = [summarize(json.loads(p.read_text())) for p in sorted(args.raw_dir.glob('*.json'))]
    if not rows:
        parser.error('No raw JSON exports found')
    if args.verify:
        if args.original_results is None:
            parser.error('--verify requires original_results')
        original = json.loads(args.original_results.read_text())
        by_run = {r['run']: r for r in rows}
        count = 0
        for group in original:
            for old in group['passes']:
                run = f"{group['scenario']}-{group['config']}-p{old['pass_']}"
                fresh = by_run[run]
                for key, old_key in [('seconds', 'seconds'), ('packets', 'frames'), ('mbPerMin', 'mbPerMin'), ('keyframes', 'keyframes'), ('keyGapMaxSeconds', 'keyGapMax'), ('keyShare', 'keyShare')]:
                    a, b = fresh[key], old[old_key]
                    assert (a is None and b is None) or (a is not None and b is not None and math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)), (run, key, a, b)
                count += 1
        assert count == len(rows) == 30, count
        print(f'All {count} original runs match for duration, packet count, MB/min, keyframe count/gap and keyframe byte share.')
    elif args.csv:
        writer = csv.DictWriter(sys.stdout, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    else:
        print(json.dumps(rows, indent=2))


if __name__ == '__main__':
    main()
