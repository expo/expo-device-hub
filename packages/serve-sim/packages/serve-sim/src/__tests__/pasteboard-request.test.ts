import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, promises as fs, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PasteboardTooLargeError } from "../sim-pasteboard";
import { clipboardCapability, pasteboardTarget, requestInjectedPasteboard } from "../sim-pasteboard-reader";

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
    const { request, done } = paths(root);
    const reading = requestInjectedPasteboard(root, 3000);
    void reading.catch(() => {});
    for (let attempt = 0; attempt < 200 && !(await fs.stat(request).catch(() => null)); attempt++) {
      await Bun.sleep(5);
    }
    // A reader claims the request, but an answer to an earlier request lands first.
    const nonce = await fs.readFile(request, "utf-8");
    await fs.rm(request);
    await fs.writeFile(`${done}.pending`, "a-nonce-from-an-earlier-request\nstale");
    await fs.rename(`${done}.pending`, done);

    for (let attempt = 0; attempt < 200 && !(await fs.stat(request).catch(() => null)); attempt++) {
      await Bun.sleep(5);
    }
    expect(await fs.readFile(request, "utf-8")).toBe(nonce);
    expect(await answerOnce(root, "fresh")).toBe(true);
    expect(await reading).toBe("fresh");
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
    expect(pasteboardTarget({ bundleId: "dev.expo.App" }, "host.exp.Exponent")).toBe("dev.expo.App");
  });

  test("falls back to the app this session launched when nothing is frontmost", () => {
    expect(pasteboardTarget(null, "host.exp.Exponent")).toBe("host.exp.Exponent");
  });

  test("asks the launched app over the Home screen", () => {
    expect(pasteboardTarget({ bundleId: "com.apple.springboard" }, "host.exp.Exponent")).toBe("host.exp.Exponent");
  });

  test("has nothing to ask when no app is known", () => {
    expect(pasteboardTarget(null, null)).toBeNull();
    expect(pasteboardTarget({ bundleId: "com.apple.springboard" }, null)).toBeNull();
  });
});
