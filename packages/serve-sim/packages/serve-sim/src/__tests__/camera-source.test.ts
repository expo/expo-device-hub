import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { detectMediaKind, resolveSourceArg } from "../capabilities/camera";

const directory = mkdtempSync(join(tmpdir(), "camera-source-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("keeps recognized extensions ahead of file contents, ignoring case", () => {
  const file = join(directory, "conflicting.MOV");
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  expect(detectMediaKind(file)).toBe("video");
  expect(detectMediaKind(join(directory, "missing.HEIC"))).toBe("image");
});

test("detects extensionless image/video uploads and resolves relative file paths", () => {
  const image = join(directory, "uploaded-image");
  const video = join(directory, "uploaded-video");
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(video, Buffer.from("0000ftypisom"));
  expect(resolveSourceArg({ file: relative(process.cwd(), image) })).toEqual({
    kind: "image",
    arg: image,
  });
  expect(resolveSourceArg({ file: video })).toEqual({ kind: "video", arg: video });
});

test("returns null for unknown/unreadable input and retains the absolute-path error", () => {
  const file = join(directory, "unknown");
  writeFileSync(file, "not media");
  expect(detectMediaKind(file)).toBeNull();
  expect(detectMediaKind(join(directory, "missing"))).toBeNull();
  const relativePath = relative(process.cwd(), file);
  expect(() => resolveSourceArg({ file: relativePath })).toThrow(
    `Could not detect image/video type for: ${resolve(relativePath)}`,
  );
});

test("retains default, webcam and file-before-webcam source choices", () => {
  expect(resolveSourceArg({})).toEqual({ kind: "placeholder" });
  expect(resolveSourceArg({ webcam: true })).toEqual({ kind: "webcam", arg: undefined });
  expect(resolveSourceArg({ webcam: "Named camera" })).toEqual({
    kind: "webcam",
    arg: "Named camera",
  });
  const file = join(directory, "selected.png");
  expect(resolveSourceArg({ file, webcam: true })).toEqual({ kind: "image", arg: file });
});
