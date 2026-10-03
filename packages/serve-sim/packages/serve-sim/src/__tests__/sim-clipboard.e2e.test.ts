import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { axDescribeAsync } from "../native";
import { closeDeviceSession, getDeviceSession } from "../device-session";
import {
  ensureFixtureInstalled,
  firstBootedIosSim,
  FIXTURE_BUNDLE,
  isHeadlessPasteboard,
  nativeAddonExists,
  openAppForPasteboard,
  pasteboardDylib,
  pasteboardFixture,
  pasteboardTool as tool,
  writeTestPasteboard,
} from "./pasteboard-sim";
import { requireE2E } from "./e2e-preconditions";

const udid = firstBootedIosSim();

const skipOnCi = !!process.env.CI && process.env.SERVE_SIM_CLIPBOARD_E2E !== "1";
if (skipOnCi) {
  console.warn(
    "[sim-clipboard.e2e] skipping on CI: simulator pasteboard round-trip is unreliable on shared runners (set SERVE_SIM_CLIPBOARD_E2E=1 to force)",
  );
}

// The CI skip is by design, so a working pbpaste is only required when the suite runs.
const ready = !!(udid && tool) && (skipOnCi || !isHeadlessPasteboard());
requireE2E("simulator clipboard E2E", ready);
const describeIfSim = ready && !skipOnCi ? describe : describe.skip;

describeIfSim(`simctl pasteboard round-trip (booted sim ${udid ?? "<skipped>"})`, () => {
  test("writer and pbpaste round-trip unicode", () => {
    const text = "café 🎉 email+tag@x.com — 日本語";
    const read = () => execFileSync("xcrun", ["simctl", "pbpaste", udid!], {
      encoding: "utf-8",
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    });
    const previous = read();
    try {
      writeTestPasteboard(udid!, text, { ...process.env, LANG: "C", LC_ALL: "C" });
      expect(read()).toBe(text);
    } finally {
      writeTestPasteboard(udid!, previous);
    }
  });
});

const appReady = !!(udid && tool && pasteboardDylib && pasteboardFixture && nativeAddonExists());
requireE2E("simulator clipboard app paste E2E", appReady);
const describeApp = appReady ? describe : describe.skip;

describeApp(`simulator app paste (booted sim ${udid ?? "<skipped>"})`, () => {
  let session: { unsubscribe(): void } | undefined;

  beforeAll(async () => {
    ensureFixtureInstalled(udid!);
    session = await openAppForPasteboard(udid!, FIXTURE_BUNDLE);
  }, 60_000);

  afterAll(() => session?.unsubscribe());

  async function pasteOverInputSocket(text: string): Promise<void> {
    const deviceSession = getDeviceSession(udid!);
    await deviceSession.start();
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => deviceSession.attachHidSocket(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Input socket has no port");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const answer = new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Paste reply timed out")), 30_000);
        ws.on("message", (frame: Buffer) => {
          if (frame[0] !== 0x92) return;
          clearTimeout(timeout);
          resolve(JSON.parse(frame.subarray(1).toString()));
        });
      });
      ws.send(Buffer.concat([Buffer.from([0x12]), Buffer.from(JSON.stringify({ requestId: 1, text }))]));
      expect(await answer).toMatchObject({ ok: true });
    } finally {
      ws.close();
      sockets.close();
      server.close();
      closeDeviceSession(udid!);
    }
  }

  test("Command+V inserts Unicode text into the foreground app", async () => {
    const text = "café 🎉 日本語";
    await pasteOverInputSocket(text);
    const deadline = Date.now() + 10_000;
    let values: string[] = [];
    while (Date.now() < deadline) {
      const roots = JSON.parse(await axDescribeAsync(udid!)) as Array<{
        AXValue?: string | null;
        children?: unknown[];
      }>;
      values = [];
      const visit = (node: { AXValue?: string | null; children?: unknown[] }) => {
        if (node.AXValue) values.push(node.AXValue);
        for (const child of node.children ?? []) visit(child as typeof node);
      };
      for (const root of roots) visit(root);
      if (values.includes(text)) break;
      await Bun.sleep(100);
    }
    expect(values).toContain(text);
  }, 30_000);
});
