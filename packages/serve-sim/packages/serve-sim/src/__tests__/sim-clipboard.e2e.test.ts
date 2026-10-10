import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { axDescribeAsync, locateNativeAddon } from "../native";
import { closeDeviceSession, getDeviceSession } from "../device-session";
import {
  ensureFixtureInstalled,
  FIXTURE_BUNDLE,
  openAppForPasteboard,
  pasteboardDylib,
  pasteboardFixture,
  pasteboardTool as tool,
} from "./pasteboard-sim";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const udid = e2eDevice();

const appReady = !!(udid && tool && pasteboardDylib && pasteboardFixture && locateNativeAddon());
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

  test("Command+V inserts Unicode text into the foreground app under LANG=C", async () => {
    const text = "café 🎉 email+tag@x.com — 日本語";
    const previousLocale = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    process.env.LANG = process.env.LC_ALL = "C";
    try {
      await pasteOverInputSocket(text);
    } finally {
      for (const [name, value] of Object.entries(previousLocale)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
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
