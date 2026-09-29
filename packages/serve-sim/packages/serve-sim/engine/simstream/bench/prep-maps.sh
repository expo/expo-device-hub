# Resets Maps before each recording (run on the simulator host from ~/simp2p): Maps at Midtown in
# the background, the first home screen page showing. Uses gest.mjs against the engine on :8811.
cd ~/simp2p; N=/Users/seth/.local/share/mise/installs/node/22.20.0/bin/node; U=$(cat udid)
for app in com.apple.Maps com.apple.news com.apple.Preferences com.apple.mobilecal; do xcrun simctl terminate $U $app 2>/dev/null; done
xcrun simctl openurl $U 'maps://?ll=40.7580,-73.9855&z=15'; sleep 4
# Home twice: the first leaves Maps, the second returns to the first home screen page.
$N gest.mjs 8811 '[{"op":"button","b":"home","wait":1200},{"op":"button","b":"home","wait":1200}]'
