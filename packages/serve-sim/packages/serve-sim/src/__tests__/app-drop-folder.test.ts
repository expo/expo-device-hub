import { beforeEach, expect, mock, test } from "bun:test";
import { untar, TarTypeFlag } from "multitars";
import { packAppFolder, type AppFolderEntry } from "../client/utils/app-drop-folder";

const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
let failure: string | undefined;
beforeEach(() => {
  calls.length = 0;
  failure = undefined;
});
void mock.module("../socket/client-control", () => ({
  runHostAction: async (action: string, params: Record<string, unknown>) => {
    calls.push({ action, params });
    return action === failure
      ? { exitCode: 1, stderr: "host refused", stdout: "" }
      : { exitCode: 0, stderr: "", stdout: "/staged" };
  },
}));
import { uploadDroppedAppFolder, DROP_CHUNK_BYTES } from "../client/utils/drop";

const droppedFile = (name: string, body: BlobPart[] = ["contents"]): AppFolderEntry => ({
  name,
  isFile: true,
  isDirectory: false,
  file(ok) {
    ok(new File(body, name));
  },
});
const droppedFolder = (name: string, batches: AppFolderEntry[][]): AppFolderEntry => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader() {
    let index = 0;
    return {
      readEntries(ok) {
        ok(batches[index++] ?? []);
      },
    };
  },
});

test("packs every directory-reader batch and infers private executable modes", async () => {
  const entry = droppedFolder("App.app", [
    [droppedFile("Info.plist")],
    [
      droppedFolder("nested", [
        [
          droppedFile("binary", [new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 42])]),
          droppedFile("script", ["#!/bin/sh\nexit 0"]),
        ],
      ]),
    ],
  ]);
  const progress: number[] = [];
  const stream = await packAppFolder(entry, (p) => progress.push(p));
  const files: Array<{ name: string; mode: number; type: TarTypeFlag; body: string }> = [];
  for await (const file of untar(stream.pipeThrough(new DecompressionStream("gzip"))))
    files.push({ name: file.name, mode: file.mode, type: file.typeflag, body: await file.text() });
  expect(files.map((f) => f.name).sort()).toEqual([
    "App.app/",
    "App.app/Info.plist",
    "App.app/nested/",
    "App.app/nested/binary",
    "App.app/nested/script",
  ]);
  expect(files.find((f) => f.name.endsWith("Info.plist"))?.mode).toBe(0o600);
  expect(files.find((f) => f.name.endsWith("binary"))?.mode).toBe(0o700);
  expect(files.find((f) => f.name.endsWith("script"))?.mode).toBe(0o700);
  expect(files.filter((f) => f.type === TarTypeFlag.DIRECTORY).every((f) => f.mode === 0o700)).toBe(
    true,
  );
  expect(progress.at(-1)).toBe(1);
});

test.each(["..", ".", "escape/file", "escape\\file", "nul\0file"])(
  "refuses unsafe component %j",
  async (name) => {
    await expect(
      packAppFolder(droppedFolder("App.app", [[droppedFile(name)]]), () => {}),
    ).rejects.toThrow("unsafe path");
  },
);

test("normalizes the bundle suffix and refuses paths beyond the host limit", async () => {
  const stream = await packAppFolder(
    droppedFolder("Build.APP", [[droppedFile("Info.plist")]]),
    () => {},
  );
  const paths: string[] = [];
  for await (const file of untar(stream.pipeThrough(new DecompressionStream("gzip")))) {
    paths.push(file.name);
    await file.text();
  }
  expect(paths).toEqual(["Build.app/", "Build.app/Info.plist"]);
  await expect(
    packAppFolder(droppedFolder("App.app", [[droppedFile("x".repeat(4096))]]), () => {}),
  ).rejects.toThrow("invalid or duplicate path");
});

test("refuses duplicates, oversized trees and unreadable entries before uploading", async () => {
  await expect(
    packAppFolder(droppedFolder("App.app", [[droppedFile("same"), droppedFile("same")]]), () => {}),
  ).rejects.toThrow("duplicate");
  await expect(
    packAppFolder(droppedFolder("App.app", [[droppedFile("data")]]), () => {}, {
      entries: 1,
      bytes: 100,
    }),
  ).rejects.toThrow("too many entries");
  await expect(
    packAppFolder(droppedFolder("App.app", [[droppedFile("data")]]), () => {}, {
      entries: 2,
      bytes: 1,
    }),
  ).rejects.toThrow("too large");
  await expect(
    uploadDroppedAppFolder(
      droppedFolder("App.app", [
        [
          {
            name: "denied",
            isDirectory: false,
            isFile: true,
            file(_, fail) {
              fail(new DOMException("denied"));
            },
          },
        ],
      ]),
      "UDID",
      () => {},
    ),
  ).rejects.toThrow("denied");
  expect(calls.map((c) => c.action)).toEqual(["upload.remove"]);
});

test("streams bounded upload chunks, installs only after packing, and removes the source", async () => {
  const body = new Uint8Array(DROP_CHUNK_BYTES * 3);
  for (let offset = 0; offset < body.length; offset += 65536)
    crypto.getRandomValues(body.subarray(offset, offset + 65536));
  await uploadDroppedAppFolder(
    droppedFolder("App.app", [[droppedFile("data", [body])]]),
    "UDID",
    () => {},
  );
  const chunks = calls.filter((c) => c.action === "upload.append");
  expect(chunks.length).toBeGreaterThan(3);
  expect(chunks.map((c) => c.params.first)).toEqual(chunks.map((_, index) => index === 0));
  expect(
    chunks.every((c) => Buffer.from(String(c.params.data), "base64").length <= DROP_CHUNK_BYTES),
  ).toBe(true);
  expect(calls.slice(-2).map((c) => c.action)).toEqual(["app.install", "upload.remove"]);
});

test.each(["upload.append", "app.install"])(
  "failed %s does not leave an upload or report success",
  async (action) => {
    failure = action;
    await expect(
      uploadDroppedAppFolder(droppedFolder("App.app", [[droppedFile("data")]]), "UDID", () => {}),
    ).rejects.toThrow("host refused");
    expect(calls.at(-1)?.action).toBe("upload.remove");
    if (action === "upload.append")
      expect(calls.some((c) => c.action === "app.install")).toBe(false);
  },
);

test("a failed upload cancels the file stream while packing is still in progress", async () => {
  failure = "upload.append";
  const chunk = crypto.getRandomValues(new Uint8Array(65536));
  let cancelled = false,
    produced = 0;
  const file = new File([new Uint8Array(2 * 1024 ** 2)], "large");
  Object.defineProperty(file, "stream", {
    value: () => {
      let remaining = file.size;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          if (!remaining) {
            controller.close();
            return;
          }
          remaining -= chunk.length;
          produced += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
    },
  });
  const entry = droppedFolder("App.app", [
    [
      {
        name: "large",
        isDirectory: false,
        isFile: true,
        file(ok) {
          ok(file);
        },
      },
    ],
  ]);
  // Keep the source unfinished with a pass-through compressor. This isolates
  // cancellation from a runtime compressor buffering the whole fixture.
  const original = globalThis.CompressionStream;
  try {
    Object.assign(globalThis, {
      CompressionStream: class extends TransformStream {
        constructor() {
          super();
        }
      },
    });
    await expect(uploadDroppedAppFolder(entry, "UDID", () => {})).rejects.toThrow("host refused");
    for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(file.size);
  } finally {
    Object.assign(globalThis, { CompressionStream: original });
  }
});
