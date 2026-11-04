import { packAppFolderItems, type AppFolderItem } from "./app-drop-folder";

type Request = { type: "start"; items: AppFolderItem[]; bytes: number } | { type: "pull" };
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
scope.onmessage = async ({ data }) => {
  try {
    if (data.type === "start") {
      reader = packAppFolderItems(data.items, data.bytes, (progress) => {
        scope.postMessage({ type: "progress", progress });
      }).getReader();
      scope.postMessage({ type: "ready" });
    } else {
      if (!reader) throw new Error("App packer is not ready");
      const { done, value } = await reader.read();
      if (done) scope.postMessage({ type: "done" });
      else {
        const bytes = value.slice();
        scope.postMessage({ type: "chunk", bytes }, [bytes.buffer]);
      }
    }
  } catch (error) {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "App packing failed",
    });
  }
};
