import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readPermissionDatabase } from "../permissions";

const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;

describe.skipIf(!hasSqlite)("permission database reads (real SQLite)", () => {
  async function lockedDatabase(seconds: number, run: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "permissions-sqlite-"));
    const path = join(dir, "TCC.db");
    const db = new Database(path);
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE access(auth_value INTEGER); INSERT INTO access VALUES(2)",
    );
    db.close();
    // A separate process can release its lock while the production read blocks.
    const child = Bun.spawn(
      [
        "python3",
        "-u",
        "-c",
        "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN EXCLUSIVE'); print('locked',flush=True); time.sleep(float(sys.argv[2])); c.rollback()",
        path,
        String(seconds),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(value)).toContain("locked");
      if (seconds === 0) await child.exited;
      run(path);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("waits for a transient exclusive lock instead of failing the permission list", async () => {
    await lockedDatabase(0.35, (path) => {
      expect(readPermissionDatabase(path, "SELECT auth_value FROM access").trim()).toBe("2");
    });
  });

  test("keeps a persistent lock bounded by the subprocess deadline", async () => {
    await lockedDatabase(10, (path) => {
      const start = Date.now();
      expect(() => readPermissionDatabase(path, "SELECT auth_value FROM access")).toThrow();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThan(4000);
      expect(elapsed).toBeLessThan(6000);
    });
  }, 10_000);

  test("preserves non-busy errors without waiting for the busy deadline", async () => {
    await lockedDatabase(0, (path) => {
      const start = Date.now();
      expect(() => readPermissionDatabase(path, "SELECT missing FROM absent")).toThrow(
        "no such table",
      );
      expect(Date.now() - start).toBeLessThan(1500);
    });
  });
});
