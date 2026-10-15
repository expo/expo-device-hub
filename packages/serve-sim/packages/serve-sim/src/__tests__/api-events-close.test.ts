import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { simMiddleware } from "../middleware";
import { installShims, useTempStateDir } from "./helpers";

// /api/events computes its first payload before it watches the state directory.
// A client that leaves during that computation must not leave the watcher behind:
// it would shell out to simctl on every later state change, for the life of the server.
// The exec channel's subscriptions leave this way: they cancel the response body.
for (const leave of ["cancels the response", "aborts the request"] as const) {
  test(`an /api/events client that ${leave} during setup leaves no state watcher`, async () => {
    const state = useTempStateDir();
    const logDir = mkdtempSync(join(tmpdir(), "serve-sim-events-calls-"));
    const log = join(logDir, "calls");
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
    // A slow simctl that never yields a cacheable answer, so every recompute shells out.
    const shims = installShims({ xcrun: `#!/usr/bin/env bash\necho call >> ${JSON.stringify(log)}\nsleep 1\necho not-json\n` });
    try {
      const controller = new AbortController();
      const response = await simMiddleware({ basePath: "/" })(
        new Request("http://127.0.0.1/api/events", { signal: controller.signal }),
      );
      if (leave === "cancels the response") await response?.body?.cancel();
      else controller.abort();
      // The first computation finishes; a leaked watcher would start 250 ms later.
      await Bun.sleep(1_600);
      const before = calls();
      writeFileSync(join(state.dir, "change"), "");
      await Bun.sleep(1_500);
      expect(calls()).toBe(before);
    } finally {
      shims.restore();
      state.restore();
      rmSync(logDir, { recursive: true, force: true });
    }
  }, 15_000);
}
