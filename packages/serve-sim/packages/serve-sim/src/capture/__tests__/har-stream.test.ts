import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "capture-stream-test-"));
const modulePath = join(dir, "har-stream.mjs");

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../har-stream.ts")],
    target: "node",
    outdir: dir,
    naming: "har-stream.mjs",
  });
  expect(result.success).toBe(true);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("HAR stream failures under Node", () => {
  for (const mode of ["large-write", "compaction", "missing-input"]) {
    test(`${mode} rejects without an unhandled rejection or leftover files`, () => {
      const code = `
        import assert from "node:assert/strict";
        import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        import { streamHarFromNdjsonFile, compactNdjsonAndStreamHar }
          from ${JSON.stringify(pathToFileURL(modulePath).href)};
        const dir = mkdtempSync(join(tmpdir(), "capture-stream-failure-"));
        try {
          const entries = join(dir, "entries.ndjson");
          const entry = { payload: "x".repeat(1024 * 1024) };
          writeFileSync(entries, (JSON.stringify(entry) + "\\n").repeat(2));
          const output = join(dir, "missing", "capture.har");
          const mode = ${JSON.stringify(mode)};
          const operation = mode === "large-write"
            ? streamHarFromNdjsonFile(entries, output, "test")
            : mode === "compaction"
              ? compactNdjsonAndStreamHar(entries, output, "test", 1)
              : streamHarFromNdjsonFile(join(dir, "missing.ndjson"), join(dir, "capture.har"), "test");
          await assert.rejects(operation, { code: "ENOENT" });
          assert.deepEqual(readdirSync(dir), ["entries.ndjson"]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      `;
      const result = spawnSync("node", ["--unhandled-rejections=strict", "--input-type=module", "-e", code], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
    });
  }
});
