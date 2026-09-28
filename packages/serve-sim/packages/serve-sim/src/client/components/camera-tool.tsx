import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { FlipHorizontal2, Images, X } from "lucide-react";
import { PlayGlyph, StopGlyph, ReloadIcon } from "../icons";
import { runHostAction } from "../utils/exec";
import { fileExtension, uploadFileToTmp } from "../utils/drop";
import { CollapsibleSection } from "./collapsible-section";

import {
  isVideoFile,
  type CamSource,
  type CamWebcam,
  type CameraPillState,
  CAMERA_POLL_INTERVAL_MS,
  cameraStatusConnected,
  requestCameraStatus,
  CAMERA_LARGE_VIDEO_WARNING,
  CAMERA_HEIC_ERROR,
  nextCameraPillState,
  parseWebcamListOutput,
  isOversizedCameraVideo,
  isHeicLikeFile,
  cameraSourceErrorMessage,
} from "../utils/camera";
import { type CameraMediaPreviewProps, CameraStatusPill, CameraMediaPreview, CameraInlineBanner } from "./camera-tool-ui";

type CamMirror = "on" | "off";

export function CameraTool({
  udid,
}: {
  udid: string;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<CamSource>("placeholder");
  const [filePath, setFilePath] = useState<string>("");
  const [droppedFileName, setDroppedFileName] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCountRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [webcams, setWebcams] = useState<CamWebcam[]>([]);
  const [webcamLoading, setWebcamLoading] = useState(false);
  const [webcamId, setWebcamId] = useState<string>("");
  const [mirror, setMirror] = useState<CamMirror>("off");
  const [pendingPrimary, setPendingPrimary] = useState<"enable" | "disable" | null>(null);
  const [pendingAux, setPendingAux] = useState<"mirror" | "switch" | null>(null);
  const isBusy = pendingPrimary !== null || pendingAux !== null;
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [pillState, setPillState] = useState<CameraPillState>("ready");
  const [webcamAutoEnableRequest, setWebcamAutoEnableRequest] = useState<string | null>(null);
  const lastFileIsHeicRef = useRef(false);
  const skipNextAutoSwapRef = useRef(false);
  const appliedMirrorRef = useRef<CamMirror>("off");
  const autoOpenedForStreamingRef = useRef(false);

  const fetchCameraStatus = useCallback(async () => {
    const endpoint = window.__SIM_PREVIEW__?.cameraStatusEndpoint;
    return endpoint ? requestCameraStatus(endpoint) : null;
  }, []);

  const refreshWebcamsRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const reply = await fetchCameraStatus();
      if (cancelled || !reply || !reply.alive) return;
      skipNextAutoSwapRef.current = true;
      const replySource = reply.source;
      if (replySource === "placeholder" || replySource === "webcam" || replySource === "image" || replySource === "video") {
        setSource(replySource);
      }
      if ((replySource === "image" || replySource === "video") && reply.arg) {
        setFilePath(reply.arg);
        setDroppedFileName(reply.arg.split("/").pop() ?? null);
      }
      if (replySource === "webcam" && reply.arg) {
        setWebcamId(reply.arg);
        void refreshWebcamsRef.current();
      }
      const replyMirror: CamMirror = reply.mirror === "on" ? "on" : "off";
      setMirror(replyMirror);
      appliedMirrorRef.current = replyMirror;
      setEnabled(true);
      setPillState("active");
    })();
    return () => { cancelled = true; };
  }, [udid, fetchCameraStatus]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const reply = await fetchCameraStatus();
        if (cancelled) return;
        const alive = !!reply?.alive;
        const connected = cameraStatusConnected(reply);
        setPillState((prev) => nextCameraPillState(prev, connected));
        setEnabled(alive);
        if (!alive) appliedMirrorRef.current = "off";
      } finally {
        inFlight = false;
      }
    };

    timer = setInterval(() => { void tick(); }, CAMERA_POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [fetchCameraStatus]);

  const refreshWebcams = useCallback(async () => {
    setWebcamLoading(true);
    setError(null);
    try {
      const res = await runHostAction("camera.listWebcams");
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `--list-webcams failed (${res.exitCode})`);
        return;
      }
      const list = parseWebcamListOutput(res.stdout);
      setWebcams(list);
      if (list.length > 0 && !webcamId) setWebcamId(list[0]!.id);
    } finally {
      setWebcamLoading(false);
    }
  }, [webcamId]);

  useEffect(() => {
    refreshWebcamsRef.current = refreshWebcams;
  }, [refreshWebcams]);

  useEffect(() => {
    if (sourceMenuOpen && webcams.length === 0 && !webcamLoading) {
      void refreshWebcams();
    }
  }, [sourceMenuOpen, webcams.length, webcamLoading, refreshWebcams]);

  const reportSourceError = useCallback((rawMessage: string) => {
    setError(cameraSourceErrorMessage({
      rawMessage,
      lastFileIsHeic: lastFileIsHeicRef.current,
      source,
    }));
  }, [source]);

  const pushSwitch = useCallback(async (
    nextSource: CamSource,
    nextWebcamId: string,
    nextFilePath: string,
  ): Promise<boolean> => {
    const isFile = nextSource === "image" || nextSource === "video";
    if (isFile && !nextFilePath.trim()) {
      setError("Drop a file into the panel or pick another source.");
      return false;
    }
    const target = isFile
      ? nextFilePath.trim()
      : nextSource === "webcam"
        ? nextWebcamId
        : undefined;
    const res = await runHostAction("camera.switch", {
      source: isFile ? "file" : nextSource,
      target,
      udid,
    });
    if (res.exitCode !== 0) {
      reportSourceError(res.stderr.trim() || res.stdout.trim() || `switch failed (${res.exitCode})`);
      return false;
    }
    lastFileIsHeicRef.current = false;
    return true;
  }, [udid, reportSourceError]);

  const enableCamera = useCallback(async () => {
    setPendingPrimary("enable");
    setError(null);
    try {
      const isFile = source === "image" || source === "video";
      if (isFile && !filePath.trim()) {
        setError("Drop a file into the panel or pick another source.");
        return;
      }
      const res = await runHostAction("camera.inject", {
        udid,
        mirror,
        source: isFile ? "file" : source,
        target: isFile ? filePath.trim() : webcamId || undefined,
      });
      if (res.exitCode !== 0) {
        reportSourceError(res.stderr.trim() || res.stdout.trim() || `Could not enable camera (${res.exitCode})`);
        return;
      }
      lastFileIsHeicRef.current = false;
      setEnabled(true);
      setPillState("active");

      appliedMirrorRef.current = mirror;
    } finally {
      setPendingPrimary(null);
    }
  }, [udid, source, filePath, webcamId, mirror, reportSourceError]);

  const autoSwapKey = enabled
    ? `${source}::${source === "webcam" ? webcamId : ""}::${source === "image" || source === "video" ? filePath : ""}`
    : null;

  const isStreaming = enabled && source !== "placeholder";
  useEffect(() => {
    if (!isStreaming) {
      autoOpenedForStreamingRef.current = false;
      return;
    }
    if (autoOpenedForStreamingRef.current) return;
    autoOpenedForStreamingRef.current = true;
    setOpen(true);
  }, [isStreaming]);

  useEffect(() => {
    if (!webcamAutoEnableRequest) return;
    if (isBusy || uploading) return;
    if (source !== "webcam" || webcamId !== webcamAutoEnableRequest) return;
    setWebcamAutoEnableRequest(null);
    if (enabled) return;
    void enableCamera();
  }, [webcamAutoEnableRequest, isBusy, uploading, source, webcamId, enabled, enableCamera]);

  useEffect(() => {
    if (!enabled) return;
    if ((source === "image" || source === "video") && !filePath.trim()) return;
    if (source === "webcam" && !webcamId) return;
    if (skipNextAutoSwapRef.current) {
      skipNextAutoSwapRef.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      setPendingAux("switch");
      setError(null);
      try {
        if (cancelled) return;
        await pushSwitch(source, webcamId, filePath);
      } finally {
        if (!cancelled) setPendingAux(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSwapKey]);

  useEffect(() => {
    if (!enabled) return;
    if (appliedMirrorRef.current === mirror) return;
    const target = mirror;
    let cancelled = false;
    void (async () => {
      setPendingAux("mirror");
      setError(null);
      try {
        const res = await runHostAction("camera.mirror", { value: target, udid });
        if (cancelled) return;
        if (res.exitCode !== 0) {
          setError(res.stderr.trim() || res.stdout.trim() || `mirror failed (${res.exitCode})`);
          return;
        }
        appliedMirrorRef.current = target;
      } finally {
        if (!cancelled) setPendingAux(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirror, enabled]);

  const disableCamera = useCallback(async () => {
    setPendingPrimary("disable");
    setError(null);
    try {
      const res = await runHostAction("camera.stopWebcam", { udid });
      if (res.exitCode !== 0) {
        setError(res.stderr.trim() || `Could not disable camera (${res.exitCode})`);
        return;
      }
      setEnabled(false);
      setPillState("ready");
      appliedMirrorRef.current = "off";
    } finally {
      setPendingPrimary(null);
    }
  }, [udid]);

  const handleSourceFile = useCallback(async (file: File) => {
    const isHeic = isHeicLikeFile({ type: file.type, name: file.name });
    const isImage = file.type.startsWith("image/") || isHeic;
    const isVideo = file.type.startsWith("video/") || isVideoFile({ type: file.type, name: file.name });
    if (!isImage && !isVideo) {
      lastFileIsHeicRef.current = false;
      setError(`Unsupported file type: ${file.type || file.name}`);
      return;
    }
    setUploading(true);
    setError(null);
    setWarning(null);
    if (isOversizedCameraVideo({ type: file.type, name: file.name, size: file.size })) {
      setWarning(CAMERA_LARGE_VIDEO_WARNING);
    }
    lastFileIsHeicRef.current = isHeic;
    try {
      const ext = fileExtension(file);
      const tmpPath = await uploadFileToTmp(file, "serve-sim-camsrc", ext);
      setDroppedFileName(file.name);
      setSource(isVideo ? "video" : "image");
      setFilePath(tmpPath);
    } catch (error) {
      if (lastFileIsHeicRef.current) setError(CAMERA_HEIC_ERROR);
      else setError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, []);

  const onDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setIsDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleSourceFile(file);
  }, [handleSourceFile]);

  const clearMedia = useCallback(() => {
    setSource("placeholder");
    setFilePath("");
    setDroppedFileName(null);
    setError(null);
    setWarning(null);
    lastFileIsHeicRef.current = false;
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFilePicked = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (file) await handleSourceFile(file);
  }, [handleSourceFile]);

  useEffect(() => {
    if (!sourceMenuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-camera-source-menu]")) return;
      setSourceMenuOpen(false);
    };
    window.addEventListener("mousedown", onDocDown);
    return () => window.removeEventListener("mousedown", onDocDown);
  }, [sourceMenuOpen]);

  const selectWebcam = useCallback((webcam: CamWebcam) => {
    setWebcamId(webcam.id);
    setSource("webcam");
    setDroppedFileName(null);
    setError(null);
    lastFileIsHeicRef.current = false;
    setSourceMenuOpen(false);
    setWebcamAutoEnableRequest(webcam.id);
  }, []);

  const toggleMirror = useCallback(() => {
    setMirror((m) => (m === "on" ? "off" : "on"));
  }, []);
  const mirrorDisabled = !enabled || source === "placeholder";

  const onDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current++;
    if (dragCountRef.current === 1) setIsDragOver(true);
  }, []);
  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const primaryDisabled = uploading || pendingPrimary !== null;

  const isPlaceholder = source === "placeholder";
  const showWebcam = source === "webcam";
  const showFile = (source === "image" || source === "video") && !!droppedFileName;
  const activeWebcamName = showWebcam
    ? (webcams.find((w) => w.id === webcamId)?.name ?? webcamId ?? "Webcam")
    : null;
  const tileMode: CameraMediaPreviewProps["mode"] = uploading
    ? "uploading"
    : showFile
      ? "file"
      : showWebcam
        ? "webcam"
        : "placeholder";

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      bodyClassName="pt-2.5"
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">Camera</span>
          <CameraStatusPill state={pillState} />
        </>
      }
    >
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="flex flex-col gap-2.5"
      >
          <p className="m-0 text-[10px] leading-[1.5] text-white/45">
            Choose an image, video, or camera, then enable it for all apps.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={onFilePicked}
          />

          <div
            onClick={(e) => {
              if (!isPlaceholder) return;
              if ((e.target as HTMLElement).closest("[data-clear-media]")) return;
              openFilePicker();
            }}
            title={
              isPlaceholder
                ? "No source selected — Enable uses a test-pattern feed. Click to pick an image/video, or drop one here."
                : showWebcam
                  ? `Source: ${activeWebcamName}`
                  : `Source: ${droppedFileName ?? source}`
            }
            className={[
              "relative min-h-[44px] flex flex-row items-center justify-center gap-2.5 px-3.5 py-2.5 rounded-[7px] text-center transition-[border-color,background] duration-150",
              isPlaceholder
                ? "bg-white/[0.04] border border-dashed border-white/12"
                : "bg-white/[0.04] border border-white/8",
              isDragOver ? "!bg-[rgba(10,132,255,0.08)] !border-[rgba(10,132,255,0.6)]" : "",
              uploading ? "cursor-progress" : isPlaceholder ? "cursor-pointer" : "cursor-default",
            ].join(" ")}
          >
            <CameraMediaPreview
              mode={tileMode}
              fileName={droppedFileName}
              webcamName={activeWebcamName}
              sourceKind={source}
            />

            {!isPlaceholder && !uploading && (
              <button
                data-clear-media
                onClick={(e) => { e.stopPropagation(); clearMedia(); }}
                className="shrink-0 w-5 h-5 flex items-center justify-center bg-transparent border-none text-white/55 hover:text-white/90 cursor-pointer p-0"
                aria-label="Clear source"
                title="Clear → placeholder"
              >
                <X size={14} strokeWidth={2} />
              </button>
            )}
          </div>


          <div className="flex items-stretch gap-1.5">
            <div className="relative" data-camera-source-menu>
              <button
                onClick={() => setSourceMenuOpen((o) => !o)}
                className="h-full min-h-[36px] w-10 flex items-center justify-center bg-transparent border border-white/12 text-white/85 rounded-[7px] cursor-pointer p-0 hover:bg-white/[0.06] hover:border-white/20 hover:text-white"
                aria-haspopup="menu"
                aria-expanded={sourceMenuOpen}
                title={
                  source === "webcam"
                    ? `Source: webcam${webcamId ? ` (${webcams.find((w) => w.id === webcamId)?.name ?? webcamId})` : ""} — click to change`
                    : `Source: ${source} — click to pick media or webcam`
                }
                aria-label="Choose camera source"
              >
                <Images size={20} strokeWidth={2} />
              </button>

              {sourceMenuOpen && (
                <div
                  role="menu"
                  className="absolute top-[calc(100%+6px)] left-0 z-10 min-w-[200px] flex flex-col gap-px p-1 bg-panel border border-white/8 rounded-[7px] shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
                >
                  <button
                    role="menuitem"
                    className="text-left bg-transparent border-none text-white/85 text-[12px] px-2.5 py-[7px] rounded-md cursor-pointer hover:bg-white/[0.06]"
                    onClick={() => { setSourceMenuOpen(false); openFilePicker(); }}
                    title="Pick an image or video from disk"
                  >
                    Browse media…
                  </button>
                  <div className="h-px bg-white/8 my-1" />
                  <div className="flex items-center justify-between pl-2.5 pr-2 pt-1 pb-[2px]">
                    <span className="text-[10px] text-white/45 uppercase tracking-[0.08em]">
                      {webcamLoading ? "Cameras (loading…)" : webcams.length === 0 ? "No cameras" : "Cameras"}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); void refreshWebcams(); }}
                      disabled={webcamLoading}
                      className="flex items-center justify-center w-[22px] h-[22px] bg-transparent border-none rounded-[5px] text-white/55 hover:text-white/90 cursor-pointer p-0 disabled:opacity-50"
                      aria-label="Refresh cameras"
                      title="Refresh cameras"
                    >
                      <ReloadIcon size={13} strokeWidth={2} />
                    </button>
                  </div>
                  {webcams.map((w) => {
                    const active = source === "webcam" && webcamId === w.id;
                    return (
                      <button
                        key={w.id}
                        role="menuitem"
                        className={[
                          "text-left bg-transparent border-none text-[12px] px-2.5 py-[7px] rounded-md cursor-pointer hover:bg-white/[0.06]",
                          active ? "!bg-white/[0.12] !text-white" : "text-white/85",
                        ].join(" ")}
                        onClick={() => selectWebcam(w)}
                        title={w.name}
                      >
                        {w.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              onClick={enabled ? disableCamera : enableCamera}
              disabled={primaryDisabled}
              className={[
                "flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 border-none rounded-[7px] text-[12px] font-semibold cursor-pointer disabled:opacity-50 min-h-[36px]",
                enabled
                  ? "bg-white/[0.16] text-white enabled:hover:bg-white/[0.22]"
                  : "bg-success-emerald text-[#062018] enabled:hover:brightness-[1.08]",
              ].join(" ")}
              title={
                enabled ? "Disconnect the camera from all apps" :
                "Enable the selected camera feed for all apps"
              }
              aria-pressed={enabled}
              aria-label={enabled ? "Disable" : "Enable"}
            >
              {enabled ? <StopGlyph /> : <PlayGlyph />}
              <span>{enabled ? "Disable" : "Enable"}</span>
            </button>

            <button
              type="button"
              onClick={toggleMirror}
              disabled={mirrorDisabled}
              className={`flex items-center justify-center w-10 min-h-[36px] border rounded-[7px] font-[inherit] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97] ${
                mirror === "on"
                  ? "bg-white border-white text-[#0a0a0c] cursor-pointer enabled:hover:bg-white/[0.88] enabled:hover:border-white/[0.88] enabled:hover:text-[#0a0a0c]"
                  : "bg-white/[0.04] border-white/8 text-white/85 cursor-pointer enabled:hover:bg-white/[0.09] enabled:hover:border-[rgba(255,255,255,0.18)] enabled:hover:text-white"
              }`}
              aria-label={`Mirror: ${mirror} — tap to toggle`}
              title={
                mirrorDisabled
                  ? "Mirror toggle available once a source is streaming"
                  : `Mirror: ${mirror} — click to toggle`
              }
              aria-pressed={mirror === "on"}
            >
              <FlipHorizontal2 size={20} strokeWidth={2} fill={mirror === "on" ? "currentColor" : "none"} />
            </button>
          </div>

          {warning && <CameraInlineBanner kind="warning" message={warning} />}
          {error && <CameraInlineBanner kind="error" message={error} />}
        </div>
    </CollapsibleSection>
  );
}
