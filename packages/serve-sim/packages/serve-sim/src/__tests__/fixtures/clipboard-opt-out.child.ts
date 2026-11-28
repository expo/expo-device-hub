import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLaunchState, writeLaunchState } from "../../launch-state";
import { simMiddleware } from "../../middleware";
import type { UpgradeHandlerWebSocket } from "../../socket/types";
import { installShims, UDID, useTempStateDir } from "../helpers";

const ORIGIN = "http://127.0.0.1:3200";
const REFUSAL = "Clipboard reader is off on this server, by --disable clipboard.";

function readControls(middleware: ReturnType<typeof simMiddleware>) {
  const result = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
  let receive!: (data: string) => void;
  const socket: UpgradeHandlerWebSocket = {
    OPEN: 1,
    readyState: 1,
    send(data) {
      const reply = JSON.parse(String(data));
      if (reply.id === 1) result.resolve(reply);
    },
    on(event, handler) {
      if (event === "message") receive = handler as typeof receive;
    },
    close() {},
  };
  middleware.handleWebSocket?.(
    new Request(`${ORIGIN}/preview/exec-ws`, {
      headers: { "Sec-WebSocket-Protocol": "serve-sim.token.test-token" },
    }),
    socket,
  );
  receive(JSON.stringify({ id: 1, action: "clipboard.read", params: { udid: UDID } }));
  return result.promise;
}

test("an opted-out server allows pbpaste and never uses an existing reader", async () => {
  delete process.env.SERVE_SIM_SKIP_PBPASTE;
  const state = useTempStateDir();
  const shims = installShims({
    xcrun: `#!/bin/sh
printf '%s\\n' "$*" >> "$0.calls"
if [ "$2" = pbpaste ] && [ ! -f "$0.fail" ]; then
  printf 'native text'
  exit 0
fi
exit 1
`,
  });
  const middleware = simMiddleware({
    basePath: "/preview",
    clipboard: false,
    keychain: "unmanaged",
    execToken: "test-token",
    requirePreviewToken: true,
  });
  const readHttp = () =>
    middleware(
      new Request(`${ORIGIN}/preview/api/pasteboard?device=${UDID}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", Origin: ORIGIN },
      }),
    );
  try {
    writeLaunchState(UDID, {
      bundleId: "dev.expo.App",
      launchArgs: [],
      capabilities: {
        clipboard: {
          name: "clipboard",
          scope: "allApps",
          dylib: "/reader.dylib",
          bundleId: null,
          ownerPid: null,
        },
      },
    });
    const launchState = readLaunchState(UDID);
    expect(launchState?.capabilities.clipboard).toBeDefined();

    const success = await readHttp();
    expect(success?.status).toBe(200);
    expect(await success?.json()).toEqual({ ok: true, text: "native text" });
    const controlsSuccess = await readControls(middleware);
    expect(controlsSuccess.exitCode).toBe(0);
    expect(JSON.parse(controlsSuccess.stdout)).toEqual({ text: "native text" });

    writeFileSync(join(shims.dir, "xcrun.fail"), "");
    const refused = await readHttp();
    expect(refused?.status).toBe(503);
    expect(await refused?.json()).toEqual({ ok: false, error: REFUSAL });
    expect(await readControls(middleware)).toMatchObject({ exitCode: 1, stderr: REFUSAL });
    expect(readFileSync(join(shims.dir, "xcrun.calls"), "utf8").trim().split("\n")).toEqual(
      Array(4).fill(`simctl pbpaste ${UDID}`),
    );
    expect(readLaunchState(UDID)).toEqual(launchState);
  } finally {
    await middleware.dispose();
    shims.restore();
    state.restore();
  }
});
