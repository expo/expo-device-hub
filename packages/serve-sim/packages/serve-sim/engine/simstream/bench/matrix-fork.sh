#!/bin/zsh
# Interleaved matrix for the forked serve-sim: rotate mode order each rep, both scenes.
cd ${0:A:h}
export FBENCH_OUT=/tmp/fbench/matrix; mkdir -p $FBENCH_OUT
orders=("S W H" "W H S" "H S W" "S H W")
for scene in light heavy; do
  for rep in 1 2 3 4; do
    for c in ${=orders[$rep]}; do ./runfork.sh $c $scene $rep 2>&1 | tail -1; done
  done
done
echo MATRIX DONE
