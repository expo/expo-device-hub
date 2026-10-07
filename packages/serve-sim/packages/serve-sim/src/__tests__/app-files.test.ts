import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { UPLOAD_DIR } from "../host-paths";
import { runHostActionAsync } from "../host-actions";
import { withLaunchStateLock } from "../launch-state-lock";
import { UDID, installShims, withShimsAsync } from "./helpers";

let root: string;
let shims: ReturnType<typeof installShims>;
const bundleId = "com.example.seed";
const act = (action: string, params: Record<string, unknown> = {}) =>
  runHostActionAsync({ action, params: { udid: UDID, bundleId, ...params } }, "serve-sim");

beforeAll(() => {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  root = mkdtempSync(join(UPLOAD_DIR, "app-files-"));
  mkdirSync(join(root, "Documents"));
  shims = installShims({ xcrun: `#!/bin/sh\nprintf '%s\\n' '${root}'\n` });
});
afterAll(() => {
  shims.restore();
  rmSync(root, { recursive: true, force: true });
});

describe("app data files", () => {
  it("reads and lists app files, then removes only the selected regular file", async () => {
    writeFileSync(join(root, "Documents/session.json"), '{"user":"test"}');
    const read = await act("app.file.read", { relativePath: "Documents/session.json" });
    expect(read.exitCode).toBe(0);
    expect(Buffer.from(read.stdout, "base64").toString()).toBe('{"user":"test"}');
    const listing = await act("app.file.list", { relativePath: "Documents" });
    expect(JSON.parse(listing.stdout)).toContainEqual({ name: "session.json", type: "file" });
    expect((await act("app.file.remove", { relativePath: "Documents/session.json" })).exitCode).toBe(0);
    expect((await act("app.file.remove", { relativePath: "Documents" })).exitCode).toBe(1);
  });

  it("refuses traversal, absolute paths, and device aliases before spawning", async () => {
    for (const relativePath of ["../escape", "/tmp/escape", "Documents/../../escape", "Documents\\escape", "Documents/a\nb", ".", ""]) {
      await expect(act("app.file.remove", { relativePath })).rejects.toThrow();
    }
    await expect(act("app.file.list", { udid: "booted" })).rejects.toThrow();
  });

  it("accepts names with joined emoji", async () => {
    const name = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}.json";
    writeFileSync(join(root, "Documents", name), "family");
    const read = await act("app.file.read", { relativePath: `Documents/${name}` });
    expect(Buffer.from(read.stdout, "base64").toString()).toBe("family");
    expect((await act("app.file.remove", { relativePath: `Documents/${name}` })).exitCode).toBe(0);
  });

  it("refuses symlinks even to another allowed container", async () => {
    symlinkSync(UPLOAD_DIR, join(root, "Documents/link"));
    for (const action of ["app.file.read", "app.file.remove", "app.file.list"]) {
      expect((await act(action, { relativePath: "Documents/link/outside" })).exitCode).toBe(1);
    }
  });

  it("refuses a container root or ancestor redirected to another allowed directory", async () => {
    const outside = mkdtempSync(join(UPLOAD_DIR, "other-app-"));
    const linked = join(root, "linked-container");
    mkdirSync(join(outside, "container"));
    writeFileSync(join(outside, "secret"), "other app");
    writeFileSync(join(outside, "container/secret"), "other app");
    symlinkSync(outside, linked);
    try {
      for (const container of [linked, join(linked, "container")]) {
        await withShimsAsync({ xcrun: `#!/bin/sh\nprintf '%s\\n' '${container}'\n` }, async () => {
          for (const action of ["app.file.read", "app.file.remove", "app.file.list"]) {
            expect((await act(action, action === "app.file.list" ? {} : { relativePath: "secret" })).exitCode).toBe(1);
          }
        });
      }
      expect(existsSync(join(outside, "secret"))).toBe(true);
      expect(existsSync(join(outside, "container/secret"))).toBe(true);
    } finally {
      rmSync(linked);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("lets another device list files while the first device waits for its launch lock", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = withLaunchStateLock(UDID, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    const blocked = act("app.file.list");
    const independent = act("app.file.list", { udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" });
    try {
      const result = await Promise.race([
        independent,
        new Promise<undefined>((resolve) => setTimeout(resolve, 1000)),
      ]);
      expect(result?.exitCode).toBe(0);
    } finally {
      release();
      await Promise.all([held, blocked, independent]);
    }
  });

  it("bounds reads and refuses special files without blocking", async () => {
    const path = join(root, "Documents/large");
    writeFileSync(path, "");
    truncateSync(path, 8 * 1024 * 1024 + 1);
    expect((await act("app.file.read", { relativePath: "Documents/large" })).exitCode).toBe(1);
    expect((await act("app.file.read", { relativePath: "Documents" })).exitCode).toBe(1);
    execFileSync("mkfifo", [join(root, "Documents/pipe")]);
    expect((await act("app.file.read", { relativePath: "Documents/pipe" })).exitCode).toBe(1);
  });

  it("bounds directory listings and releases the queue after failure", async () => {
    mkdirSync(join(root, "many"));
    for (let i=0; i<1000; i++) writeFileSync(join(root, "many", String(i)), "");
    expect(JSON.parse((await act("app.file.list", { relativePath: "many" })).stdout)).toHaveLength(1000);
    writeFileSync(join(root, "many", "extra"), "");
    expect((await act("app.file.list", { relativePath: "many" })).exitCode).toBe(1);
    expect((await act("app.file.list")).exitCode).toBe(0);
  });
  it("reports lock acquisition failures as redacted action errors", async () => {
    const original = process.env.SERVE_SIM_STATE_DIR;
    const invalid = join(root,"Documents/state-file");
    writeFileSync(invalid, "fixture");
    process.env.SERVE_SIM_STATE_DIR = invalid;
    try {
      const result = await act("app.file.list");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain(root);
    } finally {
      if (original === undefined) delete process.env.SERVE_SIM_STATE_DIR;
      else process.env.SERVE_SIM_STATE_DIR = original;
    }
  });

});
