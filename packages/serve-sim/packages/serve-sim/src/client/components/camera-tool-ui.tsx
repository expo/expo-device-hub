import type { CamSource, CameraPillState } from "../utils/camera";

export function CameraStatusPill({ state }: { state: CameraPillState }) {
  const label =
    state === "active" ? "Active" : state === "disconnected" ? "Disconnected" : "Ready";
  const dotClass =
    state === "active"
      ? "size-1.5 rounded-full bg-success-emerald [box-shadow:0_0_6px_rgba(74,222,128,0.7)]"
      : state === "disconnected"
        ? "size-1.5 rounded-full bg-danger-soft [box-shadow:0_0_6px_rgba(248,113,113,0.55)]"
        : null;
  return (
    <span
      className="text-[11px] text-white/55 font-mono inline-flex items-center gap-1.5 justify-self-end leading-none"
      data-camera-pill-state={state}
    >
      {dotClass && <span className={dotClass} />}
      {label}
    </span>
  );
}

export interface CameraMediaPreviewProps {
  mode: "placeholder" | "file" | "webcam" | "browser" | "uploading";
  fileName: string | null;
  webcamName: string | null;
  sourceKind: CamSource;
}

export function CameraMediaPreview({
  mode,
  fileName,
  webcamName,
  sourceKind,
}: CameraMediaPreviewProps) {
  if (mode === "uploading") {
    return <span className="text-[11px] text-white/55">Uploading…</span>;
  }
  if (mode === "file") {
    return (
      <>
        <div className="shrink-0 text-[9px] tracking-[0.1em] uppercase text-white/55 bg-white/[0.06] border border-white/8 px-[7px] py-[2px] rounded-full">
          {sourceKind === "video" ? "Video" : "Image"}
        </div>
        <span className="flex-1 min-w-0 truncate text-[12px] text-white/90 font-mono">
          {fileName ?? ""}
        </span>
      </>
    );
  }
  if (mode === "webcam" || mode === "browser") {
    return (
      <>
        <div className="shrink-0 text-[9px] tracking-[0.1em] uppercase text-white/55 bg-white/[0.06] border border-white/8 px-[7px] py-[2px] rounded-full">
          {mode === "browser" ? "Browser" : "Webcam"}
        </div>
        <span className="flex-1 min-w-0 truncate text-[12px] text-white/90 font-mono">
          {webcamName ?? ""}
        </span>
      </>
    );
  }
  return <span className="text-[12px] text-white/85 font-medium">Select or drop media</span>;
}

export function CameraInlineBanner({
  kind,
  message,
}: {
  kind: "error" | "warning";
  message: string;
}) {
  const classes =
    kind === "warning"
      ? "bg-warning/10 border border-warning/25 text-warning-soft text-[11px] px-2 py-1.5 rounded-md break-words"
      : "bg-danger/10 border border-danger/20 text-danger-soft text-[11px] px-2 py-1.5 rounded-md break-words";
  return (
    <div className={classes} data-camera-banner-kind={kind} role={kind === "error" ? "alert" : "status"}>
      {message}
    </div>
  );
}
