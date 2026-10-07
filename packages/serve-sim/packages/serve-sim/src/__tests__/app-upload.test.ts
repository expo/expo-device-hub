import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync, linkSync, readdirSync } from "fs";
import { join } from "path";
import { open } from "fs/promises";
import { UPLOAD_DIR } from "../host-paths";
import { runHostActionAsync } from "../host-actions";
import { UDID, installShims } from "./helpers";

let root: string;
let shims: ReturnType<typeof installShims>;
const bundleId = "com.example.seed";
const act = (action: string, params: Record<string, unknown> = {}) =>
  runHostActionAsync({ action, params: { udid: UDID, bundleId, ...params } }, "serve-sim");

beforeAll(() => {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  root = mkdtempSync(join(UPLOAD_DIR, "app-upload-"));
  mkdirSync(join(root, "Documents"));
  shims = installShims({ xcrun: `#!/bin/sh\nprintf '%s\\n' '${root}'\n` });
});
afterAll(() => {
  shims.restore();
  rmSync(root, { recursive: true, force: true });
});

describe("app fixture uploads", () => {
  it("copies a staged upload, reads and lists it, then removes only that file", async () => {
    const uploadId = "app-files-session.json";
    writeFileSync(join(UPLOAD_DIR, uploadId), '{"user":"test"}');
    try {
      expect((await act("app.file.upload", { uploadId, relativePath: "Documents/session.json" })).exitCode).toBe(0);
      expect(readFileSync(join(root, "Documents/session.json"), "utf8")).toBe('{"user":"test"}');
      const read = await act("app.file.read", { relativePath: "Documents/session.json" });
      expect(Buffer.from(read.stdout, "base64").toString()).toBe('{"user":"test"}');
      const listing = await act("app.file.list", { relativePath: "Documents" });
      expect(JSON.parse(listing.stdout)).toContainEqual({ name: "session.json", type: "file" });
      expect((await act("app.file.remove", { relativePath: "Documents/session.json" })).exitCode).toBe(0);
      expect((await act("app.file.remove", { relativePath: "Documents" })).exitCode).toBe(1);
    } finally {
      rmSync(join(UPLOAD_DIR, uploadId), { force: true });
    }
  });

  it("does not overwrite an existing file by default", async () => {
    const uploadId = "app-files-overwrite.json";
    writeFileSync(join(UPLOAD_DIR, uploadId), "new");
    const outside = join(UPLOAD_DIR, "app-upload-hardlink-source");
    writeFileSync(outside, "old");
    linkSync(outside, join(root, "Documents/existing"));
    try {
      expect((await act("app.file.upload", { uploadId, relativePath: "Documents/existing" })).exitCode).toBe(1);
      expect(readFileSync(join(root, "Documents/existing"), "utf8")).toBe("old");
      expect((await act("app.file.upload", { uploadId, relativePath: "Documents/existing", overwrite: true })).exitCode).toBe(0);
      expect(readFileSync(join(root, "Documents/existing"), "utf8")).toBe("new");
      expect(readFileSync(outside, "utf8")).toBe("old");
      expect(readdirSync(join(root,"Documents")).some((name)=>name.startsWith(".serve-sim-"))).toBe(false);
    } finally {
      rmSync(join(UPLOAD_DIR, uploadId), { force: true });
      rmSync(outside, { force: true });
    }
  });

  it("refuses oversized staged files and a symlink destination without modifying the target", async () => {
    const uploadId = "app-files-limits.json";
    const source = join(UPLOAD_DIR, uploadId);
    writeFileSync(source, "original");
    symlinkSync(source, join(root, "Documents/linked-file"));
    try {
      expect((await act("app.file.upload", { uploadId, relativePath: "Documents/linked-file", overwrite: true })).exitCode).toBe(1);
      expect(readFileSync(source, "utf8")).toBe("original");
      truncateSync(source, 10 * 1024 * 1024);
      const atLimit = await act("app.file.upload", { uploadId, relativePath: "Documents/limit-file" });
      expect(JSON.parse(atLimit.stdout).bytes).toBe(10 * 1024 * 1024);
      truncateSync(source, 10 * 1024 * 1024 + 1);
      expect((await act("app.file.upload", { uploadId, relativePath: "Documents/large-file" })).exitCode).toBe(1);
    } finally {
      rmSync(source, { force: true });
    }
  });
  it("creates nested parents, preserves binary bytes and retains the staged source", async () => {
    const uploadId = "app-upload-binary.db";
    const source = join(UPLOAD_DIR, uploadId);
    const bytes = Buffer.from([0,255,1,128,0]);
    writeFileSync(source, bytes);
    try {
      const results = await Promise.all([1,2].map(()=>act("app.file.upload", { uploadId, relativePath:"Library/seed/state.db" })));
      expect(results.map((result)=>result.exitCode).sort()).toEqual([0,1]);
      expect(readFileSync(join(root,"Library/seed/state.db"))).toEqual(bytes);
      expect(readFileSync(source)).toEqual(bytes);
    } finally { rmSync(source,{force:true}); }
  });

  it("refuses linked staged sources and invalid paths", async () => {
    const uploadId = "app-upload-source-link.db";
    const source = join(UPLOAD_DIR,uploadId);
    symlinkSync(join(root,"Documents/existing"),source);
    try {
      expect((await act("app.file.upload",{uploadId,relativePath:"Documents/rejected"})).exitCode).toBe(1);
      for (const relativePath of ["../escape", "/tmp/escape", "Documents/../../escape", "Documents\\escape", ".", ""]) {
        await expect(act("app.file.upload", {uploadId,relativePath})).rejects.toThrow();
      }
    } finally { rmSync(source,{force:true}); }
  });

  it("refuses a linked parent with a valid staged source", async () => {
    const uploadId = "app-upload-parent.json";
    const source = join(UPLOAD_DIR, uploadId);
    writeFileSync(source, "fixture");
    symlinkSync(UPLOAD_DIR,join(root,"Documents/linked-parent"));
    try {
      expect((await act("app.file.upload",{uploadId,relativePath:"Documents/linked-parent/outside.json"})).exitCode).toBe(1);
      expect(readFileSync(source,"utf8")).toBe("fixture");
    } finally { rmSync(source,{force:true}); }
  });

  it("refuses source truncation during the read and preserves the destination", async () => {
    const uploadId = "app-upload-shrinking.db";
    const source = join(UPLOAD_DIR,uploadId);
    const destination = join(root,"Documents/shrinking.db");
    writeFileSync(source,"complete source");
    writeFileSync(destination,"old database");
    const probe = await open(source,"r");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalRead = prototype.read;
    let truncated = false;
    prototype.read = async function (...args: unknown[]) {
      if (!truncated) { truncateSync(source,0); truncated = true; }
      return originalRead.apply(this,args);
    };
    try {
      const result = await act("app.file.upload",{uploadId,relativePath:"Documents/shrinking.db",overwrite:true});
      expect(truncated).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(readFileSync(destination,"utf8")).toBe("old database");
    } finally { prototype.read = originalRead; rmSync(source,{force:true}); }
  });

  it("holds resets and removal behind the upload action’s source read", async () => {
    const uploadId = "app-upload-queued.db";
    const source = join(UPLOAD_DIR,uploadId);
    writeFileSync(source,"original");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve)=> { release = resolve; });
    const ready = new Promise<void>((resolve)=> { entered = resolve; });
    const destination = join(root,"Documents/queued.db");
    const probe = await open(source,"r");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalRead = prototype.read;
    let gated = false;
    prototype.read = async function (...args: unknown[]) {
      if (!gated) { gated = true; entered(); await gate; }
      return originalRead.apply(this,args);
    };
    const copy = act("app.file.upload",{uploadId,relativePath:"Documents/queued.db"});
    let resetDone = false;
    let removalDone = false;
    let reset: ReturnType<typeof act> | undefined;
    let removal: ReturnType<typeof act> | undefined;
    try {
      await Promise.race([ready, Bun.sleep(1000).then(() => { throw new Error("upload did not start its source read"); })]);
      reset = act("upload.append",{uploadId,data:Buffer.from("replacement").toString("base64"),first:true}).then((result)=> {resetDone = true;return result;});
      removal = act("upload.remove",{uploadId}).then((result)=> {removalDone = true;return result;});
      await new Promise((resolve)=>setTimeout(resolve,30));
      expect(resetDone).toBe(false);
      expect(removalDone).toBe(false);
      release();
      expect((await copy).exitCode).toBe(0);
      expect(readFileSync(destination,"utf8")).toBe("original");
      expect((await reset).exitCode).toBe(0);
      expect((await removal).exitCode).toBe(0);
    } finally {
      release();
      await Promise.allSettled([copy,reset,removal]);
      prototype.read = originalRead;
      rmSync(source,{force:true});
    }
  });

});
