import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, promises as fs, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PasteboardTooLargeError, writeSimPasteboard } from "../sim-pasteboard";
import { clipboardCapability, pasteboardTarget, requestInjectedPasteboard } from "../sim-pasteboard-reader";
import { pasteTextIntoSim } from "../sim-pasteboard-paste";
import { PasteboardCopyTimeoutError, copyFromSim, waitForPasteboardChange } from "../sim-pasteboard-copy";
import { withShimsAsync } from "./helpers";

function container(): string {
  return mkdtempSync(join(tmpdir(), "serve-sim-pasteboard-"));
}

function paths(root: string) {
  const dir = join(root, "tmp");
  return { dir, done: join(dir, "serve-sim-pasteboard.txt.done"), request: join(dir, "serve-sim-pasteboard.request") };
}

test("clipboard is a default all-apps capability with no load delay", () => {
  expect({
    name: clipboardCapability.name,
    defaultEnabled: clipboardCapability.defaultEnabled,
    scope: clipboardCapability.scope,
    loadDelayMs: clipboardCapability.loadDelayMs,
  }).toEqual({
    name: "clipboard",
    defaultEnabled: true,
    scope: "allApps",
    loadDelayMs: 0,
  });
});

async function answerOnce(root: string, text: string): Promise<boolean> {
  const { done, request } = paths(root);
  for (let attempt = 0; attempt < 200; attempt++) {
    const nonce = await fs.readFile(request, "utf-8").catch(() => null);
    if (nonce === null) {
      await Bun.sleep(5);
      continue;
    }
    await fs.rm(request, { force: true });
    await fs.writeFile(`${done}.pending`, `${nonce}\n${text}`);
    await fs.rename(`${done}.pending`, done);
    return true;
  }
  return false;
}

describe("requestInjectedPasteboard", () => {
  test("returns the text of an answer carrying our nonce", async () => {
    const root = container();
    const answered = answerOnce(root, "café 🎉");
    expect(await requestInjectedPasteboard(root, 3000)).toBe("café 🎉");
    expect(await answered).toBe(true);
  });

  test("serializes requests sharing an app container", async () => {
    const root = container();
    const answers = (async () => {
      expect(await answerOnce(root, "first")).toBe(true);
      expect(await answerOnce(root, "second")).toBe(true);
    })();
    const reads = await Promise.all([
      requestInjectedPasteboard(root, 3000),
      requestInjectedPasteboard(root, 3000),
    ]);
    await answers;
    expect(reads.sort()).toEqual(["first", "second"]);
  });

  test("ignores an answer left behind by an earlier request", async () => {
    const root = container();
    const { dir, done } = paths(root);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(done, "a-nonce-from-an-earlier-request\ntext from a request that timed out");

    expect(await requestInjectedPasteboard(root, 300)).toBeNull();
  });

  test("asks again after discarding a stale answer", async () => {
    const root = container();
    const { dir, done } = paths(root);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(done, "a-nonce-from-an-earlier-request\nstale");

    const answered = answerOnce(root, "fresh");
    expect(await requestInjectedPasteboard(root, 3000)).toBe("fresh");
    expect(await answered).toBe(true);
  });

  test("an expired reader answer does not consume the next request", async () => {
    const root = container();
    const { request, done } = paths(root);
    const claimed = `${request}.claimed`;
    const first = requestInjectedPasteboard(root, 200);
    for (let attempt = 0; attempt < 200 && !(await fs.stat(request).catch(() => null)); attempt++) {
      await Bun.sleep(5);
    }
    await fs.rename(request, claimed);
    const oldNonce = await fs.readFile(claimed, "utf-8");
    await fs.rm(claimed);
    expect(await first).toBeNull();

    const second = requestInjectedPasteboard(root, 3000);
    void second.catch(() => {});
    for (let attempt = 0; attempt < 200 && !(await fs.stat(request).catch(() => null)); attempt++) {
      await Bun.sleep(5);
    }
    const newNonce = await fs.readFile(request, "utf-8");
    expect(newNonce).not.toBe(oldNonce);
    await fs.writeFile(`${done}.pending`, `${oldNonce}\n${"x".repeat(5 * 1024 * 1024)}`);
    await fs.rename(`${done}.pending`, done);
    for (let attempt = 0; attempt < 200 && await fs.stat(done).catch(() => null); attempt++) {
      await Bun.sleep(5);
    }
    expect(await fs.stat(done).catch(() => null)).toBeNull();
    const answered = answerOnce(root, "fresh");
    expect(await second).toBe("fresh");
    expect(await answered).toBe(true);
  });

  test("rejects an oversized answer carrying our nonce", async () => {
    const root = container();
    const answered = answerOnce(root, "x".repeat(5 * 1024 * 1024));
    await expect(requestInjectedPasteboard(root, 3000)).rejects.toBeInstanceOf(PasteboardTooLargeError);
    expect(await answered).toBe(true);
  });

  test("keeps a fresh answer published while consuming a stale one", async () => {
    const root = container();
    const { request, done } = paths(root);
    const open = fs.open.bind(fs);
    let release!: () => void;
    let staleOpened!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const opened = new Promise<void>((resolve) => { staleOpened = resolve; });
    let held = false;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (!held && (args[0] === done || args[0] === `${done}.reading`)) {
        held = true;
        staleOpened();
        await gate;
      }
      return file;
    });
    const reading = requestInjectedPasteboard(root, 1000);
    void reading.catch(() => {});
    try {
      for (let attempt = 0; attempt < 200 && !(await fs.stat(request).catch(() => null)); attempt++) {
        await Bun.sleep(5);
      }
      expect(await fs.stat(request).catch(() => null)).not.toBeNull();
      await fs.writeFile(`${done}.pending`, "expired-nonce\nstale");
      await fs.rename(`${done}.pending`, done);
      await Promise.race([opened, Bun.sleep(1000).then(() => { throw new Error("Reader did not open the stale answer"); })]);
      expect(await answerOnce(root, "fresh")).toBe(true);
      release();
      expect(await reading).toBe("fresh");
    } finally {
      release();
      openSpy.mockRestore();
      await reading.catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a container that is not an absolute path", async () => {
    // `simctl get_app_container` exits 0 and prints "(null)" for an app with no
    // data container; joining that would write into the working directory.
    const before = readdirSync(process.cwd());
    expect(await requestInjectedPasteboard("(null)", 200)).toBeNull();
    expect(readdirSync(process.cwd())).toEqual(before);
  });

  test("returns null and clears the request when nothing answers", async () => {
    const root = container();
    expect(await requestInjectedPasteboard(root, 200)).toBeNull();
    const { request } = paths(root);
    expect(await fs.readFile(request, "utf-8").catch(() => null)).toBeNull();
  });
});

describe("pasteboardTarget", () => {
  test("asks the frontmost app", () => {
    expect(pasteboardTarget({ bundleId: "dev.expo.App" }, "host.exp.Exponent")).toEqual({
      bundleId: "dev.expo.App",
      relaunch: true,
    });
  });

  test("falls back to the app this session launched when nothing is frontmost", () => {
    expect(pasteboardTarget(null, "host.exp.Exponent")).toEqual({
      bundleId: "host.exp.Exponent",
      relaunch: true,
    });
  });

  test("asks the launched app over the Home screen but does not relaunch it", () => {
    expect(pasteboardTarget({ bundleId: "com.apple.springboard" }, "host.exp.Exponent")).toEqual({
      bundleId: "host.exp.Exponent",
      relaunch: false,
    });
  });

  test("has nothing to ask when no app is known", () => {
    expect(pasteboardTarget(null, null)).toBeNull();
    expect(pasteboardTarget({ bundleId: "com.apple.springboard" }, null)).toBeNull();
  });
});

describe("writeSimPasteboard", () => {
  test("waits for an app's delayed clipboard update and times out without one", async () => {
    let count = 5;
    const delayed = waitForPasteboardChange(async () => count, count, 1000);
    setTimeout(() => { count = 6; }, 300);
    await delayed;
    await expect(waitForPasteboardChange(async () => count, count, 100)).rejects.toBeInstanceOf(
      PasteboardCopyTimeoutError,
    );
  });

  test("checks once more when a copy finishes during the final wait", async () => {
    let count = 5;
    const waiting = waitForPasteboardChange(async () => count, count, 100);
    setTimeout(() => { count = 6; }, 90);
    await waiting;
  });

  test("holds the device lock through the paste shortcut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-paste-lock-test-"));
    const log = join(dir, "writes");
    const quotedLog = "'" + log.replaceAll("'", "'\\''") + "'";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let shortcutStarted!: () => void;
    const shortcut = new Promise<void>((resolve) => { shortcutStarted = resolve; });
    try {
      await withShimsAsync({ xcrun: `#!/bin/sh\ncat >> ${quotedLog}\nprintf '\n' >> ${quotedLog}\n` }, async () => {
        const udid = `PASTE-LOCK-TEST-${process.pid}`;
        const first = pasteTextIntoSim(udid, "alpha", async () => {
          shortcutStarted();
          await gate;
        });
        await shortcut;
        const second = writeSimPasteboard(udid, "beta");
        try {
          await Bun.sleep(100);
          expect(readFileSync(log, "utf8")).toBe("alpha\n");
        } finally {
          release();
        }
        await Promise.all([first, second]);
        expect(readFileSync(log, "utf8")).toBe("alpha\nbeta\n");
      });
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copy holds the device lock from the shortcut through the read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-copy-lock-test-"));
    const board = join(dir, "pasteboard");
    const count = join(dir, "change-count");
    const quoted = "'" + board.replaceAll("'", "'\\''") + "'";
    const quotedCount = "'" + count.replaceAll("'", "'\\''") + "'";
    // A one-slot simulator pasteboard: pbpaste prints it, pbcopy replaces it.
    const xcrun = `#!/bin/sh
if [ "$2" = get_app_container ]; then exit 1
elif [ "$2" = pbpaste ]; then cat ${quoted}
elif [ "$2" = install ] || [ "$2" = privacy ]; then exit 0
elif [ "$5" = --snapshot ]; then printf '1\\n'; base64 < ${quoted}
elif [ "$5" = --read-text ]; then cat ${quoted}
elif [ "$5" = --restore ]; then base64 -D > ${quoted}; count=$(cat ${quotedCount}); printf '%s' "$((count + 1))" > ${quotedCount}
elif [ "$5" = --change-count ]; then cat ${quotedCount}
else cat > ${quoted}; count=$(cat ${quotedCount} 2>/dev/null || printf 0); printf '%s' "$((count + 1))" > ${quotedCount}
fi
`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let shortcutStarted!: () => void;
    const shortcut = new Promise<void>((resolve) => { shortcutStarted = resolve; });
    try {
      await withShimsAsync({ xcrun }, async () => {
        const udid = `COPY-LOCK-TEST-${process.pid}`;
        await writeSimPasteboard(udid, "alpha");
        const copied = copyFromSim(udid, async () => {
          shortcutStarted();
          await gate;
          writeFileSync(board, "alpha");
          writeFileSync(count, String(Number(readFileSync(count, "utf8")) + 1));
        });
        await shortcut;
        const other = writeSimPasteboard(udid, "beta");
        try {
          await Bun.sleep(100);
          expect(readFileSync(board, "utf8")).toBe("alpha");
        } finally {
          release();
        }
        expect((await copied).text).toBe("alpha");
        await other;
        expect(readFileSync(board, "utf8")).toBe("beta");
      });
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves the clipboard untouched if the baseline change count cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-copy-baseline-test-"));
    const board = join(dir, "pasteboard");
    writeFileSync(board, "previous text");
    const xcrun = `#!/bin/sh
if [ "$2" = get_app_container ]; then exit 1
elif [ "$2" = install ] || [ "$2" = privacy ]; then exit 0
elif [ "$5" = --read-text ]; then cat '${board}'
elif [ "$5" = --change-count ]; then exit 1
else cat > '${board}'
fi
`;
    try {
      await withShimsAsync({ xcrun }, async () => {
        await expect(copyFromSim(`COPY-BASELINE-TEST-${process.pid}`, async () => {
          throw new Error("shortcut should not run");
        })).rejects.toThrow();
        expect(readFileSync(board, "utf8")).toBe("previous text");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports an oversized copied value without replacing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-copy-size-test-"));
    const board = join(dir, "pasteboard");
    const count = join(dir, "change-count");
    writeFileSync(board, "before");
    writeFileSync(count, "1");
    const xcrun = `#!/bin/sh
if [ "$2" = get_app_container ]; then printf '/sim/app\\n'
elif [ "$2" = privacy ]; then exit 0
elif [ "$5" = --read-text ]; then cat '${board}'
elif [ "$5" = --change-count ]; then cat '${count}'
else exit 1
fi
`;
    try {
      await withShimsAsync({ xcrun }, async () => {
        await expect(copyFromSim(`COPY-SIZE-TEST-${process.pid}`, async () => {
          writeFileSync(board, "x".repeat(4 * 1024 * 1024 + 1));
          writeFileSync(count, "2");
        })).rejects.toBeInstanceOf(PasteboardTooLargeError);
        expect(readFileSync(board).length).toBe(4 * 1024 * 1024 + 1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installs the Copy helper only when a simulator has lost it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-copy-install-test-"));
    const board = join(dir, "pasteboard");
    const count = join(dir, "count");
    const installed = join(dir, "installed");
    const installs = join(dir, "installs");
    writeFileSync(board, "copied");
    writeFileSync(count, "0");
    const xcrun = `#!/bin/sh
if [ "$2" = get_app_container ]; then [ -f '${installed}' ] && printf '/sim/app\\n' || exit 1
elif [ "$2" = install ]; then touch '${installed}'; printf 'install\\n' >> '${installs}'
elif [ "$2" = privacy ]; then exit 0
elif [ "$5" = --snapshot ]; then printf '1\\n'; base64 < '${board}'
elif [ "$5" = --read-text ]; then cat '${board}'
elif [ "$5" = --change-count ]; then cat '${count}'
else cat > '${board}'; current=$(cat '${count}'); printf '%s' "$((current + 1))" > '${count}'
fi
`;
    try {
      await withShimsAsync({ xcrun }, async () => {
        const udid = `COPY-INSTALL-TEST-${process.pid}`;
        const copy = () => copyFromSim(udid, async () => {
          writeFileSync(board, "copied");
          writeFileSync(count, String(Number(readFileSync(count, "utf8")) + 1));
        });
        await copy();
        await copy();
        expect(readFileSync(installs, "utf8")).toBe("install\n");
        rmSync(installed);
        await copy();
        expect(readFileSync(installs, "utf8")).toBe("install\ninstall\n");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects when simctl refuses the device", async () => {
    const text = "x".repeat(1024 * 1024);
    await expect(writeSimPasteboard("00000000-0000-0000-0000-000000000000", text)).rejects.toThrow();
  });
});
