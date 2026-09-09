import { describe, expect, test } from "bun:test";
import { execText } from "../src/exec.ts";

const HOLD_SCRIPT = "setInterval(() => {}, 1000)";

describe("abortable exec", () => {
  test("kills an active child and preserves the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("device session changed");
    const running = execText(process.execPath, ["-e", HOLD_SCRIPT], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 20);

    const result = await running;
    expect(result.error?.cause).toBe(reason);
  });

  test("removes an aborted queued command without consuming a permit", async () => {
    const activeControllers = Array.from(
      { length: 4 },
      () => new AbortController(),
    );
    const active = activeControllers.map((controller) =>
      execText(process.execPath, ["-e", HOLD_SCRIPT], {
        signal: controller.signal,
      }),
    );
    const queuedController = new AbortController();
    const reason = new Error("queued upload cancelled");
    const queued = execText(process.execPath, ["-e", "process.exit(0)"], {
      signal: queuedController.signal,
    });
    queuedController.abort(reason);

    const queuedResult = await queued;
    expect(queuedResult.error?.cause).toBe(reason);

    for (const controller of activeControllers) {
      controller.abort(new Error("test cleanup"));
    }
    const results = await Promise.allSettled(active);
    expect(results).toHaveLength(4);

    const next = await execText(process.execPath, ["-e", "console.log('ok')"]);
    expect(next.status).toBe(0);
    expect(next.stdout.trim()).toBe("ok");
  });
});
