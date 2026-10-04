#!/usr/bin/env bash
# 3 scenarios x (record-sim, serve-sim keyframe every 120/60/30/15 frames) x 2 passes, interleaved.
set -uo pipefail
cd "$(dirname "$0")"
OUT=scen
CONFIGS=("record-sim" "serve-sim 120" "serve-sim 60" "serve-sim 30" "serve-sim 15")
for pass in 1 2; do
  for scenario in still navigate scroll; do
    order=("${CONFIGS[@]}")
    [ "$pass" = 2 ] && order=("serve-sim 15" "serve-sim 30" "serve-sim 60" "serve-sim 120" "record-sim")
    for config in "${order[@]}"; do
      set -- $config
      name="$scenario-$1${2:+-$2}-p$pass"
      rm -rf "$OUT/$name"
      echo "$(date +%T) $name"
      bash scenario.sh "$OUT/$name" "$scenario" "$@" 2>&1 | tail -2
    done
  done
done
echo MATRIX DONE
