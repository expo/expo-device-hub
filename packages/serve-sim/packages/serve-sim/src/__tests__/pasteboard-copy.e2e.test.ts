import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { simMiddleware } from "../middleware";
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
  sendSimCopyShortcut,
  sendSimSelectAllShortcut,
  withSkipPbpaste,
} from "./pasteboard-sim";

const TEST_TOKEN = "test-token";
const middleware = simMiddleware({ basePath: "/preview", execToken: TEST_TOKEN });
const udid = firstBootedIosSim();
const describeCopy =
  udid && pasteboardDylib && pasteboardFixture && nativeAddonExists() ? describe : describe.skip;
const SAFARI_COPY_TEXT = "serve-sim-safari-copy-probe";

async function postPasteboard(): Promise<{ ok?: boolean; text?: string; error?: string; status: number }> {
  const res = await middleware(
    new Request(
      `http://localhost:3200/preview/api/pasteboard?device=${encodeURIComponent(udid!)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      },
    ),
  );
  const body = (await res!.json()) as { ok?: boolean; text?: string; error?: string };
  return { ...body, status: res!.status };
}

async function copyFromSim(): Promise<{ ok?: boolean; text?: string; error?: string; status: number }> {
  await sendSimCopyShortcut(udid!);
  return withSkipPbpaste(() => postPasteboard());
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
      session?.unsubscribe();
      server?.stop(true);
    });

    test("select all, Copy, POST /api/pasteboard returns the page text", async () => {
      await sendSimSelectAllShortcut(udid!);
      const body = await copyFromSim();
      expect(body.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.text).toContain(SAFARI_COPY_TEXT);
    }, 45_000);
  });

  describe("user app", () => {
    let session: { unsubscribe: () => void } | undefined;

    beforeAll(async () => {
      ensureFixtureInstalled(udid!);
      session = await launchWithoutReader(udid!, FIXTURE_BUNDLE);
      await Bun.sleep(300);
    }, 60_000);

    afterAll(() => {
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
