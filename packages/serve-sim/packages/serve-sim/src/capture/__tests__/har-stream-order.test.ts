import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compactNdjsonAndStreamHar, streamHarFromNdjsonFile } from "../har-stream";

// The entry log holds entries by completion time; B finished first although A started first.
const entry = (id: string, startedDateTime: string) => JSON.stringify({ _captureId: id, startedDateTime, request: { url: `https://a.test/${id}` } });

function withLog(lines: string[], run: (paths: { entries: string; har: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "serve-sim-har-order-"));
  const entries = join(dir, "capture.entries.ndjson");
  writeFileSync(entries, `${lines.join("\n")}\n`);
  return run({ entries, har: join(dir, "capture.har") }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const ids = (harPath: string) =>
  (JSON.parse(readFileSync(harPath, "utf8")) as { log: { entries: { _captureId?: string }[] } }).log.entries.map((e) => e._captureId ?? "?");

test("rebuilds the HAR in start order, not completion order", () =>
  withLog([entry("b", "2026-01-01T10:00:01.000Z"), entry("c", "2026-01-01T10:00:02.000Z"), entry("a", "2026-01-01T10:00:00.000Z")], async ({ entries, har }) => {
    await streamHarFromNdjsonFile(entries, har, "test");
    expect(ids(har)).toEqual(["a", "b", "c"]);
  }));

test("keeps start order when compaction drops the oldest completions", () =>
  withLog([entry("x", "2026-01-01T09:00:00.000Z"), entry("b", "2026-01-01T10:00:01.000Z"), entry("a", "2026-01-01T10:00:00.000Z")], async ({ entries, har }) => {
    expect(await compactNdjsonAndStreamHar(entries, har, "test", 2)).toBe(2);
    expect(ids(har)).toEqual(["a", "b"]);
    // The log itself keeps completion order.
    expect(readFileSync(entries, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { _captureId: string })._captureId)).toEqual(["b", "a"]);
  }));

test("puts an entry without a readable start time after the dated ones", () =>
  withLog([entry("undated", "not a date"), entry("a", "2026-01-01T10:00:00.000Z")], async ({ entries, har }) => {
    await streamHarFromNdjsonFile(entries, har, "test");
    expect(ids(har)).toEqual(["a", "undated"]);
  }));
