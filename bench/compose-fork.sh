#!/bin/zsh
# compose-fork.sh <route|barcode> OUTPUT.mp4 base1 base2 base3
# Trims each recording to 1 s before its route start (startFrame in base.json), then hstacks them.
kind=$1; out=$2; shift 2
inputs=(); filters=""; i=0
for b in "$@"; do
  sf=$(python3 -c "import json;d=json.load(open('$b.json'));print(240 if d['mode']=='barcode' else max(0,d['startFrame']-60))")
  inputs+=(-r 60 -i $b.h264)
  filters+="[${i}:v]trim=start_frame=$sf,setpts=PTS-STARTPTS[v$i];"
  i=$((i+1))
done
labels=""; for j in $(seq 0 $((i-1))); do labels+="[v$j]"; done
ffmpeg -y -loglevel error $inputs -filter_complex "${filters}${labels}hstack=inputs=${i}:shortest=1,format=yuv420p[o]" \
  -map "[o]" -c:v libx264 -preset slow -crf 16 -r 60 -movflags +faststart $out
ls -la $out
