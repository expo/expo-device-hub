import { describe, expect, it } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendFileNoFollow, appendFileNoFollowSync, replaceFilesNoFollow, writeAllAsync, writeAllSync, writeFileNoFollow } from "../no-follow";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("capture file writes", () => {
  it("cuts a failed append back to the previous length, so a retry does not split or duplicate a line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-append-rollback-"));
    try {
      const sync = join(dir, "events.ndjson");
      writeFileSync(sync, "first\n");
      expect(() =>
        appendFileNoFollowSync(sync, "second\nthird\n", (fd, data) => {
          // Half of the batch reaches the file before the write fails, as a full disk would do.
          writeSync(fd, data.slice(0, 4));
          throw new Error("ENOSPC");
        }),
      ).toThrow("ENOSPC");
      expect(readFileSync(sync, "utf8")).toBe("first\n");
      appendFileNoFollowSync(sync, "second\nthird\n");
      expect(readFileSync(sync, "utf8")).toBe("first\nsecond\nthird\n");

      const async = join(dir, "entries.ndjson");
      writeFileSync(async, "first\n");
      await expect(
        appendFileNoFollow(async, "second\nthird\n", async (handle, data) => {
          await handle.write(data.slice(0, 4));
          throw new Error("ENOSPC");
        }),
      ).rejects.toThrow("ENOSPC");
      expect(readFileSync(async, "utf8")).toBe("first\n");
      await appendFileNoFollow(async, "second\nthird\n");
      expect(readFileSync(async, "utf8")).toBe("first\nsecond\nthird\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps writing when the file accepts only part of a line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-short-write-"));
    // Multibyte text, so a 3-byte chunk lands inside a character.
    const line = `{"url":"https://example.com/é/日本"}\n`.repeat(20);
    try {
      const sync = join(dir, "sync.ndjson");
      const fd = openSync(sync, "w");
      try {
        writeAllSync(fd, line, (f, buffer, offset, length) => writeSync(f, buffer, offset, Math.min(3, length)));
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(sync, "utf8")).toBe(line);

      const async = join(dir, "async.ndjson");
      const handle = await open(async, "w");
      try {
        await writeAllAsync(handle, line, async (h, buffer, offset, length) =>
          (await h.write(buffer, offset, Math.min(3, length))).bytesWritten);
      } finally {
        await handle.close();
      }
      expect(readFileSync(async, "utf8")).toBe(line);

      const stuck = join(dir, "stuck.ndjson");
      const stuckFd = openSync(stuck, "w");
      try {
        expect(() => writeAllSync(stuckFd, line, () => 0)).toThrow("made no progress");
      } finally {
        closeSync(stuckFd);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves every file as it was when writing one of their replacements fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-replace-"));
    const files = ["a.har", "a.entries.ndjson", "a.network-capture.json"].map((name) => join(dir, name));
    try {
      for (const path of files) writeFileSync(path, `kept ${path}\n`);
      let writes = 0;
      expect(() => replaceFilesNoFollow(files.map((path) => ({ path, data: "new\n" })), (fd, data) => {
        // The second file hits a full disk.
        if (++writes === 2) throw new Error("ENOSPC");
        writeSync(fd, data);
      })).toThrow("ENOSPC");
      for (const path of files) expect(readFileSync(path, "utf8")).toBe(`kept ${path}\n`);
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

      replaceFilesNoFollow(files.map((path) => ({ path, data: "new\n" })));
      for (const path of files) {
        expect(readFileSync(path, "utf8")).toBe("new\n");
        expect(mode(path)).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes an existing world-readable file owner-only before writing decrypted traffic into it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-existing-mode-"));
    const previousUmask = process.umask(0o000);
    try {
      const har = join(dir, "morning.har");
      writeFileSync(har, "old", { mode: 0o644 });
      chmodSync(har, 0o644);
      expect(mode(har)).toBe(0o644);
      writeFileNoFollow(har, "{}\n");
      expect(mode(har)).toBe(0o600);

      const log = join(dir, "morning.network-capture.json");
      writeFileSync(log, "", { mode: 0o644 });
      chmodSync(log, 0o644);
      appendFileNoFollowSync(log, "one\n");
      expect(mode(log)).toBe(0o600);

      const entries = join(dir, "morning.entries.ndjson");
      writeFileSync(entries, "", { mode: 0o644 });
      chmodSync(entries, 0o644);
      await appendFileNoFollow(entries, "one\n");
      expect(mode(entries)).toBe(0o600);
    } finally {
      process.umask(previousUmask);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
