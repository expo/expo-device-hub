import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { simMiddleware } from "../middleware";
import { accessCookieName } from "../session-auth";
import { servePreview, type PreviewServer } from "../runtime";
import { freePortAsync, useTempStateDir } from "./helpers";

let server: PreviewServer;
let gatedServer: PreviewServer;
let url: string;
let gatedUrl: string;
let state: ReturnType<typeof useTempStateDir>;
const device = randomUUID();

beforeAll(async () => {
  state = useTempStateDir();
  const port = await freePortAsync();
  server = await servePreview({
    port,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      device,
      execToken: "recording-session-token",
      requirePreviewToken: false,
    }),
  });
  url = `http://127.0.0.1:${port}/helper/${device}/recording/video`;
  const gatedPort = await freePortAsync();
  gatedServer = await servePreview({
    port: gatedPort,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      device,
      execToken: "recording-session-token",
      requirePreviewToken: true,
    }),
  });
  gatedUrl = `http://127.0.0.1:${gatedPort}/helper/${device}/recording/video`;
});

afterAll(() => {
  server?.stop(true);
  gatedServer?.stop(true);
  state?.restore();
});

test("recording control passes the auth gate without a token when the preview is open", async () => {
  const start = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: true }),
  });
  expect([400, 404]).toContain(start.status);

  const stop = await fetch(url, { method: "DELETE" });
  expect([404, 409]).toContain(stop.status);
});

test("recording control requires a bearer token when the preview is gated", async () => {
  const start = await fetch(gatedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: true }),
  });
  expect(start.status).toBe(401);
  const stop = await fetch(gatedUrl, { method: "DELETE" });
  expect(stop.status).toBe(401);
});

test("gated recording control rejects a preview cookie without the bearer token", async () => {
  const token = "recording-session-token";
  const response = await fetch(gatedUrl, {
    method: "POST",
    headers: {
      Cookie: `${accessCookieName(token)}=${token}`,
      Origin: new URL(gatedUrl).origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ start: true, output: "/tmp/recording", recordingId: "test" }),
  });
  expect(response.status).toBe(401);
});


test("recording preflight permits lease renewal and stop", async () => {
  const response = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1",
      "Access-Control-Request-Method": "DELETE",
      "Access-Control-Request-Headers": "Authorization, x-recording-id",
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
  expect(response.headers.get("access-control-allow-headers")).toContain("x-recording-id");
});
