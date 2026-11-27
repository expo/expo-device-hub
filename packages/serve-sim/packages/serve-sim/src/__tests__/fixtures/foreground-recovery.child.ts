import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createForegroundTrackerCache, type ForegroundApp } from "../../foreground-tracker";
import { withShimsAsync } from "../helpers";

const app = { bundleId: "dev.expo.current", pid: 42 };
const background = "[app<dev.expo.old>:41] Setting process visibility to: Background";
const bootstrap = `[app<${app.bundleId}>:${app.pid}] Bootstrap success!`;

function ndjson(...messages: string[]): string {
  return messages.map((eventMessage) => JSON.stringify({ eventMessage }) + "\n").join("");
}

test.each([
  ["recovers a quiet app after an unrelated background event", app.pid, ndjson(background)],
  ["finishes a pending launch on the replacement stream", -1, ndjson(background, bootstrap)],
])("%s", async (_name, historicalPid, replacementLog) => {
  const history = ndjson(
    `[app<${app.bundleId}>:${historicalPid}] Setting process visibility to: Foreground`,
  );
  const xcrun = `#!/bin/sh
case "$5" in
  show) printf '%s' '${history}' ;;
  stream)
    if [ ! -f "$0.restarted" ]; then
      touch "$0.restarted"
      exit 1
    fi
    printf '%s' '${replacementLog}'
    exec /bin/sleep 30
    ;;
  *) exit 2 ;;
esac
`;
  await withShimsAsync({ xcrun }, async () => {
    const cache = createForegroundTrackerCache({
      frontmostApp: async () => null,
      restartDelayMs: 0,
    });
    const seen = Promise.withResolvers<ForegroundApp | null>();
    const sub = cache.subscribe("FAKE-DEVICE", seen.resolve);
    try {
      expect(await Promise.race([seen.promise, sleep(2000, null, { ref: false })])).toEqual(app);
    } finally {
      sub.unsubscribe();
    }
  });
});
