import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import { simMiddleware } from "../middleware";
import { closeDeviceSession, getDeviceSession } from "../device-session";
import { locateNativeAddon } from "../native";
import { locateSimpbArtifact } from "../sim-pasteboard";
import { PasteboardCopyTimeoutError, copyFromSim as performCopyFromSim } from "../sim-pasteboard-copy";
import {
  COPY_FIXTURE_TEXT,
  ensureFixtureInstalled,
  FIXTURE_BUNDLE,
  launchWithoutReader,
  pasteboardDylib,
  pasteboardFixture,
  SAFARI_BUNDLE,
  sendSimSelectAllShortcut,
  sendSimTap,
  waitForDataMigration,
} from "./pasteboard-sim";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";

const stateDir = useTempStateDir();
afterAll(() => stateDir.restore());

const TEST_TOKEN = "test-token";
const middleware = simMiddleware({ basePath: "/preview", execToken: TEST_TOKEN });
const udid = e2eDevice();
const copyReady = !!(udid && pasteboardDylib && locateNativeAddon());
requireE2E("pasteboard copy E2E", copyReady);
requireE2E("pasteboard copy user-app E2E", !!(copyReady && pasteboardFixture));
const describeCopy = copyReady ? describe : describe.skip;
const describeUserApp = copyReady && pasteboardFixture ? describe : describe.skip;
const SAFARI_COPY_TEXT = "serve-sim-safari-copy-probe";

async function copyFromSim(): Promise<{ ok?: boolean; text?: string; error?: string; status: number }> {
  getDeviceSession(udid!);
  const res = await middleware(
    new Request(
      `http://localhost:3200/preview/api/pasteboard?device=${encodeURIComponent(udid!)}&copy=1`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, Origin: "http://localhost:3200" },
      },
    ),
  );
  const body = (await res!.json()) as { ok?: boolean; text?: string; error?: string };
  return { ...body, status: res!.status };
}

describeCopy(`toolbar Copy (booted sim ${udid ?? "<skipped>"})`, () => {
  describe("Safari", () => {
    let session: { unsubscribe: () => void } | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let selectedText = "";

    beforeAll(async () => {
      let markRequested = () => {};
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/selection") {
            selectedText = url.searchParams.get("text") ?? "";
            return new Response(null, { status: 204 });
          }
          markRequested();
          // The page reports its selection, so the test knows Cmd+A reached it before Copy runs.
          return new Response(
            `<main>${SAFARI_COPY_TEXT}</main><script>document.addEventListener("selectionchange", () => ` +
              `fetch("/selection?text=" + encodeURIComponent(getSelection().toString())));</script>`,
            { headers: { "Content-Type": "text/html" } },
          );
        },
      });
      // An earlier suite may have rebooted the simulator; Safari ignores Command+C while it migrates.
      const waited = await waitForDataMigration();
      if (waited > 0) console.log(`[pasteboard-copy] waited ${waited} ms for data migration`);
      session = await launchWithoutReader(udid!, SAFARI_BUNDLE);
      execFileSync("xcrun", ["simctl", "openurl", udid!, `http://127.0.0.1:${server.port}`]);
      await Promise.race([
        requested,
        Bun.sleep(15_000).then(() => {
          throw new Error("Safari did not request the copy fixture page");
        }),
      ]);
      await Bun.sleep(5000);
    }, 360_000);

    afterAll(() => {
      closeDeviceSession(udid!);
      session?.unsubscribe();
      server?.stop(true);
    });

    test("Copy returns Safari text and preserves rich pasteboard items on failure", async () => {
      // Opened by URL, Safari can leave the page without keyboard focus, and Cmd+A then selects nothing.
      // A tap gives it focus, as a user's click does; repeat until the page reports the selection.
      // After a simulator reboot on the CI worker, Safari can also ignore Command+C once, which
      // Copy reports as 504; a user would select and copy again, so the test does too.
      let result: Awaited<ReturnType<typeof copyFromSim>> | undefined;
      for (let copyAttempt = 0; copyAttempt < 3 && result?.status !== 200; copyAttempt++) {
        selectedText = "";
        for (let attempt = 0; attempt < 5 && !selectedText.includes(SAFARI_COPY_TEXT); attempt++) {
          await sendSimTap(udid!, 0.5, 0.5);
          await sendSimSelectAllShortcut(udid!);
          const deadline = Date.now() + 2000;
          while (!selectedText.includes(SAFARI_COPY_TEXT) && Date.now() < deadline) await Bun.sleep(100);
        }
        if (selectedText.includes(SAFARI_COPY_TEXT)) result = await copyFromSim();
      }
      expect(selectedText).toContain(SAFARI_COPY_TEXT);
      expect(result?.status).toBe(200);
      if (!result) throw new Error("Copy did not run");
      expect(result.ok).toBe(true);
      expect(result.text).toContain(SAFARI_COPY_TEXT);
      const app = locateSimpbArtifact("ServeSimPasteboard.app");
      expect(app).not.toBeNull();
      const tool = join(app!, "serve-sim-pasteboard");
      const items = () => {
        const snapshot = execFileSync("xcrun", ["simctl", "spawn", udid!, tool, "--snapshot"], {
          encoding: "utf8",
        });
        return execFileSync("plutil", ["-p", "-"], {
          input: Buffer.from(snapshot.split("\n")[1]!, "base64"),
          encoding: "utf8",
        });
      };
      const before = items();
      expect(before).toContain("public.html");
      expect(before).toContain("public.utf8-plain-text");
      await expect(performCopyFromSim(udid!, async () => {})).rejects.toBeInstanceOf(PasteboardCopyTimeoutError);
      expect(items()).toBe(before);
    }, 120_000);
  });

  describeUserApp("user app", () => {
    let session: { unsubscribe: () => void } | undefined;

    beforeAll(async () => {
      ensureFixtureInstalled(udid!);
      session = await launchWithoutReader(udid!, FIXTURE_BUNDLE);
      await Bun.sleep(300);
    }, 60_000);

    afterAll(() => {
      closeDeviceSession(udid!);
      session?.unsubscribe();
    });

    test("Copy returns the selected field text", async () => {
      const body = await copyFromSim();
      expect(body.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.text).toBe(COPY_FIXTURE_TEXT);
    }, 45_000);
  });
});
