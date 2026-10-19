import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GuestProfileCapture, guestProfileCapture } from "../guest-profile-capture";
import { InvalidHostActionError, runHostActionAsync } from "../host-actions";

test("remote profiling rejects paths, commands and unbounded durations before collecting", async () => {
  for (const params of [{ seconds: 0 }, { seconds: 31 }, { seconds: 1.5 }, { path: "/tmp/owned" }, { command: "id" }]) {
    await expect(runHostActionAsync({ action: "profile.capture", params }, "true")).rejects.toBeInstanceOf(InvalidHostActionError);
  }
});

test("remote profiling refuses physical machines without starting a collector", async () => {
  let started = false;
  const capture = new GuestProfileCapture({
    isVm: async () => false,
    start: async () => { started = true; throw new Error("unexpected collector"); },
    wait: async () => {},
  });
  await expect(capture.capture(1)).rejects.toThrow("requires a VM");
  expect(started).toBe(false);
});

test("one capture owns the slot until finalization, then returns NDJSON and removes its directory", async () => {
  let file = "", finished = false;
  let release!: () => void, ready!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const capture = new GuestProfileCapture({
    isVm: async () => true,
    start: async (path) => {
      file = path;
      await writeFile(path, '{"type":"meta"}\n', { mode: 0o600 });
      ready();
      return { finishAsync: async () => { finished = true; return path; } };
    },
    wait: () => waiting,
  });
  const first = capture.capture(1);
  await started;
  await expect(capture.capture(1)).rejects.toThrow("already running");
  release();
  expect(await first).toBe('{"type":"meta"}\n');
  expect(finished).toBe(true);
  expect(existsSync(dirname(file))).toBe(false);
  expect(await capture.capture(1)).toContain('"meta"');
});

test("an oversized response is not read or returned and releases the slot and directory", async () => {
  let file = "";
  const capture = new GuestProfileCapture({
    isVm: async () => true,
    start: async (path) => {
      file = path;
      await writeFile(path, "");
      await truncate(path, 16 * 1024 * 1024 + 1);
      return { finishAsync: async () => path };
    },
    wait: async () => {},
  });
  await expect(capture.capture(1)).rejects.toThrow("16 MiB response limit");
  expect(existsSync(dirname(file))).toBe(false);
  await expect(capture.capture(1)).rejects.toThrow("16 MiB response limit");
});

test("a failed wait still finalizes the collector and removes private output", async () => {
  let file = "", finalized = false;
  const capture = new GuestProfileCapture({
    isVm: async () => true,
    start: async (path) => {
      file = path;
      return { finishAsync: async () => { finalized = true; return path; } };
    },
    wait: async () => { throw new Error("interrupted"); },
  });
  await expect(capture.capture(1)).rejects.toThrow("interrupted");
  expect(finalized).toBe(true);
  expect(existsSync(dirname(file))).toBe(false);
});


test("the action channel preserves a safe operational profiling refusal", async () => {
  const physicalHost = new GuestProfileCapture({
    isVm: async () => false,
    start: async () => { throw new Error("collector must not start"); },
    wait: async () => {},
  });
  const capture = spyOn(guestProfileCapture, "capture").mockImplementation((seconds) => physicalHost.capture(seconds));
  try {
    await expect(runHostActionAsync({ action: "profile.capture", params: { seconds: 1 } }, "true"))
      .resolves.toEqual({ stdout: "", stderr: "Remote guest profiling requires a VM", exitCode: 1 });
  } finally { capture.mockRestore(); }
});


test("unexpected collector errors retain the action channel's private-error path", async () => {
  const failure = new Error("private collector failure");
  const capture = spyOn(guestProfileCapture, "capture").mockRejectedValue(failure);
  try {
    await expect(runHostActionAsync({ action: "profile.capture", params: { seconds: 1 } }, "true"))
      .rejects.toBe(failure);
  } finally { capture.mockRestore(); }
});
