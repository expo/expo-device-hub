#!/usr/bin/env bash
set -euo pipefail
xcrun simctl list devices booted -j | node -e '
  const devices = Object.values(JSON.parse(require("fs").readFileSync(0, "utf8")).devices).flat();
  const requested = process.env.SERVE_SIM_TEST_UDID?.trim();
  const selected = devices.find(device => device.state === "Booted" && (!requested || device.udid === requested));
  if (!selected) {
    console.error(requested ? `Pinned simulator ${requested} is not booted.` : "No booted CI simulator found.");
    process.exit(1);
  }
  console.log(selected.udid);
'
