/**
 * The iPhone Duo as serve-sim's 3D preview: Xcode's model, textured with both
 * live displays, folding with the hinge. A consumer of `@expo/hub-client`: it
 * attaches one element per `client.displays` entry, reads the fold state, and
 * sends input addressed to the display it hits. The keyboard works as on the
 * flat `DeviceScreen`.
 */

import {
  type DeviceClient,
  type DeviceDisplay,
  listenForInputCancellation,
  useDeviceKeyboard,
} from "@expo/hub-client";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DUO_PANEL_FOR_DISPLAY, duoStreamConfig } from "./duo-displays";
import { type DuoModelStatus, DuoModelView } from "./DuoModelView";
import { useDuoFraming } from "./useDuoFraming";

export interface FoldableDeviceScreenProps {
  /**
   * The device's connection. Render one component per device, for example
   * with the device ID as its `key`: the model's framing belongs to one device.
   */
  client: DeviceClient;
  /** Freeze the departing panel's last frame while the device folds. */
  cacheScreenOnFold?: boolean;
  /** Keep the model at its physical size, or fill the stage as the hinge moves. */
  sizeMode?: "physical" | "fill";
  /**
   * Xcode's model is missing, WebGL failed, or the model did not load in
   * time; the consumer should show the flat screen.
   */
  onUnavailable?: () => void;
  /**
   * Whether Xcode's model is loaded into the scene. With `client.framePresented`, it tells
   * when the preview has shown its first display frame; until then the
   * preview draws nothing, and the consumer shows loading UI.
   */
  onModelReadyChange?: (ready: boolean) => void;
  /** Copy the device app's selected text, as on `DeviceScreen`. */
  onCopy?: () => Promise<void>;
}

const HOST_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  outline: "none",
  // Keep the hinge handles' stacking inside the model, under a consumer's overlay.
  isolation: "isolate",
};

// Framebuffer dimensions only establish the hidden source view's layout.
// The scene reads each decoded frame's actual size for its texture mapping.
const DUO_PANEL_SIZE: Record<number, { width: number; height: number }> = {
  1: { width: 1398, height: 2034 },
  3: { width: 2007, height: 2853 },
};

const PANEL_MEDIA_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "contain",
};

/**
 * One display's element, painted by the client. It stays mounted, hidden,
 * while the scene samples it, under `[data-duo-panel]` for the scene to find.
 */
function DuoPanelSource({
  display,
  videoKind,
}: {
  display: DeviceDisplay;
  videoKind: DeviceClient["videoKind"];
}) {
  const panel = DUO_PANEL_FOR_DISPLAY[display.id];
  const size = DUO_PANEL_SIZE[panel];
  return (
    <div
      data-duo-panel={panel}
      style={{
        position: "absolute",
        inset: 0,
        visibility: display.active ? "visible" : "hidden",
        aspectRatio: size ? `${size.width} / ${size.height}` : undefined,
      }}
    >
      {videoKind === "canvas" ? (
        <canvas ref={display.attachVideo} style={PANEL_MEDIA_STYLE} />
      ) : videoKind === "video" ? (
        <video ref={display.attachVideo} autoPlay muted playsInline style={PANEL_MEDIA_STYLE} />
      ) : (
        <img ref={display.attachVideo} alt="" draggable={false} style={PANEL_MEDIA_STYLE} />
      )}
    </div>
  );
}

export function FoldableDeviceScreen({
  client,
  cacheScreenOnFold = false,
  sizeMode = "fill",
  onUnavailable,
  onModelReadyChange,
  onCopy,
}: FoldableDeviceScreenProps) {
  const {
    fold,
    capabilities,
    displays,
    deviceModelUrl,
    screen,
    framePresented,
    cancelInput,
    sendTouch,
    sendMultiTouch,
    sendScroll,
  } = client;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const streamConfig = useMemo(() => duoStreamConfig(screen), [screen]);
  const { view, commands } = useDuoFraming(fold, capabilities.fold, streamConfig);
  const { onKeyDown, onKeyUp, onPaste, releasePressedKeys, resetShortcuts } = useDeviceKeyboard(
    client,
    { onCopy },
  );
  // As on the flat screen, input the browser can no longer release is cancelled.
  const cancelBrowserInput = useCallback(() => {
    resetShortcuts();
    releasePressedKeys();
    cancelInput?.();
  }, [resetShortcuts, releasePressedKeys, cancelInput]);
  useLayoutEffect(() => {
    const stopListening = listenForInputCancellation(cancelBrowserInput);
    return () => {
      stopListening();
      cancelBrowserInput();
    };
  }, [cancelBrowserInput]);
  const setAngle = useCallback(
    (value: number) => fold?.setControl({ control: "angle", value }),
    [fold],
  );
  const [modelStatus, setModelStatus] = useState<DuoModelStatus>("loading");
  const modelReadyChange = useRef(onModelReadyChange);
  modelReadyChange.current = onModelReadyChange;
  const modelReady = modelStatus === "ready";
  useEffect(() => {
    modelReadyChange.current?.(modelReady);
  }, [modelReady]);
  useEffect(() => () => modelReadyChange.current?.(false), []);
  // @ref LLP 0015#states — no black displays: the model shows once it has a frame to draw
  const hidden = modelStatus === "loading" || (modelReady && !framePresented);
  if (!fold || !displays || !deviceModelUrl) return null;
  const activeScreenId = displays.find((display) => display.active)?.id === "cover" ? 1 : 3;
  // The model's hinge handles move a hinge that takes angles.
  const canMoveHinge = !!capabilities.fold && !!capabilities.fold.angle;

  return (
    <div
      ref={hostRef}
      role="application"
      aria-label="Interactive iPhone Duo. Focus to control it with your keyboard. Press Shift and Escape to stop keyboard control."
      // A hidden preview takes no focus and is not announced.
      tabIndex={hidden ? -1 : 0}
      aria-hidden={hidden || undefined}
      style={hidden ? { ...HOST_STYLE, opacity: 0, pointerEvents: "none" } : HOST_STYLE}
      onPointerDownCapture={() => hostRef.current?.focus({ preventScroll: true })}
      onBlur={releasePressedKeys}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
      onContextMenu={(event) => event.preventDefault()}
    >
      <DuoModelView
        modelUrl={deviceModelUrl}
        angle={fold.angle}
        pose={fold.pose}
        physicalPose={fold.physical?.pose}
        activeScreenId={activeScreenId}
        view={view}
        streamConfig={streamConfig}
        hingeCommands={commands}
        onUnavailable={onUnavailable}
        onStatusChange={setModelStatus}
        cacheScreenOnFold={cacheScreenOnFold}
        sizeMode={sizeMode}
        onHingeAngleChange={canMoveHinge ? setAngle : undefined}
        onTouch={sendTouch}
        onMultiTouch={sendMultiTouch}
        onScroll={sendScroll}
      >
        {displays.map((display) => (
          <DuoPanelSource key={display.id} display={display} videoKind={client.videoKind} />
        ))}
      </DuoModelView>
    </div>
  );
}
