import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { AppFolderEntry } from "../../client/utils/app-drop-folder";
import { packAppInWorker } from "../../client/utils/pack-app-in-worker";

// Keep the shipped worker client and upload pipeline. Control only browser
// delivery so failures can occur before readiness, mid-stream or during a pull.
type Mode =
  | "success"
  | "constructor-error"
  | "start-error"
  | "post-error"
  | "stream-error"
  | "runtime-error"
  | "hang";
let mode: Mode;
const workers: ProtocolWorker[] = [];
const revoked: string[] = [];
const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
let refuseUpload = false;
const originals = {
  Worker: globalThis.Worker,
  fetch: globalThis.fetch,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
};

class ProtocolWorker {
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  onPull?: () => void;
  pulls = 0;
  terminated = 0;
  constructor(readonly url: string) {
    if (mode === "constructor-error") throw new Error("Worker creation blocked");
    workers.push(this);
  }
  emit(data: unknown) {
    queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data })));
  }
  postMessage(message: { type: string }) {
    if (message.type === "start") {
      if (mode === "post-error") throw new DOMException("Cannot clone files", "DataCloneError");
      this.emit(
        mode === "start-error"
          ? { type: "error", message: "Cannot start packer" }
          : { type: "ready" },
      );
      return;
    }
    this.pulls++;
    this.onPull?.();
    if (mode === "hang") return;
    if (mode === "runtime-error") {
      queueMicrotask(() => this.onerror?.({} as ErrorEvent));
    } else if (mode === "stream-error" && this.pulls === 2) {
      this.emit({ type: "error", message: "Cannot read app file" });
    } else if (this.pulls === 1) {
      this.emit({
        type: "chunk",
        bytes: mode === "success" ? new Uint8Array([1, 2, 3]) : new Uint8Array(DROP_CHUNK_BYTES),
      });
    } else this.emit({ type: "done" });
  }
  terminate() {
    this.terminated++;
  }
}

globalThis.Worker = ProtocolWorker as unknown as typeof Worker;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { __SIM_PREVIEW__: { basePath: "/", execToken: "test-token" } },
});
globalThis.fetch = Object.assign(async () => new Response("worker asset"), {
  preconnect: originals.fetch.preconnect,
});
URL.createObjectURL = () => "blob:app-packer";
URL.revokeObjectURL = (url) => revoked.push(url);
afterAll(() => {
  globalThis.Worker = originals.Worker;
  globalThis.fetch = originals.fetch;
  URL.createObjectURL = originals.createObjectURL;
  URL.revokeObjectURL = originals.revokeObjectURL;
  if (originals.window) Object.defineProperty(globalThis, "window", originals.window);
  else Reflect.deleteProperty(globalThis, "window");
  mock.restore();
});
beforeEach(() => {
  mode = "success";
  workers.length = actions.length = revoked.length = 0;
  refuseUpload = false;
});

function folder(): AppFolderEntry {
  return {
    name: "Test.app",
    isDirectory: true,
    isFile: false,
    createReader: () => ({ readEntries: (ok) => ok([]) }),
  };
}
const transport = async (action: string, params: Record<string, unknown> = {}) => {
  actions.push({ action, params });
  return {
    exitCode: action === "upload.append" && refuseUpload ? 1 : 0,
    stdout: "/tmp/staged-app.tgz",
    stderr: action === "upload.append" && refuseUpload ? "Upload refused" : "",
  };
};
mock.module("../../socket/client-control", () => ({ runHostAction: transport }));
const { DROP_CHUNK_BYTES, uploadDroppedAppFolder } = await import("../../client/utils/drop");

test("worker construction failure revokes the asset URL", async () => {
  mode = "constructor-error";
  await expect(packAppInWorker(folder(), () => {})).rejects.toThrow("Worker creation blocked");
  expect(workers).toHaveLength(0);
  expect(revoked).toEqual(["blob:app-packer"]);
});

test.each(["start-error", "post-error"] as const)(
  "startup %s terminates the worker and revokes its asset",
  async (failure) => {
    mode = failure;
    await expect(packAppInWorker(folder(), () => {})).rejects.toThrow(
      failure === "start-error" ? "Cannot start packer" : "Cannot clone files",
    );
    expect(workers[0]!.terminated).toBe(1);
    expect(revoked).toEqual([workers[0]!.url]);
  },
);

test.each(["stream-error", "runtime-error"] as const)(
  "%s fails the upload, removes staging and never installs",
  async (failure) => {
    mode = failure;
    await expect(uploadDroppedAppFolder(folder(), "device", () => {})).rejects.toThrow(
      failure === "stream-error" ? "Cannot read app file" : "App packing failed",
    );
    expect(actions.map(({ action }) => action)).toEqual(
      failure === "stream-error" ? ["upload.append", "upload.remove"] : ["upload.remove"],
    );
    if (failure === "stream-error")
      expect(actions[1]!.params.uploadId).toBe(actions[0]!.params.uploadId);
    expect(workers[0]!.terminated).toBe(1);
    expect(revoked).toEqual([workers[0]!.url]);
  },
);

test("cancelling an outstanding pull finishes the read and terminates the worker", async () => {
  mode = "hang";
  const stream = await packAppInWorker(folder(), () => {});
  const worker = workers[0]!;
  const pulled = new Promise<void>((resolve) => {
    worker.onPull = resolve;
  });
  const reader = stream.getReader();
  const pendingRead = reader.read();
  await pulled;
  await reader.cancel();
  expect(await pendingRead).toEqual({ value: undefined, done: true });
  expect(worker.terminated).toBe(1);
  expect(worker.pulls).toBe(1);
});

test("a host upload failure cancels packing and removes the staged upload", async () => {
  mode = "stream-error";
  refuseUpload = true;
  await expect(uploadDroppedAppFolder(folder(), "device", () => {})).rejects.toThrow(
    "Upload refused",
  );
  expect(actions.map(({ action }) => action)).toEqual(["upload.append", "upload.remove"]);
  expect(actions[1]!.params.uploadId).toBe(actions[0]!.params.uploadId);
  expect(workers[0]!.pulls).toBe(1);
  expect(workers[0]!.terminated).toBe(1);
});

test("the client requests no chunk until read and does not prefetch the next", async () => {
  const stream = await packAppInWorker(folder(), () => {});
  const worker = workers[0]!;
  expect(worker.pulls).toBe(0);
  const reader = stream.getReader();
  expect(await reader.read()).toEqual({ value: new Uint8Array([1, 2, 3]), done: false });
  expect(worker.pulls).toBe(1);
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  expect(worker.terminated).toBe(1);
});
