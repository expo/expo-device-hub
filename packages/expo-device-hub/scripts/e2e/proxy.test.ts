import { afterEach, beforeEach, expect, test } from "bun:test";
import WebSocket from "ws";
import { startProxy } from "./proxy";

let proxy: ReturnType<typeof startProxy>;
let launches: boolean[];
let restarts: number;
let starts: number;
const sockets = new Set<WebSocket>();

beforeEach(() => {
  launches = [];
  restarts = 0;
  starts = 0;
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
    result() {},
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
  const headers = { origin: "https://attacker.invalid" };
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
  expect((await post("launch", { host, origin: "http://" + host })).status).toBe(403);
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
  expect((await post("start", { "sec-fetch-site": "cross-site" })).status).toBe(403);
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
  const headers = { origin: proxy.url };
  expect((await post("launch", headers)).status).toBe(200);
  expect((await post("restart", headers)).status).toBe(200);
  expect(launches).toEqual([true]);
  expect(restarts).toBe(1);
  expect(await (await fetch(proxy.url + "/_e2e/fixture", { headers })).text()).toBe(
    "test-input-only\n",
  );
  expect(await discovery(headers)).toContain("mock-owned-device");
});

test("trusted local drivers without Origin retain actions, fixture reads and discovery", async () => {
  expect((await post("launch")).status).toBe(200);
  expect((await post("restart")).status).toBe(200);
  expect(launches).toEqual([true]);
  expect(restarts).toBe(1);
  expect(await (await fetch(proxy.url + "/_e2e/fixture")).text()).toBe("test-input-only\n");
  expect(await discovery()).toContain("mock-owned-device");
});
