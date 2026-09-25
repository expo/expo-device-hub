import { afterAll, beforeAll, expect, test } from "bun:test";
import WebSocket from "ws";

import { freePortAsync, UDID, useTempStateDir } from "../../__tests__/helpers";
import { simMiddleware } from "../../middleware";
import { servePreview, type PreviewServer } from "../../runtime";

const TOKEN = "capture-exec-origin-token";

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

function subscribeToCapture(origin: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, [`serve-sim.token.${TOKEN}`], {
      headers: { Origin: origin, ...headers },
    });
    let data = "";
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no end frame for ${origin}; got ${data}`));
    }, 5_000);
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { ready?: boolean; sub?: number; data?: string; end?: boolean };
      if (frame.ready) {
        ws.send(JSON.stringify({ sub: 1, path: `/network-capture?device=${UDID}` }));
        return;
      }
      if (frame.sub !== 1) return;
      if (frame.data) data += frame.data;
      if (frame.end) {
        clearTimeout(timer);
        ws.close();
        resolve(data);
      }
    });
    ws.on("error", reject);
  });
}

test("refuses a cross-origin page that reaches capture through the exec socket", async () => {
  expect(await subscribeToCapture("https://expo.dev")).toContain("same-origin only");
});

test("still serves capture to the preview's own origin through the exec socket", async () => {
  expect(await subscribeToCapture(`http://127.0.0.1:${port}`)).toContain("No serve-sim device");
});

test("refuses a subscription the browser marked cross-site, whatever its origin says", async () => {
  const data = await subscribeToCapture(`http://127.0.0.1:${port}`, { "Sec-Fetch-Site": "cross-site" });
  expect(data).toContain("same-origin only");
});
