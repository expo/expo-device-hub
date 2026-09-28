import { describe, expect, it } from "bun:test";

import { runChildSuite } from "./fixtures/run-child-suite";

// exec.ts caches its socket at module scope and this fixture replaces global WebSocket, so it runs
// in its own process rather than depending on being the first file to touch either.
describe("client runHostAction", () => {
  it("handshakes, pairs replies, and maps refusals to failed results", async () => {
    const { exitCode, output } = await runChildSuite("client-exec.child.ts", { timeoutMs: 45_000 });
    expect(output).toContain("11 pass");
    expect(exitCode).toBe(0);
  }, 60_000);

  it("falls back to a first-frame token the handshake cannot carry", async () => {
    const { exitCode, output } = await runChildSuite("client-exec-token-frame.child.ts", {
      timeoutMs: 45_000,
    });
    expect(output).toContain("1 pass");
    expect(exitCode).toBe(0);
  }, 60_000);
});
