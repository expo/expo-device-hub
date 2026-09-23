import { e2eDevice } from "./e2e-preconditions";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import WebSocket from "ws";

import { freePortAsync } from "./helpers";

/**
 * The gate, against the shipped artifact.
 *
 * Everything else that covers `--require-token` runs the middleware in-process. This spawns
 * `dist/serve-sim.js` the way EAS does, so the bundle is what answers: the preview HTML is a
 * build-time constant and the CLI re-execs itself, neither of which a source-level test exercises.
 */
const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");


async function waitFor(check: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const udid = e2eDevice();
const describeIfSim = udid && existsSync(CLI) ? describe : describe.skip;

describeIfSim("serve-sim --require-token (built CLI)", () => {
  let server: ChildProcess | null = null;
  let baseUrl = "";
  let token = "";
  let output = "";

  beforeAll(async () => {
    const port = await freePortAsync();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("node", [
      CLI,
      "--require-token",
      "--quiet",
      "--frame-ancestor",
      "https://expo.test",
      "--port",
      String(port),
      udid!,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    // The gate mints the token at startup and only --quiet reports it, so the orchestrator (and
    // this test) has no other way to learn it.
    const gotToken = await waitFor(async () => {
      for (const line of output.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { token?: string; devices?: Array<{ token?: string }> };
          const found = parsed.token ?? parsed.devices?.[0]?.token;
          if (typeof found === "string" && found.length > 0) {
            token = found;
            return true;
          }
        } catch {}
      }
      return false;
    }, 60_000);

    if (!gotToken) throw new Error(`no token in --quiet output\n${output.slice(0, 800)}`);

    const ready = await waitFor(async () => {
      try {
        return (await fetch(`${baseUrl}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
    if (!ready) throw new Error(`serve-sim never became ready\n${output.slice(0, 800)}`);
  }, 120_000);

  afterAll(() => {
    server?.kill("SIGKILL");
  });

  test("liveness stays open so a probe without the token still works", async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  test("refuses every gated surface without the token", async () => {
    for (const path of ["/", "/api", "/metrics", `/helper/${udid}/camera/status`]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      expect(response.status).toBe(401);
    }
  });

  test("accepts a bearer token on the api", async () => {
    const response = await fetch(`${baseUrl}/api`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  // The page opens the control socket with this, so a gated /api still has to hand it over. The
  // protection is that /api itself needs the token first, which the refusal test above covers.
  test("still gives an authenticated caller the token the page needs", async () => {
    const response = await fetch(`${baseUrl}/api`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const config = (await response.json()) as { execToken?: string; requireToken?: boolean };
    expect(config.execToken).toBe(token);
    // The Share button adds the token to the link only when this flag is set.
    expect(config.requireToken).toBe(true);
  });

  // The page replaces its whole config from this stream, so a share link built after a device
  // switch is only tokened if the pushed config says the preview is gated.
  test("keeps the gated flag on the config it pushes over the event stream", async () => {
    const response = await fetch(`${baseUrl}/api/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const deadline = Date.now() + 10_000;
    while (!/data: .*\n\n/.test(received) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    const config = JSON.parse(/data: (.*)\n\n/.exec(received)![1]!) as { requireToken?: boolean };
    expect(config.requireToken).toBe(true);
  }, 20_000);

  test("trades the link's query token for a cookie and then serves the page", async () => {
    const redirect = await fetch(`${baseUrl}/?token=${token}`, {
      headers: {
        accept: "text/html",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/");

    const cookie = (redirect.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await fetch(`${baseUrl}/`, {
      headers: {
        cookie,
        accept: "text/html",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
    });

    // Only the built bundle can answer this: the HTML is a build-time constant.
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<html");
  });

  test("shows a browser the HTML 401 page with the frame policy", async () => {
    const response = await fetch(`${baseUrl}/`, {
      headers: { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://expo.test",
    );
    expect(await response.text()).not.toContain(token);
  });

  test("frames the preview from a cookie the embedding site can send, and says who may embed", async () => {
    const redirect = await fetch(`${baseUrl}/?token=${token}`, {
      headers: {
        accept: "text/html",
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
        "x-forwarded-proto": "https",
      },
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);

    const setCookie = redirect.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Partitioned");

    const page = await fetch(`${baseUrl}/`, {
      headers: {
        cookie: setCookie.split(";")[0]!,
        accept: "text/html",
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
    });

    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://expo.test",
    );
  });

  test("closes a control socket that never presents the token", async () => {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/exec-ws`);
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      ws.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    ws.close();
    expect(closed).toBe(true);
  }, 20_000);

  test("runs a typed action over an authenticated control socket", async () => {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/exec-ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const replies: Array<Record<string, unknown>> = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply")), 20_000);
      ws.on("open", () => ws.send(JSON.stringify({ token })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        replies.push(msg);
        if (msg.ready === true) {
          ws.send(JSON.stringify({ id: 1, action: "appearance.get", params: { udid } }));
          return;
        }
        if (msg.id === 1) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("error", reject);
    });
    ws.close();

    expect(replies[0]).toMatchObject({ ready: true });
    const result = replies.find((r) => r.id === 1) as { stdout?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(String(result.stdout).trim()).toMatch(/^(light|dark|unsupported)$/);
  }, 40_000);

  test("refuses a shell command on the control socket", async () => {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/exec-ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply")), 20_000);
      ws.on("open", () => ws.send(JSON.stringify({ token })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.ready === true) {
          ws.send(JSON.stringify({ id: 2, command: "id > /tmp/pwned" }));
          return;
        }
        clearTimeout(timer);
        resolve(msg);
      });
      ws.on("error", reject);
    });
    ws.close();

    expect(reply).toMatchObject({ id: 2 });
    expect(String(reply.error)).toContain("unsupported request");
  }, 40_000);

  test("the removed exec route is gone rather than merely gated", async () => {
    const response = await fetch(`${baseUrl}/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command: "id" }),
    });
    expect(response.status).toBe(404);
  });
});
