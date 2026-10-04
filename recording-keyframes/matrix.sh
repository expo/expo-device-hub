#!/usr/bin/env bash
# 3 scenarios x 4 keyframe limits x 2 passes; second pass reverses the limits.
# Optional RECORD_SIM_BIN adds the six contextual record-sim runs.
set -euo pipefail
OUT=${1:?Usage: matrix.sh <new output directory>}
[[ ! -e $OUT ]] || { echo "Use a new output directory" >&2; exit 2; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
for pass in 1 2; do
  if [[ $pass = 1 ]]; then ORDER=(120 60 30 15); else ORDER=(15 30 60 120); fi
  for scenario in still navigate scroll; do
    if [[ $pass = 1 && -n ${RECORD_SIM_BIN:-} ]]; then bash "$HERE/scenario.sh" "$OUT/$scenario-record-sim-p$pass" "$scenario" record-sim; fi
    for kf in "${ORDER[@]}"; do bash "$HERE/scenario.sh" "$OUT/$scenario-serve-sim-$kf-p$pass" "$scenario" serve-sim "$kf"; done
    if [[ $pass = 2 && -n ${RECORD_SIM_BIN:-} ]]; then bash "$HERE/scenario.sh" "$OUT/$scenario-record-sim-p$pass" "$scenario" record-sim; fi
  done
done
mkdir "$OUT/raw"
python3 - "$OUT" <<'PY'
from pathlib import Path
import json,sys
out=Path(sys.argv[1])
for p in out.glob('*/ffprobe.json'):
    probe=json.loads(p.read_text()); probe={'run':p.parent.name,**probe}
    (out/'raw'/f'{p.parent.name}.json').write_text(json.dumps(probe,separators=(',',':'))+'\n')
PY
python3 "$HERE/analyze.py" --csv "$OUT/raw" > "$OUT/results.csv"
echo "Results: $OUT/results.csv"
