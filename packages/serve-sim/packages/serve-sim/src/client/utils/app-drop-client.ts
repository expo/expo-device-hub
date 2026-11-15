import { isUnsupportedAppArchive, UNSUPPORTED_INSTALL_FORMAT } from "../../app-install-format";
import {
  uploadDroppedFile,
  uploadDroppedAppFolder,
  dropKindFor,
  type AppDropTransport,
} from "./drop";
import type { AppFolderEntry } from "./app-drop-folder";

// Served by the same middleware as the worker so Hub uses its host's install
// implementation, with the Hub-owned control connection and credentials.
export function createAppDropClient(
  transport: AppDropTransport,
  udid: string,
  workerAsset: { url: string; headers: Record<string, string> },
) {
  return {
    async installFile(file: File, progress: (value: number | null) => void) {
      // Device builds and zips get the specific Simulator-build message, as preview drops do.
      if (isUnsupportedAppArchive(file.name)) throw new Error(UNSUPPORTED_INSTALL_FORMAT);
      if (dropKindFor(file) !== "app")
        throw new Error("Drop a Simulator .app folder or .tar.gz/.tgz archive.");
      await uploadDroppedFile(file, "app", udid, progress, transport);
    },
    installFolder(entry: AppFolderEntry, progress: (value: number | null) => void) {
      return uploadDroppedAppFolder(entry, udid, progress, transport, workerAsset);
    },
  };
}
