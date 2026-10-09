#!/usr/bin/env bash
set -euo pipefail
: "${SERVE_SIM_TEST_UDID:?Pin the CI simulator before the initial test attempt.}"
UDID="$SERVE_SIM_TEST_UDID"
STATE="$(xcrun simctl list devices available -j | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const device = Object.values(data.devices).flat().find(device => device.udid === process.argv[1]);
  if (!device) {
    console.error(`Pinned simulator ${process.argv[1]} is unavailable.`);
    process.exit(1);
  }
  console.log(device.state);
' "$UDID")"
echo "Rebooting $UDID before retrying failed files"
case "$STATE" in
  Booted) xcrun simctl shutdown "$UDID" ;;
  Shutdown) ;;
  *) echo "Unexpected simulator state: $STATE" >&2; exit 1 ;;
esac
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
