import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";
import {
  ensureFixtureInstalled,
  firstBootedIosSim,
  FIXTURE_BUNDLE,
  openAppForPasteboard,
  PASTEBOARD_TEST_APPS,
  pasteboardFixture,
  pasteboardTool,
  SAFARI_BUNDLE,
  writeTestPasteboard,
} from "./pasteboard-sim";
import { requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";

const TEST_TOKEN = "test-token";
// Reads consult launch state, so keep a local serve-sim session's state out of it.
const stateDir = useTempStateDir();
afterAll(() => stateDir.restore());
const middleware = simMiddleware({ basePath: "/preview", execToken: TEST_TOKEN });

function pasteboardRequest(query = "", method = "POST", body?: BodyInit): Request {
  return new Request(`http://localhost:3200/preview/api/pasteboard${query}`, {
    method,
    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    ...(body === undefined ? {} : { body }),
  });
}

describe("/api/pasteboard", () => {
  test("rejects unsupported methods", async () => {
    const res = await middleware(pasteboardRequest("", "GET"));
    expect(res?.status).toBe(405);
    expect(res?.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("requires the preview token", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/pasteboard", { method: "POST" }),
    );
    expect(res?.status).toBe(401);
    expect(res?.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("rejects a malformed device udid", async () => {
    const res = await middleware(pasteboardRequest("?device=not-a-udid"));
    expect(res?.status).toBe(400);
    expect(res?.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid simulator device ID");
  });

  test("returns JSON when the pasteboard read fails", async () => {
    const unavailableUdid = "00000000-0000-0000-0000-000000000000";
    const res = await middleware(pasteboardRequest(`?device=${unavailableUdid}`));
    expect(res?.status).toBe(500);
    expect(res?.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  test("rejects invalid JSON before writing", async () => {
    const unavailableUdid = "00000000-0000-0000-0000-000000000000";
    const res = await middleware(
      pasteboardRequest(`?device=${unavailableUdid}`, "PUT", "{"),
    );
    expect(res?.status).toBe(400);
    expect(await res!.json()).toEqual({ ok: false, error: "Invalid JSON" });
  });

  test("rejects a body that is not an object with text", async () => {
    const unavailableUdid = "00000000-0000-0000-0000-000000000000";
    for (const body of ["null", "\"text\"", "{\"text\":1}"]) {
      const res = await middleware(pasteboardRequest(`?device=${unavailableUdid}`, "PUT", body));
      expect(res?.status).toBe(400);
      expect(await res!.json()).toEqual({ ok: false, error: "Clipboard text must be a string" });
    }
  });
});

const bootedUdid = firstBootedIosSim();
const endpointReady = !!(bootedUdid && pasteboardTool);
requireE2E("pasteboard endpoint E2E", endpointReady);
const describeWithSim = endpointReady ? describe : describe.skip;

for (const app of PASTEBOARD_TEST_APPS) {
  const run = "requireFixture" in app && !pasteboardFixture ? describe.skip : describeWithSim;
  run(`POST /api/pasteboard from ${app.label} (${bootedUdid ?? "<skipped>"})`, () => {
    let session: { unsubscribe: () => void } | undefined;

    beforeAll(async () => {
      if (app.bundleId === FIXTURE_BUNDLE) ensureFixtureInstalled(bootedUdid!);
      session = await openAppForPasteboard(bootedUdid!, app.bundleId);
    }, 60_000);

    afterAll(() => {
      session?.unsubscribe();
    }, 60_000);

    test("returns JSON text for an explicit device", async () => {
      const probe = `serve-sim-pasteboard-probe-${app.label.replace(/\s+/g, "-")}`;
      writeTestPasteboard(bootedUdid!, probe);
      const res = await middleware(
        pasteboardRequest(`?device=${encodeURIComponent(bootedUdid!)}`),
      );
      expect(res?.status).toBe(200);
      expect(res?.headers.get("content-type")).toBe("application/json");
      expect(res?.headers.get("access-control-allow-origin")).toBeNull();
      const body = (await res!.json()) as { ok: boolean; text: string };
      expect(body.ok).toBe(true);
      expect(body.text).toBe(probe);
    }, 45_000);

    if (app.bundleId === SAFARI_BUNDLE) {
      test("PUT writes text that POST reads back", async () => {
        const probe = "café 🎉 email+tag@x.com 日本語";
        const query = `?device=${encodeURIComponent(bootedUdid!)}`;
        const write = await middleware(
          pasteboardRequest(query, "PUT", JSON.stringify({ text: probe })),
        );
        expect(write?.status).toBe(200);
        expect(await write!.json()).toEqual({ ok: true });

        const read = await middleware(pasteboardRequest(query));
        expect(read?.status).toBe(200);
        expect(await read!.json()).toMatchObject({ ok: true, text: probe });
      }, 45_000);

      test("falls back to a booted simulator when no device is given", async () => {
        const res = await middleware(pasteboardRequest());
        expect(res?.status).toBe(200);
        expect(res?.headers.get("content-type")).toBe("application/json");
        const body = (await res!.json()) as { ok: boolean; text: string };
        expect(body.ok).toBe(true);
        expect(typeof body.text).toBe("string");
      }, 45_000);
    }
  });
}
