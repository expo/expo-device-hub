import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import WebSocket from "ws";

import { isAllowedHost } from "../host-allowlist";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { freePortAsync } from "./helpers";

const TOKEN = "host-allowlist-token";

describe("isAllowedHost", () => {
  test("allows localhost, IP literals, and a missing Host", () => {
    for (const host of ["localhost", "localhost:3200", "app.localhost:3200", "127.0.0.1:3200", "10.0.1.112", "[::1]:3200", "::1", undefined, ""]) {
      expect(isAllowedHost(host)).toBe(true);
    }
  });

  test("refuses a loopback name followed by anything but a port number", () => {
    for (const host of ["localhost:abc", "localhost:3200x", "localhost:", "127.0.0.1:@attacker.example", "[::1]x", "[::1]:abc"]) {
      expect(isAllowedHost(host)).toBe(false);
    }
  });

  test("refuses two Host headers, even when one is allowed", () => {
    expect(isAllowedHost(["localhost", "attacker.example"])).toBe(false);
  });

  test("refuses other names, including ones that only start like loopback", () => {
    for (const host of ["attacker.example:3200", "127.0.0.1.attacker.example", "localhost.attacker.example", "mymac.local"]) {
      expect(isAllowedHost(host)).toBe(false);
    }
  });
});

function get(
  port: number,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { ...headers, host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Opens the exec socket with a forged Host and presents the token. The runtime completes the
 * handshake before the middleware sees the socket, so a refused host is closed before it can
 * authenticate; an allowed one gets `ready`.
 */
function authenticate(port: number, host: string): Promise<{ ready: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, { headers: { host, origin: `http://${host}` } });
    let ready = false;
    ws.on("open", () => ws.send(JSON.stringify({ token: TOKEN })));
    ws.on("message", (raw) => {
      if ((JSON.parse(String(raw)) as { ready?: boolean }).ready) ready = true;
    });
    ws.on("error", () => {});
    setTimeout(() => {
      ws.terminate();
      resolve({ ready });
    }, 500);
  });
}

describe("an ungated preview answers only for hosts it knows", () => {
  let server: PreviewServer;
  let port: number;

  beforeAll(async () => {
    port = await freePortAsync();
    const middleware = simMiddleware({ basePath: "/", execToken: TOKEN, corsOrigins: ["https://dashboard.example"] });
    server = await servePreview({ port, middleware, host: "127.0.0.1" });
  });

  afterAll(() => {
    server?.stop(true);
  });

  test("refuses a rebinding host before it serves the page or its token", async () => {
    const { status, body } = await get(port, "/", "attacker.example");
    expect(status).toBe(403);
    expect(body).toContain('does not answer for the host "attacker.example"');
    expect(body).not.toContain("execToken");
  });

  test("lets a configured origin read the refusal", async () => {
    const refused = await get(port, "/healthz", "attacker.example", { origin: "https://dashboard.example" });
    expect(refused.status).toBe(403);
    expect(refused.headers["access-control-allow-origin"]).toBe("https://dashboard.example");
    const other = await get(port, "/healthz", "attacker.example", { origin: "https://attacker.example" });
    expect(other.status).toBe(403);
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("serves localhost and an IP address", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      expect((await get(port, "/healthz", host)).status).toBe(200);
    }
    expect((await get(port, "/healthz", "mymac.local")).status).toBe(403);
  });

  test("closes a helper socket for a rebinding host, and survives two Host headers", async () => {
    const upgrade = (hosts: string[]) => new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /helper/ws?device=D HTTP/1.1\r\n${hosts.map((host) => `Host: ${host}\r\n`).join("")}` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      let reply = "";
      socket.on("data", (chunk) => void (reply += chunk.toString()));
      socket.on("close", () => resolve(reply));
      socket.on("error", () => resolve(reply));
      socket.setTimeout(2000, () => socket.destroy());
    });
    expect(await upgrade(["attacker.example"])).toBe("");
    expect(await upgrade(["localhost", "attacker.example"])).toBe("");
    // Still serving: the second request did not take the process down.
    expect((await get(port, "/healthz", `localhost:${port}`)).status).toBe(200);
  });

  test("closes the exec socket for a rebinding host before it can authenticate", async () => {
    expect(await authenticate(port, "attacker.example")).toEqual({ ready: false });
    expect(await authenticate(port, `localhost:${port}`)).toEqual({ ready: true });
  });
});

describe("--allow-any-host-when-insecure", () => {
  let server: PreviewServer;
  let port: number;

  beforeAll(async () => {
    port = await freePortAsync();
    server = await servePreview({ port, middleware: simMiddleware({ basePath: "/", allowAnyHostWhenInsecure: true }), host: "127.0.0.1" });
  });

  afterAll(() => {
    server?.stop(true);
  });

  test("answers for any name when asked to", async () => {
    for (const host of ["mymac.local", "tunnel.example"]) {
      expect((await get(port, "/healthz", host)).status).toBe(200);
    }
  });
});

describe("a token-gated preview", () => {
  let server: PreviewServer;
  let port: number;

  beforeAll(async () => {
    port = await freePortAsync();
    const middleware = simMiddleware({ basePath: "/", requirePreviewToken: true, execToken: "gated-token" });
    server = await servePreview({ port, middleware, host: "127.0.0.1" });
  });

  afterAll(() => {
    server?.stop(true);
  });

  test("leaves the Host check to the token gate, so tunnels and custom domains keep working", async () => {
    expect((await get(port, "/healthz", "tunnel.example")).status).toBe(200);
  });
});
