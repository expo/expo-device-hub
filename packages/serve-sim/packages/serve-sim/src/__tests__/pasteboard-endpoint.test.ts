import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { statSync, writeFileSync } from "fs";
import { join } from "path";
import { simMiddleware } from "../middleware";
import { servePreview } from "../runtime";
import { MAX_PASTEBOARD_TEXT_BYTES } from "../sim-pasteboard";
import {
  ensureFixtureInstalled,
  FIXTURE_BUNDLE,
  openAppForPasteboard,
  PASTEBOARD_TEST_APPS,
  pasteboardFixture,
  pasteboardTool,
  SAFARI_BUNDLE,
  writeTestPasteboard,
} from "./pasteboard-sim";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { installShims, useTempStateDir } from "./helpers";

const TEST_TOKEN = "test-token";
// Reads consult launch state, so keep a local serve-sim session's state out of it.
const stateDir = useTempStateDir();
afterAll(() => stateDir.restore());
const ALLOWED_CORS_ORIGIN = "https://tools.example.com";
const middleware = simMiddleware({
  basePath: "/preview",
  execToken: TEST_TOKEN,
  corsOrigins: [ALLOWED_CORS_ORIGIN],
});
const PREVIEW_ORIGIN = "http://localhost:3200";
const OTHER_ORIGIN = "https://other.example.com";

function pasteboardRequest(
  query = "",
  method = "POST",
  body?: BodyInit,
  origin: string | null = PREVIEW_ORIGIN,
): Request {
  return new Request(`http://localhost:3200/preview/api/pasteboard${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(origin === null ? {} : { Origin: origin }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

const hostedMiddleware = simMiddleware({
  basePath: "/preview",
  execToken: TEST_TOKEN,
  requirePreviewToken: true,
});

function hostedPasteboardRequest(origin: string) {
  return hostedMiddleware(
    new Request("https://sim.example.com/preview/api/pasteboard?device=not-a-udid", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, Host: "sim.example.com", Origin: origin },
    }),
  );
}

describe("/api/pasteboard", () => {
  test("rejects unsupported methods", async () => {
    const res = await middleware(pasteboardRequest("", "GET"));
    expect(res?.status).toBe(405);
    expect(res?.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
  });

  test("rejects a request with no Origin, even with the token", async () => {
    for (const method of ["POST", "PUT"]) {
      const res = await middleware(pasteboardRequest("", method, method === "PUT" ? "{}" : undefined, null));
      expect(res?.status).toBe(403);
      expect(await res!.json()).toEqual({
        ok: false,
        error: "This origin cannot use the simulator clipboard",
      });
    }
  });

  test("rejects an origin CORS does not allow, even with the token", async () => {
    for (const origin of [OTHER_ORIGIN, "null", "file://localhost"]) {
      const res = await middleware(pasteboardRequest("", "POST", undefined, origin));
      expect(res?.status).toBe(403);
      expect(res?.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("accepts a --cors-origin site like the other routes", async () => {
    const res = await middleware(
      pasteboardRequest("?device=not-a-udid", "POST", undefined, ALLOWED_CORS_ORIGIN),
    );
    // Past the origin check, the malformed device ID answers.
    expect(res?.status).toBe(400);
    expect(res?.headers.get("access-control-allow-origin")).toBe(ALLOWED_CORS_ORIGIN);
  });

  test("accepts a hosted preview's own origin without --cors-origin", async () => {
    const res = await hostedPasteboardRequest("https://sim.example.com");
    // Past the origin check, the malformed device ID answers.
    expect(res?.status).toBe(400);
    expect(await res!.json()).toEqual({ ok: false, error: "Invalid simulator device ID" });
  });

  test("rejects an origin that is not the hosted preview's own", async () => {
    const res = await hostedPasteboardRequest(OTHER_ORIGIN);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({ ok: false, error: "This origin cannot use the simulator clipboard" });
  });

  test("answers the preflight only for an allowed origin", async () => {
    const preflight = (origin: string) =>
      middleware(
        new Request("http://localhost:3200/preview/api/pasteboard", {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization",
          },
        }),
      );
    expect((await preflight(ALLOWED_CORS_ORIGIN))?.headers.get("access-control-allow-origin"))
      .toBe(ALLOWED_CORS_ORIGIN);
    expect((await preflight(OTHER_ORIGIN))?.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("requires the preview token", async () => {
    const res = await middleware(
      new Request("http://localhost:3200/preview/api/pasteboard", {
        method: "POST",
        headers: { Origin: PREVIEW_ORIGIN },
      }),
    );
    expect(res?.status).toBe(401);
    expect(res?.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
  });

  test("rejects a malformed device udid", async () => {
    const res = await middleware(pasteboardRequest("?device=not-a-udid"));
    expect(res?.status).toBe(400);
    expect(res?.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid simulator device ID");
  });

  test("returns actionable JSON when no app can answer", async () => {
    const shims = installShims({ xcrun: "#!/bin/sh\nprintf 'diagnostic\\n' >&2\nexit 1\n" });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      // No simulator has this UDID. The accessibility bridge does not go through the xcrun shim,
      // so a booted device (such as the EAS worker's 404F2659…) would report its foreground app.
      const device = "00000000-0000-0000-0000-000000000000";
      const res = await middleware(pasteboardRequest(`?device=${device}`));
      expect(res?.status).toBe(503);
      expect(res?.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
      const body = (await res!.json()) as { ok: boolean; error: string };
      expect(body).toEqual({ ok: false, error: "Could not read the simulator clipboard. Open the app you copied from and retry." });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      shims.restore();
    }
  });

  test("returns 413 when simulator clipboard text exceeds the read cap", async () => {
    const shims = installShims({ xcrun: "#!/bin/sh\nprintf 'diagnostic\\n' >&2\nhead -c 4194305 /dev/zero\n" });
    try {
      const device = "404F2659-7202-4450-8465-912BD2AB744B";
      const res = await middleware(pasteboardRequest(`?device=${device}`));
      expect(res?.status).toBe(413);
      expect(res?.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
      expect(await res!.json()).toEqual({ ok: false, error: "Simulator clipboard text is too large" });
    } finally {
      shims.restore();
    }
  });

  test("returns 503 when diagnostics exceed the buffer with a small clipboard", async () => {
    const shims = installShims({ xcrun: "#!/bin/sh\nprintf x\nhead -c 4194305 /dev/zero >&2\n" });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const device = "00000000-0000-0000-0000-000000000000";
      const res = await middleware(pasteboardRequest(`?device=${device}`));
      expect(res?.status).toBe(503);
      expect(res?.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
      expect(await res!.json()).toEqual({ ok: false, error: "Could not read the simulator clipboard. Open the app you copied from and retry." });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      shims.restore();
    }
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

  test("writes and reads text through the simulator pasteboard commands", async () => {
    const shims = installShims({
      xcrun: '#!/bin/sh\nif [ "$2" = "spawn" ]; then cat > "$TEST_PASTEBOARD_FILE"; else cat "$TEST_PASTEBOARD_FILE"; fi\n',
    });
    const oldFile = process.env.TEST_PASTEBOARD_FILE;
    const oldToolDir = process.env.SERVE_SIM_SIMPB_DIR;
    process.env.TEST_PASTEBOARD_FILE = join(shims.dir, "pasteboard.txt");
    process.env.SERVE_SIM_SIMPB_DIR = shims.dir;
    writeFileSync(join(shims.dir, "serve-sim-pasteboard"), "");
    try {
      const device = "404F2659-7202-4450-8465-912BD2AB744B";
      const text = "café 🎉  \n";
      const write = await middleware(pasteboardRequest(`?device=${device}`, "PUT", JSON.stringify({ text })));
      expect(write?.status).toBe(200);
      expect(await write!.json()).toEqual({ ok: true });
      const read = await middleware(pasteboardRequest(`?device=${device}`));
      expect(read?.status).toBe(200);
      expect(await read!.json()).toEqual({ ok: true, text });
    } finally {
      if (oldFile === undefined) delete process.env.TEST_PASTEBOARD_FILE;
      else process.env.TEST_PASTEBOARD_FILE = oldFile;
      if (oldToolDir === undefined) delete process.env.SERVE_SIM_SIMPB_DIR;
      else process.env.SERVE_SIM_SIMPB_DIR = oldToolDir;
      shims.restore();
    }
  });

  test("writes 4 MiB of text whose JSON body is larger", async () => {
    const shims = installShims({ xcrun: '#!/bin/sh\ncat > "$TEST_PASTEBOARD_FILE"\n' });
    const oldFile = process.env.TEST_PASTEBOARD_FILE;
    const oldToolDir = process.env.SERVE_SIM_SIMPB_DIR;
    process.env.TEST_PASTEBOARD_FILE = join(shims.dir, "pasteboard.txt");
    process.env.SERVE_SIM_SIMPB_DIR = shims.dir;
    writeFileSync(join(shims.dir, "serve-sim-pasteboard"), "");
    try {
      const device = "404F2659-7202-4450-8465-912BD2AB744B";
      // Each newline doubles in JSON, so this body is over 4 MiB.
      const text = "\n".repeat(1024) + "x".repeat(MAX_PASTEBOARD_TEXT_BYTES - 1024);
      const write = await middleware(pasteboardRequest(`?device=${device}`, "PUT", JSON.stringify({ text })));
      expect(write?.status).toBe(200);
      expect(statSync(process.env.TEST_PASTEBOARD_FILE).size).toBe(MAX_PASTEBOARD_TEXT_BYTES);
    } finally {
      if (oldFile === undefined) delete process.env.TEST_PASTEBOARD_FILE;
      else process.env.TEST_PASTEBOARD_FILE = oldFile;
      if (oldToolDir === undefined) delete process.env.SERVE_SIM_SIMPB_DIR;
      else process.env.SERVE_SIM_SIMPB_DIR = oldToolDir;
      shims.restore();
    }
  });

  test("returns a JSON 413 for a body over twice the text limit", async () => {
    const device = "404F2659-7202-4450-8465-912BD2AB744B";
    const body = JSON.stringify({ text: "x".repeat(2 * MAX_PASTEBOARD_TEXT_BYTES) });
    const res = await middleware(pasteboardRequest(`?device=${device}`, "PUT", body));
    expect(res?.status).toBe(413);
    expect(res?.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
    expect(await res!.json()).toEqual({ ok: false, error: "Clipboard text is too large" });
  });

  test("the standalone server returns a CORS-readable JSON 413 for text over 4 MiB", async () => {
    const server = await servePreview({ port: 0, middleware });
    try {
      const device = "404F2659-7202-4450-8465-912BD2AB744B";
      const response = await fetch(`http://127.0.0.1:${server.port}/preview/api/pasteboard?device=${device}`, {
        method: "PUT",
        headers: { Origin: ALLOWED_CORS_ORIGIN, Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ text: "x".repeat(MAX_PASTEBOARD_TEXT_BYTES + 1) }),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_CORS_ORIGIN);
      expect(await response.json()).toEqual({ ok: false, error: "Clipboard text is too large" });
    } finally {
      server.stop();
    }
  }, 20_000);
});

const bootedUdid = e2eDevice();
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
      expect(res?.headers.get("access-control-allow-origin")).toBe(PREVIEW_ORIGIN);
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
