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
