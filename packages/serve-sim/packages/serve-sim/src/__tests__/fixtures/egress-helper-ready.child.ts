import { expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as runtime from "../../runtime";
import * as egress from "../../egress";
import * as sessions from "../../device-session";
import * as sessionOwner from "../../session-owner";
import { stateFileForDevice } from "../../state";
import { useTempStateDir, withShimsAsync } from "../helpers";

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
test("checked resident boot disappears while the real CLI binds its preview", async () => {
  const state = useTempStateDir(),
    uid = "11111111-1111-4111-8111-111111111111";
  const argv = process.argv,
    helper = process.env.SERVE_SIM_STREAM_HELPER;
  const signals = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
  let gone = false,
    stopped = false,
    ownerDrained = false,
    middleware: any;
  const outputs: string[] = [];
  mock.module("../../egress", () => ({
    ...egress,
    checkResidentEgressBoot: async () => {
      if (gone) throw new Error("Simulator boot changed during preview binding");
      return { pid: 1234, startedAt: "1720000000:42" };
    },
  }));
  mock.module("../../runtime", () => ({
    ...runtime,
    servePreview: async (options: any) => {
      middleware = options.middleware;
      expect(existsSync(join(state.dir, "resident-wait"))).toBe(true);
      return {
        port: 32001,
        stop() {
          expect(ownerDrained).toBe(true);
          stopped = true;
        },
      };
    },
  }));
  mock.module("../../session-owner", () => ({
    ...sessionOwner,
    startSessionOwner: async () => {
      gone = true;
      return {
        async close() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          ownerDrained = true;
        },
      };
    },
  }));
  // The test reaches CLI preview publication; it must never load or operate the native addon.
  mock.module("../../device-session", () => ({
    ...sessions,
    getDeviceSession: () => {
      throw new Error("Native device sessions disabled in this fixture");
    },
  }));
  spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Exit(code);
  }) as never);
  spyOn(console, "log").mockImplementation((value: unknown) => {
    const text = String(value);
    outputs.push(text);
    if (text.startsWith("{") && JSON.parse(text).url) throw new Error("stale ready output");
  });
  try {
    process.env.SERVE_SIM_STREAM_HELPER = "1";
    process.argv = [
      process.execPath,
      join(import.meta.dir, "../../index.ts"),
      uid,
      "--quiet",
      "--orphan",
      "--require-token",
      "--transport",
      "webrtc",
    ];
    let failure: unknown;
    const waitMarker = join(state.dir, "resident-wait");
    await withShimsAsync(
      {
        xcrun: `#!/bin/sh
if [ "$1" = simctl ] && [ "$2" = bootstatus ] && [ "$3" = ${uid} ] && [ "$#" = 3 ]; then
  touch '${waitMarker}'
  exit 0
fi
exit 99
`,
      },
      async () => {
        // Only the non-booting readiness wait is modeled; no native command runs.
        try {
          await import("../../index");
        } catch (error) {
          failure = error;
        }
      },
    );
    expect(failure).toBeInstanceOf(Exit);
    expect((failure as Exit).code).toBe(1);
    expect(
      outputs.some((value) => value.includes("Simulator boot changed")),
      outputs.join("\n"),
    ).toBe(true);
    expect(outputs.some((value) => value.includes('"url"'))).toBe(false);
    expect(existsSync(stateFileForDevice(uid))).toBe(false);
    expect(stopped).toBe(true);
    expect(ownerDrained).toBe(true);
  } finally {
    await middleware?.dispose?.();
    for (const signal of signals)
      for (const listener of process.listeners(signal))
        if (!listeners.get(signal)!.includes(listener)) process.removeListener(signal, listener);
    process.argv = argv;
    if (helper === undefined) delete process.env.SERVE_SIM_STREAM_HELPER;
    else process.env.SERVE_SIM_STREAM_HELPER = helper;
    mock.restore();
    state.restore();
  }
});
