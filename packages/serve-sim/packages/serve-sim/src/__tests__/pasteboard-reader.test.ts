import { expect, spyOn, test } from "bun:test";
import { promises as fs, readFileSync } from "fs";
import { join } from "path";
import { readLaunchState, writeLaunchState } from "../launch-state";
import { PasteboardUnavailableError, readSimPasteboardResult } from "../sim-pasteboard-reader";
import { useTempStateDir, withShimsAsync } from "./helpers";

const BUNDLE = "dev.expo.App";
const UDID = `PASTEBOARD-READ-${process.pid}`;

async function withReader(
  options: {
    enabled?: boolean;
    foreground?: string | null;
    launched?: string;
    container?: string;
    nativeText?: string;
    // Only an unexpected reader failure is logged; a read that cannot find an app is not.
    loggedErrors?: number;
  },
  run: (container: string) => Promise<void>,
): Promise<void> {
  const state = useTempStateDir();
  const previousSkip = process.env.SERVE_SIM_SKIP_PBPASTE;
  process.env.SERVE_SIM_SKIP_PBPASTE = options.nativeText === undefined ? "1" : "0";
  const container = options.container ?? join(state.dir, "container");
  const calls = join(state.dir, "calls");
  const foreground = options.foreground === undefined ? BUNDLE : options.foreground;
  writeLaunchState(UDID, {
    ...(options.launched ? { bundleId: options.launched } : {}),
    launchArgs: [],
    capabilities: options.enabled === false ? {} : {
      clipboard: { name: "clipboard", scope: "allApps", dylib: "/reader.dylib", bundleId: null, ownerPid: process.pid },
    },
  });
  const initialState = readLaunchState(UDID);
  const shim = `#!/usr/bin/env bun
import { appendFileSync } from "fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
if (args[1] === "pbpaste") process.stdout.write(${JSON.stringify(options.nativeText ?? "")});
else if (args[1] === "get_app_container") console.log(${JSON.stringify(container)});
else if (args.includes("log") && args.includes("show") && ${foreground !== null}) {
  console.log(JSON.stringify({ eventMessage: "[app<" + ${JSON.stringify(foreground)} + ">:11] Setting process visibility to: Foreground" }));
}
`;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await withShimsAsync({ xcrun: shim }, async () => {
      await run(container);
      expect(log).toHaveBeenCalledTimes(options.loggedErrors ?? 0);
      const commands = readFileSync(calls, "utf8");
      expect(commands).not.toContain(`simctl terminate ${UDID}`);
      expect(commands).not.toContain(`simctl launch ${UDID}`);
      expect(commands).not.toContain("DYLD_INSERT_LIBRARIES");
      expect(readLaunchState(UDID)).toEqual(initialState);
    });
  } finally {
    log.mockRestore();
    if (previousSkip === undefined) delete process.env.SERVE_SIM_SKIP_PBPASTE;
    else process.env.SERVE_SIM_SKIP_PBPASTE = previousSkip;
    state.restore();
  }
}

async function answer(container: string): Promise<void> {
  const request = join(container, "tmp", "serve-sim-pasteboard.request");
  const done = join(container, "tmp", "serve-sim-pasteboard.txt.done");
  for (let attempt = 0; attempt < 400; attempt++) {
    const nonce = await fs.readFile(request, "utf8").catch(() => null);
    if (nonce === null) { await Bun.sleep(5); continue; }
    await fs.rm(request);
    await fs.writeFile(`${done}.pending`, `${nonce}\nclipboard text`);
    await fs.rename(`${done}.pending`, done);
    return;
  }
  throw new Error("The clipboard request was not published");
}

test("pbpaste succeeds without an enabled reader or an app", async () => {
  await withReader({ enabled: false, foreground: null, nativeText: "native text" }, async () => {
    expect(await readSimPasteboardResult(UDID)).toEqual({ text: "native text" });
  });
});

test.each([BUNDLE, null, "com.apple.springboard"])("asks an initialized reader with foreground %p", async (foreground) => {
  await withReader({ foreground, launched: BUNDLE }, async (container) => {
    const answered = answer(container);
    void answered.catch(() => {});
    try {
      expect(await readSimPasteboardResult(UDID)).toEqual({ text: "clipboard text" });
      await answered;
    } finally {
      await answered.catch(() => {});
    }
  });
});

test("does not reactivate a disabled reader", async () => {
  await withReader({ enabled: false }, async () => {
    await expect(readSimPasteboardResult(UDID)).rejects.toThrow("Start a session with clipboard enabled and retry");
  });
});

test("a missing reader asks for an explicit app restart", async () => {
  await withReader({}, async () => {
    const error = await readSimPasteboardResult(UDID).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PasteboardUnavailableError);
    expect((error as Error).message).toContain("Restart the app and retry");
  });
});

test("Home without an eligible app asks to open an app", async () => {
  await withReader({ foreground: "com.apple.springboard" }, async () => {
    await expect(readSimPasteboardResult(UDID)).rejects.toThrow("Open the app you copied from and retry");
  });
});

test("Home with an unresponsive remembered app asks to open that app", async () => {
  await withReader({ foreground: "com.apple.springboard", launched: BUNDLE }, async () => {
    await expect(readSimPasteboardResult(UDID)).rejects.toThrow("Open the app you copied from and retry");
  });
});

test("Home with a reader I/O failure logs it and asks to open an app without exposing paths", async () => {
  await withReader({ foreground: "com.apple.springboard", launched: BUNDLE, container: "/dev/null/clipboard", loggedErrors: 1 }, async () => {
    const error = await readSimPasteboardResult(UDID).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PasteboardUnavailableError);
    expect((error as Error).message).toContain("Open the app you copied from and retry");
    expect((error as Error).message).not.toContain("/dev/null");
  });
});

test("a system app without a data container asks to open another app", async () => {
  await withReader({ container: "(null)" }, async () => {
    await expect(readSimPasteboardResult(UDID)).rejects.toThrow("Open another app and retry");
  });
});
