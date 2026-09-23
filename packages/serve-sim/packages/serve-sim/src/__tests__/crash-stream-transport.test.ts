import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

// The exec client caches its WebSocket, so its fake transport must live in a separate process.
test("crash stream delivers frames, reconnects, and unsubscribes", async () => {
  const { exitCode, output } = await runChildSuite("crash-stream-transport.child.ts");
  expect(output).toContain("1 pass");
  expect(exitCode).toBe(0);
}, 60_000);
