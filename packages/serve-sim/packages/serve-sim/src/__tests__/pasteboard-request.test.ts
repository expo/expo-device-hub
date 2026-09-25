import { describe, expect, test } from "bun:test";
import { mkdtempSync, promises as fs, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clipboardCapability, pasteboardTarget, pasteTextIntoSim, requestInjectedPasteboard, writeSimPasteboard } from "../sim-pasteboard";
import { withShimsAsync } from "./helpers";

function container(): string {
  return mkdtempSync(join(tmpdir(), "serve-sim-pasteboard-"));
}

function paths(root: string) {
  const dir = join(root, "tmp");
  const value = join(dir, "serve-sim-pasteboard.txt");
  return { dir, value, done: `${value}.done`, request: join(dir, "serve-sim-pasteboard.request") };
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
  const { value, done, request } = paths(root);
  for (let attempt = 0; attempt < 200; attempt++) {
    const nonce = await fs.readFile(request, "utf-8").catch(() => null);
    if (nonce === null) {
      await Bun.sleep(5);
      continue;
    }
    await fs.writeFile(value, text);
    await fs.rm(request, { force: true });
    await fs.writeFile(`${value}.pending`, nonce);
    await fs.rename(`${value}.pending`, done);
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
    const { dir, value, done } = paths(root);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(value, "text from a request that timed out");
    await fs.writeFile(done, "a-nonce-from-an-earlier-request");

    expect(await requestInjectedPasteboard(root, 300)).toBeNull();
  });

  test("asks again after discarding a stale answer", async () => {
    const root = container();
    const { dir, value, done } = paths(root);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(value, "stale");
    await fs.writeFile(done, "a-nonce-from-an-earlier-request");

    const answered = answerOnce(root, "fresh");
    expect(await requestInjectedPasteboard(root, 3000)).toBe("fresh");
    expect(await answered).toBe(true);
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

  test("rejects when simctl refuses the device", async () => {
    const text = "x".repeat(1024 * 1024);
    await expect(writeSimPasteboard("00000000-0000-0000-0000-000000000000", text)).rejects.toThrow();
  });
});
