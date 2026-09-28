#!/bin/zsh
# Pack this serve-sim fork (with the simstream video engine) as a standalone npm package.
#
#   scripts/pack-simstream.sh [name] [version]      # after `bun run build`
#   → prints the path of the .tgz; publish it with `npm publish <tgz> --access public`
#
# Stages a copy so the repo's own package.json (@expo/serve-sim) is untouched. Adds the engine
# (dist/bin/simstream-engine + its resource bundle), which the upstream "files" list doesn't ship.
set -euo pipefail
NAME=${1:-@sethwebster/expo-agent-hub-simstream}
VERSION=${2:-0.3.4-simstream.0}
PKG=${0:A:h}/..
cd $PKG

[ -x dist/bin/simstream-engine ] || { echo "dist/bin/simstream-engine missing: run bun run build" >&2; exit 1; }
[ -f dist/native/serve-sim-native.node ] || { echo "dist/native/serve-sim-native.node missing: run bun run build" >&2; exit 1; }

STAGE=$(mktemp -d)/package
mkdir -p $STAGE
# Upstream's file list, as npm resolves it, plus the engine.
npm pack --dry-run --json 2>/dev/null | node -e '
  const files = JSON.parse(require("fs").readFileSync(0, "utf8"))[0].files.map((f) => f.path);
  console.log(files.filter((f) => f !== "package.json").join("\n"));
' | while read -r f; do mkdir -p "$STAGE/$(dirname "$f")"; cp -p "$f" "$STAGE/$f"; done
cp -Rp dist/bin/simstream-engine dist/bin/simstream_simstream.bundle $STAGE/dist/bin/

NAME=$NAME VERSION=$VERSION node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.name = process.env.NAME;
  pkg.version = process.env.VERSION;
  pkg.description = "Fork of @expo/serve-sim with the simstream low-latency video engine (--codec simstream). Experimental.";
  pkg.files = [...pkg.files, "dist/bin/simstream-engine", "dist/bin/simstream_simstream.bundle", "README.md"];
  pkg.repository = { type: "git", url: "git+https://github.com/expo/expo-device-hub.git", directory: "packages/serve-sim/packages/serve-sim" };
  pkg.publishConfig = { access: "public" };
  delete pkg.devDependencies;
  delete pkg.scripts;
  fs.writeFileSync(process.argv[1], JSON.stringify(pkg, null, 2) + "\n");
' $STAGE/package.json

cat > $STAGE/README.md <<EOF
# $NAME

An experimental fork of [\`@expo/serve-sim\`](https://github.com/expo/expo-device-hub) (Apache-2.0),
built from the \`simstream-video\` branch. The change: a \`simstream\` video codec for the HTTP transport,
served by the simstream engine (render-locked capture, VideoToolbox low-latency H.264 per viewer,
delay-based bitrate control from client acks, WebSocket delivery, WebCodecs decode in the page).
Everything else (UI, input, tools) is upstream serve-sim. See LICENSE and NOTICE.

\`\`\`sh
# boot a simulator first, then:
npx $NAME --transport http --codec simstream
# on a shared or public network, gate it:
npx $NAME --transport http --codec simstream --require-token --host 0.0.0.0
\`\`\`

macOS on Apple silicon with Xcode installed. Browsers need HTTPS (or localhost) for WebCodecs.
EOF

cd $STAGE && npm pack --pack-destination $STAGE/.. --silent | tail -1 | sed "s|^|$STAGE/../|"
