import { afterEach, beforeEach, expect, test } from "bun:test";
import WebSocket from "ws";
import { startProxy } from "./proxy";

let proxy: ReturnType<typeof startProxy>;
let launches: boolean[];
let restarts: number;
let starts: number;
let results: unknown[];
const sockets = new Set<WebSocket>();

beforeEach(() => {
  launches = [];
  restarts = 0;
  starts = 0;
  results = [];
  proxy = startProxy({
    backend: "http://127.0.0.1:1",
    device: "mock-owned-device",
    assets: import.meta.dir,
    fixtureLog: async () => "test-input-only\n",
    launch: async (keyboard) => {
      launches.push(keyboard);
    },
    restart: async () => {
      restarts++;
    },
    result(value) {
      results.push(value);
    },
    start() {
      starts++;
    },
  });
});

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  await proxy.close();
});

function post(path: string, headers: Record<string, string> = {}) {
  return fetch(proxy.url + "/_e2e/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ keyboard: true }),
  });
}

function bootstrapHeaders() {
  return {
    "x-hub-e2e-bootstrap": new URLSearchParams(new URL(proxy.runnerUrl).hash.slice(1)).get(
      "bootstrap",
    )!,
  };
}

async function claim() {
  const response = await post("start", bootstrapHeaders());
  expect(response.status).toBe(200);
  const { runId } = (await response.json()) as { runId: string };
  return { "x-hub-e2e-run": runId };
}

function discovery(headers: Record<string, string> = {}): Promise<string | undefined> {
  const socket = new WebSocket(proxy.url.replace("http:", "ws:") + "/api/devices/ws", {
    headers,
  });
  sockets.add(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Discovery socket did not settle")), 1_000);
    socket.onmessage = (event) => {
      clearTimeout(timer);
      resolve(String(event.data));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    socket.onclose = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
  });
}

test("foreign-origin actions cannot launch the fixture or restart the backend", async () => {
  const headers = { ...(await claim()), origin: "https://attacker.invalid" };
  expect((await post("launch", headers)).status).toBe(403);
  expect((await post("restart", headers)).status).toBe(403);
  expect(launches).toEqual([]);
  expect(restarts).toBe(0);
});

test("foreign-origin discovery WebSockets are refused before revealing the device", async () => {
  expect(await discovery({ origin: "https://attacker.invalid" })).toBeUndefined();
});

test("opaque origins cannot open discovery WebSockets", async () => {
  expect(await discovery({ origin: "null" })).toBeUndefined();
});

test("foreign-origin fixture reads are refused", async () => {
  const response = await fetch(proxy.url + "/_e2e/fixture", {
    headers: { origin: "https://attacker.invalid" },
  });
  expect(response.status).toBe(403);
});

test("a matching hostile Host and Origin cannot authorize an action", async () => {
  const host = "attacker.invalid:" + new URL(proxy.url).port;
  expect(
    (await post("launch", { ...(await claim()), host, origin: "http://" + host })).status,
  ).toBe(403);
  expect(launches).toEqual([]);
});

test("a hostile Host cannot expose native fixture input", async () => {
  const response = await fetch(proxy.url + "/_e2e/fixture", {
    headers: { host: "attacker.invalid:" + new URL(proxy.url).port },
  });
  expect(response.status).toBe(403);
});

test("a matching hostile Host and Origin cannot open a discovery WebSocket", async () => {
  const host = "attacker.invalid:" + new URL(proxy.url).port;
  expect(await discovery({ host, origin: "http://" + host })).toBeUndefined();
});

test("an explicit cross-site navigation cannot load the automatically running dashboard", async () => {
  const response = await fetch(proxy.url + "/?run", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("dashboard.js");
});

test("explicit cross-site requests without Origin cannot start scenarios", async () => {
  expect(
    (await post("start", { ...bootstrapHeaders(), "sec-fetch-site": "cross-site" })).status,
  ).toBe(403);
  expect(starts).toBe(0);
});

test("local dashboard navigation remains available with framing denied", async () => {
  for (const site of ["none", "same-origin"]) {
    const response = await fetch(proxy.url + "/?run", { headers: { "sec-fetch-site": site } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toContain("dashboard.js");
  }
});

test("same-origin browser actions, fixture reads and discovery remain available", async () => {
  const headers = { ...(await claim()), origin: proxy.url };
  expect((await post("launch", headers)).status).toBe(200);
  expect((await post("restart", headers)).status).toBe(200);
  expect(launches).toEqual([true]);
  expect(restarts).toBe(1);
  expect(await (await fetch(proxy.url + "/_e2e/fixture", { headers })).text()).toBe(
    "test-input-only\n",
  );
  expect(await discovery(headers)).toContain("mock-owned-device");
});

test("claimed local drivers without Origin retain actions, fixture reads and discovery", async () => {
  const headers = await claim();
  expect((await post("launch", headers)).status).toBe(200);
  expect((await post("restart", headers)).status).toBe(200);
  expect(launches).toEqual([true]);
  expect(restarts).toBe(1);
  expect(await (await fetch(proxy.url + "/_e2e/fixture")).text()).toBe("test-input-only\n");
  expect(await discovery()).toContain("mock-owned-device");
});

test("only one scenario runner can claim controls and submit the run result", async () => {
  const first = await post("start", bootstrapHeaders());
  expect(first.status).toBe(200);
  const { runId } = (await first.json()) as { runId: string };
  expect(runId).toBeString();
  expect((await post("start", bootstrapHeaders())).status).toBe(409);
  expect(starts).toBe(1);
  expect((await post("restart")).status).toBe(403);
  expect((await post("result")).status).toBe(403);
  expect((await post("result", { "x-hub-e2e-run": "another-run" })).status).toBe(403);
  expect(restarts).toBe(0);
  expect(results).toEqual([]);
  expect((await post("restart", { "x-hub-e2e-run": runId })).status).toBe(200);
  expect((await post("result", { "x-hub-e2e-run": runId })).status).toBe(200);
  expect(restarts).toBe(1);
  expect(results).toEqual([{ keyboard: true }]);
});

test("an unowned local request cannot claim or control the run", async () => {
  for (const origin of [undefined, proxy.url]) {
    const headers: Record<string, string> = origin ? { origin } : {};
    for (const path of [
      "start",
      "launch",
      "restart",
      "result",
      "input",
      "control-stall",
      "control-drop",
    ]) {
      expect((await post(path, headers)).status).toBe(403);
    }
  }
  expect(starts).toBe(0);
  expect(launches).toEqual([]);
  expect(restarts).toBe(0);
  expect(results).toEqual([]);
});

test("wrong bootstrap keys cannot claim the runner or leak through proxy responses", async () => {
  const key = bootstrapHeaders()["x-hub-e2e-bootstrap"];
  expect((await post("start", { "x-hub-e2e-bootstrap": "another-run" })).status).toBe(403);
  expect(starts).toBe(0);
  for (const path of ["/", "/?run", "/_e2e/state"]) {
    expect(await (await fetch(proxy.url + path)).text()).not.toContain(key);
  }
  await claim();
});
