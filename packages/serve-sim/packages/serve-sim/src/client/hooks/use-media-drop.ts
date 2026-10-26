import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  type DropKind,
  addHostMediaToPhotos,
  dropKindFor,
  DROP_HOST_PATH_TYPE,
  uploadDroppedFile,
  uploadDroppedAppFolder,
} from "../utils/drop";
import { APP_FOLDER_GUIDANCE } from "../utils/app-drop-folder";

import { isUnsupportedAppArchive, UNSUPPORTED_INSTALL_FORMAT } from "../../app-install-format";

type UploadCallbacks = {
  onUploadStart: (name: string, kind: DropKind) => string;
  onUploadProgress: (id: string, progress: number | null) => void;
  onUploadEnd: (id: string, ok: boolean, message?: string) => void;
};

export function startHostPathDrop({
  hostPath,
  udid,
  onUploadStart,
  onUploadProgress,
  onUploadEnd,
  onHostPathDrop,
}: {
  hostPath: string;
  udid: string;
  onHostPathDrop?: (path: string) => void;
} & UploadCallbacks): Promise<void> {
  onHostPathDrop?.(hostPath);
  const name = hostPath.split("/").pop() ?? "image";
  const id = onUploadStart(name, "media");
  onUploadProgress(id, null);
  return addHostMediaToPhotos(hostPath, udid)
    .then(() => onUploadEnd(id, true))
    .catch((err) => onUploadEnd(id, false, err instanceof Error ? err.message : "Add failed"));
}

export function useMediaDrop({
  udid,
  enabled,
  onUploadStart,
  onUploadProgress,
  onUploadEnd,
  onUnsupported,
  onHostPathDrop,
}: {
  udid: string | undefined;
  enabled: boolean;
  onUploadStart: (name: string, kind: DropKind) => string;
  onUploadProgress: (id: string, progress: number | null) => void;
  onUploadEnd: (id: string, ok: boolean, message?: string) => void;
  onUnsupported: (file: File) => void;
  onHostPathDrop?: (path: string) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);
  const folderQueueRef = useRef(Promise.resolve());

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current = 0;
      setIsDragOver(false);

      if (!enabled || !udid) return;

      // In-app drag (the screenshot pill) hands us a host path — the file is
      // already on disk, so addmedia it directly instead of uploading.
      const hostPath = e.dataTransfer.getData(DROP_HOST_PATH_TYPE);
      if (hostPath) {
        void startHostPathDrop({
          hostPath,
          udid,
          onUploadStart,
          onUploadProgress,
          onUploadEnd,
          onHostPathDrop,
        });
        return;
      }

      const files = Array.from(e.dataTransfer.files);
      // Browser entry handles must be acquired while the drop event is live.
      const entries = Array.from(e.dataTransfer.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.webkitGetAsEntry?.() ?? null);
      if (files.length === 0) return;

      for (const [index, file] of files.entries()) {
        const entry = entries[index];
        if (entry?.isDirectory || /\.app$/i.test(file.name)) {
          const id = onUploadStart(file.name, "app");
          const upload = async () => {
            try {
              if (!entry?.isDirectory) throw new Error(APP_FOLDER_GUIDANCE);
              await uploadDroppedAppFolder(entry, udid, (p) => onUploadProgress(id, p));
              onUploadEnd(id, true);
            } catch (error) {
              const message = error instanceof Error ? error.message : "Folder upload failed";
              onUploadEnd(
                id,
                false,
                message.includes(APP_FOLDER_GUIDANCE)
                  ? message
                  : `${message}. ${APP_FOLDER_GUIDANCE}`,
              );
            }
          };
          folderQueueRef.current = folderQueueRef.current.then(upload, upload);
          continue;
        }
        if (isUnsupportedAppArchive(file.name)) {
          const id = onUploadStart(file.name, "media");
          onUploadEnd(id, false, UNSUPPORTED_INSTALL_FORMAT);
          continue;
        }
        const kind = dropKindFor(file);
        if (!kind) {
          onUnsupported(file);
          continue;
        }
        const id = onUploadStart(file.name, kind);
        uploadDroppedFile(file, kind, udid, (p) => onUploadProgress(id, p))
          .then(() => onUploadEnd(id, true))
          .catch((err) =>
            onUploadEnd(id, false, err instanceof Error ? err.message : "Upload failed"),
          );
      }
    },
    [enabled, udid, onUploadStart, onUploadProgress, onUploadEnd, onUnsupported, onHostPathDrop],
  );

  const onDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (enabled) e.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (!enabled) return;
      dragCountRef.current++;
      if (dragCountRef.current === 1) setIsDragOver(true);
    },
    [enabled],
  );

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  return {
    isDragOver,
    dropZoneProps: { onDragOver, onDragEnter, onDragLeave, onDrop: handleDrop },
  };
}
