#!/bin/zsh
# iterate.sh <name> <configs-file> [reps]
# One tuning iteration over the real internet: the server (engine + bridges) runs on the Mac Mini,
# the viewer (headless Chrome + measure.mjs) on the remote Expo laptop; WebSocket is always included
# as the control. Configs file lines: "<label> <port> <mode> [ENV=VALUE ...]" (the WebSocket control
# is added automatically on :8811). Writes /tmp/simcheck/iter-<name>.jsonl and prints a summary.
set -u
NAME=$1; CONFIGS=$2; REPS=${3:-2}
HERE=${0:A:h}
SERVER=seths-mac-mini; H=seths-mac-mini.tail441c0f.ts.net
L=seth@sethwebster-expo.tail441c0f.ts.net; LN=/Users/seth/.local/share/mise/installs/node/22.20.0/bin/node
SN=/Users/sethwebster/.asdf/installs/nodejs/24.14.0/bin/node
U=B3AFC702-8CB5-45BF-A221-99740EC51B4B
OUT=/tmp/simcheck/iter-$NAME.jsonl; : > $OUT

typeset -A PORT MODE ENVS; LABELS=(ws); PORT[ws]=8811
while read -r label port mode rest; do
  [[ -z "$label" || "$label" == \#* ]] && continue
  LABELS+=($label); PORT[$label]=$port; MODE[$label]=$mode; ENVS[$label]="$rest"
done < $CONFIGS

# Server side on the Mini.
rsync -a --exclude node_modules $HERE/bridge.mjs $HERE/page.html $HERE/timeserver.mjs $SERVER:dcspike/
ssh $SERVER "for p in 8799 8811 8812 8813 8814 8815 8816 8817; do pids=\$(lsof -tiTCP:\$p -sTCP:LISTEN); [ -n \"\$pids\" ] && kill \$pids; done; sleep 1
  cd ~/dcspike; (nohup /usr/bin/python3 -m http.server 8799 --bind 127.0.0.1 > /tmp/dc-clock.log 2>&1 &)
  (nohup ~/simfork/dist/bin/simstream-engine --udid $U --port 8811 > /tmp/dc-engine.log 2>&1 &)
  (nohup $SN timeserver.mjs > /tmp/dc-time.log 2>&1 &); sleep 3"
ORIGINS="http://$H:8811"
for c in ${LABELS:1}; do
  ssh $SERVER "cd ~/dcspike && (env ${ENVS[$c]} nohup $SN bridge.mjs 8811 ${PORT[$c]} ${MODE[$c]} > /tmp/dc-bridge-$c.log 2>&1 &)"
  ORIGINS="$ORIGINS,http://$H:${PORT[$c]}"
done
sleep 2
ssh $SERVER "head -1 /tmp/dc-bridge-*.log" | sed 's/^/  /'

pauses() { ssh $SERVER "grep -c backlog /tmp/dc-engine.log; true" 2>/dev/null | tail -1; }
for scene in light heavy; do
  if [ $scene = heavy ]; then ssh $SERVER "xcrun simctl openurl $U 'http://127.0.0.1:8799/clock.html#heavy'"; else ssh $SERVER "xcrun simctl openurl $U http://127.0.0.1:8799/clock.html"; fi
  sleep 4
  for rep in $(seq 1 $REPS); do
    order=(${LABELS[@]}); for (( i = 0; i < (rep - 1) % ${#LABELS}; i++ )); do order=(${order:1} ${order[1]}); done
    for c in $order; do
      off=$(ssh -o ConnectTimeout=20 $L "cd ~/simbench/dc && $LN offset.mjs http://$H:8815/ 25" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['offsetMs'])" 2>/dev/null || echo 0)
      before=$(pauses)
      line=$(ssh -o ConnectTimeout=20 $L "cd ~/simbench/dc && EXTRA_CHROME_ARGS='--unsafely-treat-insecure-origin-as-secure=$ORIGINS' timeout 90 $LN measure.mjs http://$H:${PORT[$c]}/ '$c | $scene | run $rep' 5 20 9351" 2>/dev/null)
      after=$(pauses)
      echo "${line%\}},\"enginePauses\":$(( after - before )),\"clockOffsetMs\":$off}" >> $OUT
      sleep 2
    done
  done
done
for c in ${LABELS:1}; do ssh $SERVER "grep -h 'peak buffered' /tmp/dc-bridge-$c.log | tail -3" | sed "s/^/  [$c] /"; done

# Restore the Mini: stop the test services, simulator back to the home screen.
ssh $SERVER "for p in 8799 8811 8812 8813 8814 8815 8816 8817; do pids=\$(lsof -tiTCP:\$p -sTCP:LISTEN); [ -n \"\$pids\" ] && kill \$pids; done
  cd ~/simfork && $SN dist/serve-sim.js button home -d $U >/dev/null 2>&1"

python3 - $OUT <<'EOF'
import json, sys, collections, statistics as st
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith('{')]
g = collections.defaultdict(list)
for r in rows:
    if 'error' in r or r.get('arrivalAgeMean') is None: continue
    o = r.get('clockOffsetMs') or 0
    for k in ('arrivalAgeMean', 'arrivalAgeP50', 'arrivalAgeP95'): r[k] -= o
    c, sc, _ = [x.strip() for x in r['label'].split('|')]; g[(sc, c)].append(r)
print("frame age corrected per run for the laptop-Mini clock offset")
print(f"{'scene':5} {'config':22} n  mean   p50   p95   fps  skipped freezes worst pauses")
for (sc, c), rs in sorted(g.items(), key=lambda kv: (kv[0][0] != 'light', kv[0][1] != 'ws', kv[0][1])):
    m = lambda k: st.mean(r[k] for r in rs)
    print(f"{sc:5} {c:22} {len(rs)}  {m('arrivalAgeMean'):5.1f} {m('arrivalAgeP50'):5.1f} {m('arrivalAgeP95'):5.1f} {m('distinctFps'):5.1f} "
          f"{100*m('skippedShare'):5.1f}%  {sum(r['freezes50ms'] for r in rs):3d}  {max(r['worstFreezeMs'] or 0 for r in rs):4d}  {sum(r.get('enginePauses', 0) for r in rs):3d}")
EOF
