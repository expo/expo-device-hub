import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../scripts/summarize.mjs";

const header = "frame,elapsed_ms,capture_ms,copy_ms,native_texture";
const csv = [header, ...Array.from({ length: 14 }, (_, i) =>
  `${i},${i * 10},${i < 10 ? 1000 : i - 9},${i < 10 ? 1000 : (i - 9) / 2},42`)].join("\n");

test("summary preserves warmup exclusion and Python percentile/median conventions", () => {
  const result = summarize(csv, "capture.csv");
  assert.equal(result.captured_frames, 14);
  assert.equal(result.warmup_excluded, 10);
  assert.equal(result.measured_fps, 100);
  assert.deepEqual(result.capture_ms, { mean: 2.5, p50: 2.5, p95: 3, p99: 3, max: 4 });
  assert.deepEqual(result.copy_ms, { mean: 1.25, p50: 1.25, p95: 1.5, p99: 1.5, max: 2 });
  assert.deepEqual(summarize(csv.replaceAll("\n", "\r\n") + "\r\n", "capture.csv"), result);
});

test("summary rejects incomplete or invalid capture metrics", () => {
  assert.throws(() => summarize(header), /at least 12/);
  assert.throws(() => summarize("bad,data"), /must contain/);
  assert.throws(() => summarize(csv.replace("130,4,", "130,bad,")), /Invalid capture_ms/);
  assert.throws(() => summarize(csv.replace("130,4,", "130,,")), /Invalid capture_ms/);
  assert.throws(() => summarize(csv.replace("130,4,", "100,4,")), /must advance/);
});
