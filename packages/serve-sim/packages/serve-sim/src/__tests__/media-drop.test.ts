import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createElement, type DragEvent } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { UNSUPPORTED_INSTALL_FORMAT } from "../app-install-format";

const actions: string[] = [];
let failure: string | undefined;
beforeEach(() => {
  actions.length = 0;
  failure = undefined;
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

void mock.module("../socket/client-control", () => ({
  runHostAction: async (action: string) => {
    actions.push(action);
    if (failure === "disconnect" && action === "upload.append")
      throw new Error("channel disconnected");
    return action === failure
      ? { stdout: "", stderr: "host operation failed", exitCode: 1 }
      : { stdout: "/tmp/staged-media", stderr: "", exitCode: 0 };
  },
}));

import { startHostPathDrop, useMediaDrop } from "../client/hooks/use-media-drop";

describe("startHostPathDrop", () => {
  test("dismisses the screenshot toast when a host screenshot path is dropped", async () => {
    const events: string[] = [];
    const done = startHostPathDrop({
      hostPath: "/Users/me/Desktop/serve-sim-screenshot.png",
      udid: "UDID",
      onUploadStart: (name, kind) => {
        events.push(`start:${name}:${kind}`);
        return "upload-1";
      },
      onUploadProgress: (id, progress) => {
        events.push(`progress:${id}:${String(progress)}`);
      },
      onUploadEnd: (id, ok) => {
        events.push(`end:${id}:${String(ok)}`);
      },
      onHostPathDrop: (path) => {
        events.push(`dismiss:${path}`);
      },
    });

    expect(events[0]).toBe("dismiss:/Users/me/Desktop/serve-sim-screenshot.png");
    expect(events[1]).toBe("start:serve-sim-screenshot.png:media");
    await done;
    expect(events).toContain("end:upload-1:true");
  });
});

type DropEvent = { type: string; name?: string; id?: string; ok?: boolean; message?: string };

// Mount the real hook and wait for each file's completion callback, not a timer.
async function dropFiles(
  files: File[],
  options: { enabled?: boolean; udid?: string | null; hostPath?: string } = {},
): Promise<DropEvent[]> {
  const events: DropEvent[] = [];
  const enabled = options.enabled ?? true;
  const udid = options.udid === null ? undefined : (options.udid ?? "UDID");
  const expected = enabled && udid ? (options.hostPath ? 1 : files.length) : 0;
  let finish!: () => void,
    completed = 0;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const complete = () => {
    if (++completed === expected) finish();
  };
  if (!expected) finish();
  let drop!: ReturnType<typeof useMediaDrop>;
  function Harness() {
    drop = useMediaDrop({
      enabled,
      udid,
      onUploadStart: (name) => {
        const id = String(events.length);
        events.push({ type: "start", name, id });
        return id;
      },
      onUploadProgress: (id) => {
        events.push({ type: "progress", id });
      },
      onUploadEnd: (id, ok, message) => {
        events.push({ type: "end", id, ok, message });
        complete();
      },
      onUnsupported: (file) => {
        events.push({ type: "unsupported", name: file.name });
        complete();
      },
      onHostPathDrop: (name) => {
        events.push({ type: "host", name });
      },
    });
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(createElement(Harness));
    });
    await act(async () => {
      await drop.dropZoneProps.onDrop({
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: { getData: () => options.hostPath ?? "", files },
      } as unknown as DragEvent);
      await done;
    });
    return events;
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
  }
}

const photo = (name = "photo.png") => new File(["image"], name, { type: "image/png" });

test.each([
  { name: "Build.zip", type: "application/zip" },
  { name: "BUILD.ZIP", type: "" },
  { name: "Device.ipa", type: "application/octet-stream" },
  { name: "Build.zip", type: "image/png" },
  { name: "BUILD.ZIP", type: "video/mp4" },
  { name: "Device.ipa", type: "image/jpeg" },
])(
  "archive drop reports Simulator-build guidance before classification: %j",
  async ({ name, type }) => {
    const events = await dropFiles([new File(["archive"], name, { type })]);
    expect(events.filter((e) => e.type === "end")).toEqual([
      { type: "end", id: "0", ok: false, message: UNSUPPORTED_INSTALL_FORMAT },
    ]);
    expect(events.some((e) => e.type === "unsupported" || e.type === "progress")).toBe(false);
    expect(actions).toEqual([]);
  },
);

test.each([{ enabled: false }, { udid: null }])(
  "disabled or missing-device drops do nothing: %j",
  async (options) => {
    expect(
      await dropFiles([photo(), photo("Build.zip")], { ...options, hostPath: "/host/image.png" }),
    ).toEqual([]);
    expect(actions).toEqual([]);
  },
);

test("a mixed drop reports rejected files while valid media completes and is cleaned up", async () => {
  const events = await dropFiles([
    new File(["archive"], "Build.zip", { type: "application/zip" }),
    new File(["text"], "notes.txt", { type: "text/plain" }),
    photo(),
  ]);
  expect(events.filter((e) => e.type === "unsupported")).toEqual([
    { type: "unsupported", name: "notes.txt" },
  ]);
  const ends = events.filter((e) => e.type === "end");
  expect(ends).toHaveLength(2);
  expect(ends[0]).toMatchObject({ ok: false, message: UNSUPPORTED_INSTALL_FORMAT });
  expect(ends[1]).toMatchObject({ ok: true });
  expect(actions).toEqual(["upload.append", "media.add", "upload.remove"]);
});

test("a host screenshot takes precedence over files and reports host failure without uploading", async () => {
  failure = "media.add";
  const events = await dropFiles([photo()], { hostPath: "/host/screenshot.png" });
  expect(events[0]).toEqual({ type: "host", name: "/host/screenshot.png" });
  expect(events.at(-1)).toMatchObject({ type: "end", ok: false, message: "host operation failed" });
  expect(actions).toEqual(["media.add"]);
});

test.each(["upload.append", "media.add", "disconnect"])(
  "media drop surfaces %s failure and removes the upload",
  async (action) => {
    failure = action;
    const events = await dropFiles([photo()]);
    expect(events.at(-1)).toMatchObject({
      type: "end",
      ok: false,
      message: action === "disconnect" ? "channel disconnected" : "host operation failed",
    });
    expect(actions.at(-1)).toBe("upload.remove");
    expect(actions.filter((a) => a === "media.add")).toHaveLength(action === "media.add" ? 1 : 0);
  },
);
