import { expect, test, mock } from "bun:test";
import { createAppInstallBackend } from "../app-drop-client";

test("loads from the selected authenticated middleware and retries a failed load", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; token: string | null }> = [];
  globalThis.fetch = Object.assign(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), token: new Headers(init?.headers).get("Authorization") });
      return new Response("old server", { status: 404 });
    }),
    { preconnect: original.preconnect },
  );
  try {
    const action = mock(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const backend = createAppInstallBackend(
      "wss://hub.test/vendor/serve-sim/exec-ws",
      "session-secret",
      "U",
      action,
    );
    for (let i = 0; i < 2; i++)
      await expect(backend.installFile(new File([], "App.tgz"), () => {})).rejects.toThrow(
        "updated Simulator server",
      );
    expect(requests).toEqual(
      Array(2).fill({
        url: "https://hub.test/vendor/serve-sim/app-drop-client.js",
        token: "Bearer session-secret",
      }),
    );
    expect(action).toHaveBeenCalledTimes(0);
  } finally {
    globalThis.fetch = original;
  }
});

test("loads the served module once and binds it to the device, token and Worker URL", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  // A stand-in for serve-sim's app-drop-client.js that records what the backend passes in.
  const served = `export function createAppDropClient(transport, udid, worker) {
    return {
      installFile: async (file) => ({ udid, worker, file: file.name, reply: await transport("app.install", { udid }) }),
      installFolder: async () => undefined,
    };
  }`;
  globalThis.fetch = Object.assign(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${String(input)} ${new Headers(init?.headers).get("Authorization")}`);
      return new Response(served, { headers: { "content-type": "text/javascript" } });
    }),
    { preconnect: original.preconnect },
  );
  try {
    const action = mock(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const backend = createAppInstallBackend(
      "ws://hub.test/vendor/serve-sim/exec-ws",
      "session-secret",
      "U",
      action,
    );
    const first = await backend.installFile(new File([], "One.tgz"), () => {});
    await backend.installFile(new File([], "Two.tgz"), () => {});
    expect(first).toEqual({
      udid: "U",
      worker: {
        url: "http://hub.test/vendor/serve-sim/app-drop-worker.js",
        headers: { Authorization: "Bearer session-secret" },
      },
      file: "One.tgz",
      reply: { stdout: "", stderr: "", exitCode: 0 },
    } as never);
    expect(action).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([
      "http://hub.test/vendor/serve-sim/app-drop-client.js Bearer session-secret",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
