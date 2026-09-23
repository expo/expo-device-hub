import { describe, expect, it } from "bun:test";

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { open } from "fs/promises";
import { homedir, tmpdir } from "os";
import { basename, join, resolve, sep } from "path";

import { InvalidHostActionError, runHostActionAsync } from "../host-actions";
import { EXIT_0_SHIM, UDID, withActionTimeoutAsync, withShimsAsync } from "./helpers";

const BIN = "true";
const PROTECTED = /is inside a location this host protects/;

/** Both checks: exec-ws forwards the message only for this class, and the message names the guard. */
async function expectProtectedAsync(path: string): Promise<void> {
  const attempt = runHostActionAsync({ action: "file.readBase64", params: { path } }, BIN);
  await expect(attempt).rejects.toBeInstanceOf(InvalidHostActionError);
  await expect(attempt).rejects.toThrow(PROTECTED);
}

describe("what a preview link may spend on the host", () => {
  it("refuses an upload chunk larger than the cap", async () => {
    const oversized = "A".repeat(5 * 1024 * 1024);
    await expect(
      runHostActionAsync(
        { action: "upload.append", params: { uploadId: "big.ipa", data: oversized } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("accepts a chunk inside the cap", async () => {
    const result = await runHostActionAsync(
      {
        action: "upload.append",
        params: { uploadId: "small.bin", data: btoa("hello"), first: true },
      },
      BIN,
    );
    try {
      expect(result.exitCode).toBe(0);
      expect(readFileSync(result.stdout.trim(), "utf8")).toBe("hello");
    } finally {
      await runHostActionAsync({ action: "upload.remove", params: { uploadId: "small.bin" } }, BIN);
    }
  });

  // argv is not line-delimited, so a newline cannot split an argument, but a NUL makes execFile
  // throw a TypeError rather than a validation error, and the caller gets an opaque "action failed".
  it.each([
    ["a newline", "cam\nera"],
    ["a NUL byte", "cam\u0000era"],
    ["a carriage return", "cam\rera"],
  ])("refuses an argument carrying %s", async (_label, target) => {
    await expect(
      runHostActionAsync(
        { action: "camera.switch", params: { udid: UDID, source: "webcam", target } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });
  it.each(["Thesis.docx", "notes.txt", "shot.png", "serve-sim-screenshot-x.jpg"])(
    "refuses to write a screenshot named %s",
    async (fileName) => {
      await expect(
        runHostActionAsync({ action: "screenshot.capture", params: { udid: UDID, fileName } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    },
  );
  // Device-typed fields are covered elsewhere; this is the Argument guard.
  it("refuses a webcam name that would be read as a flag", async () => {
    await expect(
      runHostActionAsync(
        { action: "camera.switch", params: { udid: UDID, source: "webcam", target: "--help" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });
  // The ceiling is a read-then-write. Unserialized, every concurrent chunk reads the same pre-write
  // total, all pass, and the staging area sails past 2GB. A sparse filler puts the directory one
  // chunk under the limit without consuming disk, so the overshoot is visible in the accept count.
  it("does not let parallel chunks overshoot the staging ceiling", async () => {
    const MAX_UPLOAD_DIR_BYTES = 2 * 1024 * 1024 * 1024;
    const chunk = 1024;
    const dir = join(tmpdir(), "serve-sim-uploads");
    const filler = join(dir, "zz-toctou-filler.bin");
    const ids = Array.from({ length: 8 }, (_unused, i) => `zz-toctou-${i}.bin`);

    mkdirSync(dir, { recursive: true });
    let existing = 0;
    for (const entry of readdirSync(dir)) {
      try {
        existing += statSync(join(dir, entry)).size;
      } catch {}
    }

    const handle = await open(filler, "w");
    await handle.truncate(MAX_UPLOAD_DIR_BYTES - existing - 2 * chunk);
    await handle.close();

    try {
      const data = btoa("C".repeat(chunk));
      const results = await Promise.all(
        ids.map((uploadId) =>
          runHostActionAsync(
            { action: "upload.append", params: { uploadId, data, first: true } },
            BIN,
          ),
        ),
      );

      expect(results.filter((r) => r.exitCode === 0).length).toBeLessThanOrEqual(2);
      expect(results.some((r) => r.stderr.includes("staging area is full"))).toBe(true);
    } finally {
      rmSync(filler, { force: true });
      for (const uploadId of ids) rmSync(join(dir, uploadId), { force: true });
    }
  });
  // These are TCC_PROTECTED_DIRS in host-paths.ts, refused before the filesystem is touched.
  //
  // The guard has its own message, and these pin the refusal to it: without the guard the same
  // paths are still refused, by the allowlist, with the same error class. What a local run cannot
  // prove is that the refusal happens without the syscall: on a machine whose consent is already
  // granted the open returns either way. Only a headless host separates the two, so CI is what
  // guards the ordering — before this, that ordering was wrong and CI hung here for two hours.
  //
  // The screenshot name matters most: it is the one shape this server writes there, so it is the
  // one that would tempt someone to allow the directory back in.
  it.each([
    ["Desktop", "Thesis.docx"],
    ["Desktop", "id_rsa"],
    ["Desktop", "serve-sim-screenshot-x.png"],
    ["Documents", "notes.txt"],
    ["Downloads", "installer.dmg"],
  ])("refuses to read ~/%s/%s", async (dir, name) => {
    await expectProtectedAsync(join(homedir(), dir, name));
  });

  it.each(["Desktop", "Documents", "Downloads"])("refuses ~/%s itself", async (dir) => {
    await expectProtectedAsync(join(homedir(), dir));
  });

  it("refuses a lowercase spelling of ~/Desktop", async () => {
    await expectProtectedAsync(join(homedir().toLowerCase(), "desktop", "x.png"));
  });

  // The check runs on the resolved path, so a traversal that lands in a protected directory is
  // caught even though the string it arrived as started under an allowed root. Built by hand: join
  // would collapse the dots and read the home path as a relative segment, leaving a path that is
  // refused for being outside every root rather than by this guard.
  it("refuses a traversal that resolves into a protected directory", async () => {
    const start = join(tmpdir(), "serve-sim-uploads");
    const climb = "../".repeat(start.split(sep).filter(Boolean).length);
    const traversal = `${start}/${climb}${homedir().slice(1)}/Desktop/serve-sim-screenshot-x.png`;
    expect(resolve(traversal)).toBe(join(homedir(), "Desktop", "serve-sim-screenshot-x.png"));
    await expectProtectedAsync(traversal);
  });
  // Staged copies are a cache and this prune is the only thing that empties it, so a prune that
  // stopped firing would surface as a full disk rather than a failing action. The fresh file sits
  // just inside the cutoff so an off-by-one on the comparison shows.
  it("removes staged screenshots older than six hours and keeps a fresh one", async () => {
    const staging = join(realpathSync(tmpdir()), "serve-sim-screenshots");
    mkdirSync(staging, { recursive: true });
    const stale = [0, 1].map((i) => join(staging, `serve-sim-screenshot-zz-prune-stale-${i}.png`));
    const fresh = join(staging, "serve-sim-screenshot-zz-prune-fresh.png");
    const captured = join(staging, "serve-sim-screenshot-zz-prune-next.png");
    const cutoffSeconds = (Date.now() - 6 * 60 * 60 * 1000) / 1000;
    try {
      for (const file of stale) {
        writeFileSync(file, "");
        utimesSync(file, cutoffSeconds - 60, cutoffSeconds - 60);
      }
      writeFileSync(fresh, "");
      utimesSync(fresh, cutoffSeconds + 60, cutoffSeconds + 60);

      await withShimsAsync({ xcrun: EXIT_0_SHIM, cp: EXIT_0_SHIM }, async () => {
        const result = await runHostActionAsync(
          { action: "screenshot.capture", params: { udid: UDID, fileName: basename(captured) } },
          BIN,
        );
        expect(result.exitCode).toBe(0);
      });

      for (const file of stale) expect(existsSync(file)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      for (const file of [...stale, fresh, captured]) rmSync(file, { force: true });
    }
  });
  // exec, so the deadline's SIGKILL reaps the sleep itself; a plain `sleep` would leave it running
  // under init after its shell died.
  it("gives up on a child that never exits", async () => {
    await withActionTimeoutAsync(3000, async () => {
      await withShimsAsync({ xcrun: "#!/bin/sh\nexec sleep 600\n" }, async () => {
        const started = Date.now();
        const result = await runHostActionAsync(
          { action: "appearance.get", params: { udid: UDID } },
          BIN,
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("did not finish within");
        expect(Date.now() - started).toBeLessThan(15_000);
      });
    });
  }, 40_000);
});