import { useRef, useState, type DragEvent } from "react";
import type { DeviceClient } from "@expo/hub-client";
import { bg, border, radius, text, textSize, CloseIcon } from "../primitives";

const GUIDANCE =
  "Drop a Simulator .app folder or .tar.gz/.tgz archive. Use an archive for apps with symlinks: browsers may leave them out.";

export function useAppDrop(backend: DeviceClient["appInstall"], enabled: boolean) {
  const queue = useRef(Promise.resolve());
  const [over, setOver] = useState(false);
  const [messages, setMessages] = useState<Record<string, { message: string; done: boolean }>>({});
  const update = (id: string, message: string, done = false) =>
    setMessages((current) => ({ ...current, [id]: { message, done } }));
  const onDrop = (event: DragEvent) => {
    if (!enabled || !backend || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    // Acquire directory handles while this browser event is live.
    const entries = Array.from(event.dataTransfer.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.webkitGetAsEntry());
    for (const [index, file] of Array.from(event.dataTransfer.files).entries()) {
      const entry = entries[index];
      const id = crypto.randomUUID();
      const folder = !!entry?.isDirectory;
      if (folder ? !/\.app$/i.test(entry.name) : !/\.(tar\.gz|tgz)$/i.test(file.name)) {
        update(id, GUIDANCE, true);
        continue;
      }
      update(id, `Waiting to upload ${file.name}…`);
      const install = async () => {
        const progress = (value: number | null) =>
          update(
            id,
            value === null
              ? `Installing ${file.name}…`
              : `Uploading ${file.name}… ${Math.round(value * 100)}%`,
          );
        progress(0);
        try {
          if (folder) await backend.installFolder(entry!, progress);
          else await backend.installFile(file, progress);
          update(id, `Installed ${file.name}`, true);
        } catch (error) {
          update(
            id,
            `${file.name}: ${error instanceof Error ? error.message : "Installation failed"}`,
            true,
          );
        }
      };
      queue.current = queue.current.then(install, install);
    }
  };
  return {
    props: {
      onDrop,
      onDragOver: (event: DragEvent) => {
        if (enabled && backend && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setOver(true);
        }
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(false);
      },
    },
    notice: (
      <>
        {over && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 10,
              pointerEvents: "none",
              border: `2px dashed ${border.info}`,
              background: bg.overlay,
              color: text.default,
              display: "grid",
              placeItems: "center",
              ...textSize.base,
            }}
          >
            {GUIDANCE}
          </div>
        )}
        <div
          aria-live="polite"
          style={{
            position: "absolute",
            bottom: 16,
            right: 16,
            zIndex: 11,
            width: "min(320px,90%)",
            display: "grid",
            gap: 8,
            maxHeight: "40%",
            overflowY: "auto",
          }}
        >
          {Object.entries(messages).map(([id, { message, done }]) => (
            <div
              key={id}
              style={{
                background: bg.default,
                color: text.default,
                border: `1px solid ${border.default}`,
                borderRadius: radius.md,
                padding: 12,
                display: "flex",
                gap: 8,
                ...textSize.xs,
              }}
            >
              <span
                style={{ overflowWrap: "anywhere", maxHeight: 160, overflowY: "auto", flex: 1 }}
              >
                {message}
              </span>
              {done && (
                <button
                  type="button"
                  aria-label="Dismiss app upload"
                  style={{
                    flexShrink: 0,
                    width: 24,
                    height: 24,
                    display: "grid",
                    placeItems: "center",
                    padding: 0,
                    border: 0,
                    background: "transparent",
                    color: text.secondary,
                    cursor: "pointer",
                  }}
                  onClick={() => setMessages(({ [id]: _dismissed, ...rest }) => rest)}
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </>
    ),
  };
}
