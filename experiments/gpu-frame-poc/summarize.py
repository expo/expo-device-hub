#!/usr/bin/env python3
"""CPU wall time around capture and CUDA map/copy/unmap; exclude 10 startup frames."""
import csv,json,statistics,sys
from pathlib import Path
for name in sys.argv[1:]:
    rows=list(csv.DictReader(Path(name).open()))
    r=rows[10:]
    if len(r)<2:
        raise ValueError('Need at least 12 captured frames')
    result={'file':name,'captured_frames':len(rows),'warmup_excluded':10,
      'measured_fps':(len(r)-1)*1000/(float(r[-1]['elapsed_ms'])-float(r[0]['elapsed_ms']))}
    for k in ['capture_ms','copy_ms']:
        v=sorted(float(x[k]) for x in r)
        result[k]={'mean':statistics.mean(v),'p50':statistics.median(v),
                   'p95':v[int((len(v)-1)*.95)],'p99':v[int((len(v)-1)*.99)],'max':max(v)}
    print(json.dumps(result,indent=2))
