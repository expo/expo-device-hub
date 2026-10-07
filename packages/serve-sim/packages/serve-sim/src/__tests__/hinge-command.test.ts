import { afterEach, expect, test } from "bun:test";
import { readHingeStateFromWs, sendHingeAngleToWs } from "../hinge-command";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

function start(reply?: (angle: number) => unknown) {
  const received: unknown[] = [];
  const authorization: Array<string | null> = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      authorization.push(req.headers.get("authorization"));
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const frame = Buffer.from(data);
        const payload = JSON.parse(frame.subarray(1).toString());
        received.push({ tag: frame[0], payload });
        // Screen updates may arrive before the operation's acknowledgement.
        ws.send(Buffer.concat([Buffer.from([0x82]), Buffer.from('{"width":2007,"height":2853}')]));
        if (reply) ws.send(Buffer.concat([Buffer.from([0x8f]), Buffer.from(JSON.stringify(reply(payload.angle)))]));
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/ws`, received, authorization };
}

test("sends hinge presets through the authenticated input channel and waits for acknowledgement", async () => {
  const { url, received, authorization } = start((angle) => ({ ok: true, angle }));
  for (const angle of [0, 90, 180]) await sendHingeAngleToWs(url, angle, { token: "test-session" });
  expect(received).toEqual([0, 90, 180].map((angle) => ({ tag: 0x0f, payload: { angle } })));
  expect(authorization).toEqual(["Bearer test-session", "Bearer test-session", "Bearer test-session"]);
});

test("reports a rejected hinge operation instead of claiming success", async () => {
  const { url } = start(() => ({ ok: false, error: "This simulator has no hinge" }));
  await expect(sendHingeAngleToWs(url, 90)).rejects.toThrow("This simulator has no hinge");
});

test("times out when a server does not acknowledge hinge control", async () => {
  const { url } = start();
  await expect(sendHingeAngleToWs(url, 90, { timeoutMs: 50 })).rejects.toThrow("Timed out");
});

test("rejects a malformed acknowledgement without crashing the process", async () => {
  const { url } = start(() => null);
  await expect(sendHingeAngleToWs(url, 90)).rejects.toThrow("Invalid hinge control acknowledgement");
});

test("rejects invalid angles before opening the input connection", async () => {
  const { url, received, authorization } = start((angle) => ({ ok: true, angle }));
  for (const angle of [-1, 181, NaN, Infinity]) {
    await expect(sendHingeAngleToWs(url, angle)).rejects.toThrow("0–180");
  }
  expect(received).toEqual([]);
  expect(authorization).toEqual([]);
});

function serveConfigs(configs: unknown[]) {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      open(ws) {
        for (const config of configs) ws.send(Buffer.concat([Buffer.from([0x82]), Buffer.from(JSON.stringify(config))]));
      },
      message() {},
    },
  });
  return `ws://127.0.0.1:${server.port}/ws`;
}

test("reads the hinge state once the server has probed the simulator", async () => {
  const url = serveConfigs([
    { width: 2007, height: 2853 },
    { width: 2007, height: 2853, supportsHingeAngle: true, hingeAngle: 90, hingePose: "book", physicalOrientation: "portrait", tableMode: false, tableModeAvailable: true },
  ]);
  expect(await readHingeStateFromWs(url)).toEqual({
    hingeAngle: 90,
    hingePose: "book",
    physicalOrientation: "portrait",
    tableMode: false,
    tableModeAvailable: true,
  });
});

test("reports a simulator without a hinge instead of an empty state", async () => {
  const url = serveConfigs([{ width: 1206, height: 2622, supportsHingeAngle: false }]);
  await expect(readHingeStateFromWs(url)).rejects.toThrow("Hinge control is unavailable");
});
