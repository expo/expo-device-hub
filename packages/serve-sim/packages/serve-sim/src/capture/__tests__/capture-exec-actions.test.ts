import { afterAll, beforeAll, expect, test } from "bun:test";
import WebSocket from "ws";

import { freePortAsync, UDID, useTempStateDir } from "../../__tests__/helpers";
import { simMiddleware } from "../../middleware";
import { servePreview, type PreviewServer } from "../../runtime";

// Capture host actions change or read recorded traffic, so an allowed cross-origin exec socket
// must not reach them; the preview's own origin still can.
const TOKEN = "capture-exec-actions-token";

let port: number;
let server: PreviewServer;
let stateDir: ReturnType<typeof useTempStateDir>;

beforeAll(async () => {
  stateDir = useTempStateDir();
  port = await freePortAsync();
  server = await servePreview({
    port,
    host: "127.0.0.1",
    middleware: simMiddleware({ basePath: "/", execToken: TOKEN, corsOrigins: ["https://expo.dev"] }),
  });
});

afterAll(() => {
  server?.stop(true);
  stateDir?.restore();
});

function runAction(origin: string, action: string, params: Record<string, unknown>): Promise<{ error?: string; exitCode?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, [`serve-sim.token.${TOKEN}`], { headers: { Origin: origin } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no reply for ${action} from ${origin}`));
    }, 5_000);
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { ready?: boolean; id?: number; error?: string; exitCode?: number };
      if (frame.ready) {
        ws.send(JSON.stringify({ id: 1, action, params }));
        return;
      }
      if (frame.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      resolve(frame);
    });
    ws.on("error", reject);
  });
}

for (const action of ["capture.enable", "capture.reboot", "capture.clear"]) {
  test(`refuses ${action} from an allowed cross-origin page`, async () => {
    expect(await runAction("https://expo.dev", action, { udid: UDID, enabled: false })).toMatchObject({
      error: "Network capture is same-origin only.",
    });
  });
}

test("still runs capture.clear for the preview's own origin", async () => {
  const reply = await runAction(`http://127.0.0.1:${port}`, "capture.clear", { udid: UDID });
  expect(reply.error).not.toBe("Network capture is same-origin only.");
});
