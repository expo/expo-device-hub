import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import { join } from "path";
import { WebSocket, WebSocketServer } from "ws";
import { locateNativeAddon } from "../native";
import { createClipboardSession } from "../clipboard-session";
import { closeDeviceSession, getDeviceSession } from "../device-session";
import { getUiOption, setUiOption } from "../ui-settings";
import { simctlSync } from "../simctl";
import { WS_MSG_INPUT_ADMITTED } from "../socket/input-protocol";
import { pasteboardTool as tool } from "./pasteboard-sim";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const FIXTURE = join(import.meta.dir, "../../dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const udid = e2eDevice();

const appReady = !!(udid && tool && existsSync(FIXTURE) && locateNativeAddon());
requireE2E("simulator clipboard app paste E2E", appReady);
const describeApp = appReady ? describe : describe.skip;

function simctl(...args: string[]): string {
  return simctlSync(args);
}

describeApp(`simulator app paste (booted sim ${udid ?? "<skipped>"})`, () => {
  let previousKeyboard: string;
  let fixtureLog: string;
  const clipboard = createClipboardSession();

  function fixtureLines(): string[] {
    try { return readFileSync(fixtureLog, "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  }

  async function waitFor<T>(read: () => T, expected: T): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (read() === expected) return;
      await Bun.sleep(50);
    }
    expect(read(), fixtureLines().join("\n")).toBe(expected);
  }

  beforeAll(async () => {
    try { simctl("uninstall", udid!, APP); } catch {}
    simctl("install", udid!, FIXTURE);
    simctl("privacy", udid!, "grant", "pasteboard", APP);
    fixtureLog = join(simctl("get_app_container", udid!, APP, "data").trim(), "Documents/launches.tsv");
    previousKeyboard = await getUiOption(udid!, "hardware-keyboard");
    // Launch with OFF and no preparatory shortcut or focused-app toggle. The first
    // Paste must reach the field, not just the simulator pasteboard.
    await setUiOption(udid!, "hardware-keyboard", "off");
    await clipboard.initialize(udid!);
    await getDeviceSession(udid!).start();
  }, 60_000);

  afterAll(async () => {
    try {
      closeDeviceSession(udid!);
    } finally {
      try {
        await clipboard.dispose();
      } finally {
        try { simctl("uninstall", udid!, APP); } catch {}
        if (previousKeyboard) await setUiOption(udid!, "hardware-keyboard", previousKeyboard);
      }
    }
  }, 30_000);

  async function pasteOverInputSocket(text: string, pid: string): Promise<void> {
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
        const timeout = setTimeout(() => reject(new Error("Input socket was not admitted")), 10_000);
        ws.on("message", (frame: Buffer) => {
          if (frame[0] !== WS_MSG_INPUT_ADMITTED) return;
          clearTimeout(timeout);
          resolve();
        });
        ws.once("error", (error) => { clearTimeout(timeout); reject(error); });
        ws.once("close", () => { clearTimeout(timeout); reject(new Error("Input socket closed before admission")); });
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
      // A dispatch acknowledgement is not proof that UIKit inserted the text.
      await waitFor(() => fixtureLines().filter((line) => line.startsWith(`text\t${pid}\t`)).at(-1)?.split("\t")[2], text);
    } finally {
      ws.close();
      sockets.close();
      server.close();
    }
  }

  test("first Paste and app relaunch insert Unicode with Hardware Keyboard OFF", async () => {
    const previousLocale = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    process.env.LANG = process.env.LC_ALL = "C";
    try {
      const texts = ["café 🎉 email+tag@x.com — 日本語", "second process — café 🎉"];
      for (const [index, text] of texts.entries()) {
        // Keep the same input session, without toggling the keyboard between processes.
        const launch = simctl("launch", udid!, APP, "--keyboard-test", "--clipboard-test");
        const pid = /:\s*(\d+)$/.exec(launch.trim())?.[1];
        expect(pid, launch).toBeDefined();
        const recorded = (kind: string) => fixtureLines().some((line) => line.startsWith(`${kind}\t${pid}\t`));
        await waitFor(() => recorded("keyboard-active"), true);
        if (index === 0) {
          await waitFor(() => recorded("keyboard-visible"), true);
          // Preparation must leave the software keyboard visible. The first HID
          // key can hide it across app relaunches, even with the unmodified reader.
          await Bun.sleep(500);
          expect(recorded("keyboard-hidden"), fixtureLines().join("\n")).toBe(false);
        }
        await pasteOverInputSocket(text, pid!);
        expect(await getUiOption(udid!, "hardware-keyboard")).toBe("off");
        simctl("terminate", udid!, APP);
      }
    } finally {
      for (const [name, value] of Object.entries(previousLocale)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 60_000);
});
