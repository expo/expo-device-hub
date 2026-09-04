import { type DragEvent, type KeyboardEvent, useRef, useState } from "react";

import {
  type DeviceCameraFacing,
  type DeviceCameraFeed,
  type DeviceClient,
} from "@expo/hub-client";
import { Button, bg, border, radius, text, textSize } from "../primitives";
import { CollapsibleSection } from "./CollapsibleSection";
import { SectionNote } from "./SectionNote";

const CAMERA_FACING_ORDER: readonly DeviceCameraFacing[] = ["back", "front"];
const FACING_LABELS: Record<DeviceCameraFacing, string> = {
  back: "Back camera",
  front: "Front camera",
};

const UNWIRED_NOTE =
  "This emulator started without camera feeds. Shut it down and boot it from Hub to attach them.";
const CLOSING_NOTE = "PNG only. The app sees a new image after it reopens the camera.";

function formatBytes(value: number) {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function feedStatus(feed: DeviceCameraFeed) {
  if (feed.imageUrl === null) return "No image";

  const parts: string[] = [];
  if (feed.width !== null && feed.height !== null) parts.push(`${feed.width}×${feed.height}`);
  if (feed.placeholder) parts.push("Test card");
  else if (feed.bytes !== null) parts.push(formatBytes(feed.bytes));
  return parts.join(" · ") || "Image set";
}

/** Host-fed emulator camera images: one preview, picker, and reset per facing. */
export function CameraSection({
  client,
  defaultOpen = false,
}: {
  client: DeviceClient;
  /** Whether the section is initially expanded. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const inputs = useRef<Record<DeviceCameraFacing, HTMLInputElement | null>>({
    back: null,
    front: null,
  });
  const camera = client.camera;
  const wired = camera?.wiredAtLaunch ?? false;

  function openPicker(facing: DeviceCameraFacing) {
    inputs.current[facing]?.click();
  }

  return (
    <CollapsibleSection title="Camera" open={open} onOpenChange={setOpen}>
      {camera === null ? (
        <SectionNote>Reading camera feeds…</SectionNote>
      ) : (
        <>
          {!wired && <SectionNote>{UNWIRED_NOTE}</SectionNote>}
          {CAMERA_FACING_ORDER.map((facing) => {
            const feed = camera.feeds.find((item) => item.facing === facing);
            if (!feed) return null;

            const label = FACING_LABELS[facing];
            const pending = client.cameraPending.has(facing);
            const disabled = pending || !wired;
            const pickerHandlers = disabled
              ? {}
              : {
                  onDragOver: (event: DragEvent<HTMLDivElement>) => event.preventDefault(),
                  onDrop: (event: DragEvent<HTMLDivElement>) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files[0];
                    if (file) client.setCameraImage(facing, file);
                  },
                  onClick: () => openPicker(facing),
                  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openPicker(facing);
                  },
                };
            return (
              <div key={facing} style={{ padding: "0 0 12px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "0 0 6px",
                  }}
                >
                  <span style={{ ...textSize.sm, fontWeight: 500, color: text.secondary }}>
                    {label}
                  </span>
                  <span style={{ ...textSize.xs, color: text.tertiary }}>{feedStatus(feed)}</span>
                </div>
                <div
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled || undefined}
                  aria-label={`Choose a PNG for the ${facing} camera`}
                  {...pickerHandlers}
                  style={{
                    aspectRatio: "4 / 3",
                    width: "100%",
                    boxSizing: "border-box",
                    backgroundColor: bg.subtle,
                    border: `1px solid ${border.default}`,
                    borderRadius: radius.md,
                    overflow: "hidden",
                    cursor: disabled ? "default" : "pointer",
                  }}
                >
                  {feed.imageUrl && (
                    <img
                      src={feed.imageUrl}
                      alt={`${label} image`}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        display: "block",
                      }}
                    />
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, padding: "8px 0 0" }}>
                  <Button
                    theme="secondary"
                    size="xs"
                    disabled={disabled}
                    onClick={() => openPicker(facing)}
                  >
                    Choose PNG…
                  </Button>
                  <Button
                    theme="tertiary"
                    size="xs"
                    disabled={disabled || feed.placeholder}
                    onClick={() => client.clearCameraImage(facing)}
                  >
                    Reset
                  </Button>
                </div>
                {pending && <SectionNote role="status">{`Updating ${facing} camera…`}</SectionNote>}
                <input
                  ref={(node) => {
                    inputs.current[facing] = node;
                  }}
                  type="file"
                  accept="image/png"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) client.setCameraImage(facing, file);
                    event.target.value = "";
                  }}
                  style={{ display: "none" }}
                />
              </div>
            );
          })}
          {client.cameraError && <SectionNote role="alert">{client.cameraError}</SectionNote>}
          <SectionNote>{CLOSING_NOTE}</SectionNote>
        </>
      )}
    </CollapsibleSection>
  );
}
