import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import { simMiddleware } from "../middleware";
import { closeDeviceSession, getDeviceSession } from "../device-session";
import { locateSimpbArtifact } from "../sim-pasteboard";
import { PasteboardCopyTimeoutError, copyFromSim as performCopyFromSim } from "../sim-pasteboard-copy";
import {
  COPY_FIXTURE_TEXT,
  ensureFixtureInstalled,
  firstBootedIosSim,
  FIXTURE_BUNDLE,
  launchWithoutReader,
  nativeAddonExists,
  pasteboardDylib,
  pasteboardFixture,
  SAFARI_BUNDLE,
  sendSimSelectAllShortcut,
  withSkipPbpaste,
} from "./pasteboard-sim";
import { requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";

const stateDir = useTempStateDir();
afterAll(() => stateDir.restore());

const TEST_TOKEN = "test-token";
const middleware = simMiddleware({ basePath: "/preview", execToken: TEST_TOKEN });
const udid = firstBootedIosSim();
const copyReady = !!(udid && pasteboardDylib && nativeAddonExists());
requireE2E("pasteboard copy E2E", copyReady);
requireE2E("pasteboard copy user-app E2E", !!(copyReady && pasteboardFixture));
const describeCopy = copyReady ? describe : describe.skip;
const describeUserApp = copyReady && pasteboardFixture ? describe : describe.skip;
const SAFARI_COPY_TEXT = "serve-sim-safari-copy-probe";

async function postPasteboard(): Promise<{ ok?: boolean; text?: string; error?: string; status: number }> {
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

async function copyFromSim(skipPbpaste = true): Promise<{ ok?: boolean; text?: string; error?: string; status: number }> {
  getDeviceSession(udid!);
  return skipPbpaste ? withSkipPbpaste(() => postPasteboard()) : postPasteboard();
}

describeCopy(`toolbar Copy (booted sim ${udid ?? "<skipped>"})`, () => {
  describe("Safari", () => {
    let session: { unsubscribe: () => void } | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;

    beforeAll(async () => {
      let markRequested = () => {};
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      server = Bun.serve({
        port: 0,
        fetch() {
          markRequested();
          return new Response(`<main>${SAFARI_COPY_TEXT}</main>`, {
            headers: { "Content-Type": "text/html" },
          });
        },
      });
      session = await launchWithoutReader(udid!, SAFARI_BUNDLE);
      execFileSync("xcrun", ["simctl", "openurl", udid!, `http://127.0.0.1:${server.port}`]);
      await Promise.race([
        requested,
        Bun.sleep(15_000).then(() => {
          throw new Error("Safari did not request the copy fixture page");
        }),
      ]);
      await Bun.sleep(5000);
    }, 60_000);

    afterAll(() => {
      closeDeviceSession(udid!);
      session?.unsubscribe();
      server?.stop(true);
    });

    test("Copy returns the selected text", async () => {
      await sendSimSelectAllShortcut(udid!);
      const result = await copyFromSim(false);
      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(result.text).toContain(SAFARI_COPY_TEXT);
    }, 45_000);

    test("failed Copy leaves Safari's rich pasteboard items untouched", async () => {
      await sendSimSelectAllShortcut(udid!);
      expect((await copyFromSim(false)).status).toBe(200);
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
    }, 45_000);

    test("Copy reads Safari without simctl pbpaste", async () => {
      await sendSimSelectAllShortcut(udid!);
      const body = await copyFromSim();
      expect(body.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.text).toContain(SAFARI_COPY_TEXT);
    }, 45_000);
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
