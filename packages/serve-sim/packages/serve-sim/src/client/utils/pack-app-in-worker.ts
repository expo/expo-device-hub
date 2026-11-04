import { readAppFolder, type AppFolderEntry } from "./app-drop-folder";
import { simAuthHeaders, simEndpoint } from "./sim-endpoint";

// Folder handles only work on the page. File objects are cloneable; all content
// reads, mode detection, tar generation and compression happen in the worker.
export async function packAppInWorker(
  entry: AppFolderEntry,
  onProgress: (progress: number) => void,
) {
  const folder = await readAppFolder(entry);
  const response = await fetch(simEndpoint("app-drop-worker.js"), { headers: simAuthHeaders() });
  if (!response.ok) throw new Error(`Could not load app packer (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  let worker: Worker;
  try {
    worker = new Worker(url, { type: "module" });
  } finally {
    URL.revokeObjectURL(url);
  }
  let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  let ready!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  let finishPull: (() => void) | undefined;
  let finished = false;
  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    const error = new Error(message);
    rejectReady(error);
    controller.error(error);
    finishPull?.();
    worker.terminate();
  };
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      start(value) {
        controller = value;
      },
      async pull() {
        await started;
        await new Promise<void>((resolve) => {
          finishPull = resolve;
          worker.postMessage({ type: "pull" });
        });
      },
      cancel() {
        finished = true;
        worker.terminate();
        finishPull?.();
      },
    },
    { highWaterMark: 0 },
  );
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case "ready":
        ready();
        break;
      case "progress":
        onProgress(data.progress);
        break;
      case "chunk":
        controller.enqueue(data.bytes);
        finishPull?.();
        break;
      case "done":
        finished = true;
        controller.close();
        finishPull?.();
        worker.terminate();
        break;
      case "error":
        fail(data.message);
        break;
    }
  };
  worker.onerror = () => fail("App packing failed. Try a .tar.gz/.tgz archive.");
  try {
    worker.postMessage({ type: "start", ...folder });
  } catch (error) {
    worker.terminate();
    throw error;
  }
  await started;
  return stream;
}
