import { expect, spyOn, test } from "bun:test";
import * as details from "../../foreground-app-details";
import { foregroundTracker, type ForegroundApp } from "../../foreground-tracker";
import { simMiddleware } from "../../middleware";
import { recordState, UDID, useTempStateDir } from "../helpers";

test("foreground clear invalidates pending details and allows the same app and PID to return", async () => {
  const state = useTempStateDir();
  const removeState = recordState(UDID, process.pid, 4551);
  const request = new AbortController();
  let report!: (app: ForegroundApp | null) => void;
  let releaseDetails!: () => void;
  const delayedDetails = new Promise<void>((resolve) => (releaseDetails = resolve));
  const subscribe = spyOn(foregroundTracker, "subscribe").mockImplementation((_udid, listener) => {
    if (listener) report = listener;
    return { unsubscribe() {} };
  });
  let lookups = 0;
  const appEvents = spyOn(details, "foregroundAppEvents").mockImplementation(
    async function* (_udid, app) {
      if (++lookups === 1) {
        yield { ...app, isReactNative: true };
        await delayedDetails;
        yield { ...app, isReactNative: true, label: "stale name" };
      } else {
        yield { ...app, isReactNative: true, label: "current name" };
      }
    },
  );
  const middleware = simMiddleware({
    basePath: "/preview",
    clipboard: "unmanaged",
    keychain: "unmanaged",
  });
  try {
    const response = await middleware(
      new Request(`http://localhost/preview/appstate?device=${UDID}`, {
        signal: request.signal,
      }),
    );
    expect(response?.status).toBe(200);
    const reader = response!.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toBe(":\n\n");

    const app = { bundleId: "com.example.app", pid: 17 };
    report(app);
    expect(await read()).toContain(app.bundleId);
    report(null);
    expect(await read()).toBe("event: foreground-cleared\ndata: null\n\n");
    releaseDetails();
    await Bun.sleep(0);
    report(app);
    expect(await read()).toContain('"label":"current name"');

    report({ bundleId: "com.example.second", pid: 18 });
    expect(await read()).toBe("event: foreground-cleared\ndata: null\n\n");
    expect(await read()).toContain("com.example.second");
  } finally {
    request.abort();
    releaseDetails();
    await middleware.dispose();
    appEvents.mockRestore();
    subscribe.mockRestore();
    removeState();
    state.restore();
  }
});
