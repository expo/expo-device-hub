/**
 * A device's 3D preview: Expo's model of the device, textured with its live
 * displays, folding with the hinge of a foldable. The iPhone Duo is shown as in
 * serve-sim's 3D preview. A consumer of `@expo/hub-client`: for a client that
 * streams each display on its own (`client.displays`), it attaches one element
 * per display, reads the fold state, and sends input addressed to the display
 * it hits; for any other client it attaches the flat stream, shows the display
 * whose shape the frame has, and turns the model with the device's
 * orientation. The keyboard works as on the flat `DeviceScreen`.
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

import { type DeviceModelDescription, modelDisplay } from "./device-models";
import { DUO_PANEL_FOR_DISPLAY, duoStreamConfig } from "./duo-displays";
import { DUO_PANEL_SIZE } from "./duo-stage";
import { deviceModelView } from "./duo-view";
import { type DuoModelStatus, DuoModelView } from "./DuoModelView";
import { useDuoFraming } from "./useDuoFraming";
import { useReleaseFocusWhenHidden } from "./useReleaseFocusWhenHidden";

export interface DeviceModelScreenProps {
  /**
   * The device's connection. Render one component per device, for example
   * with the device ID as its `key`: the model's framing belongs to one device.
   */
  client: DeviceClient;
  /** The device's model. Pick it from the device's identity, for example with `deviceModelFor`. */
  model: DeviceModelDescription;
  /** The model's GLB, which the consumer serves. */
  modelUrl: string;
  /** Freeze the departing panel's last frame while the device folds. */
  cacheScreenOnFold?: boolean;
  /** Keep the model at its physical size, or fill the stage as the hinge moves. */
  sizeMode?: "physical" | "fill";
  /**
   * The model is missing, WebGL failed, or the model did not load in time; the
   * consumer should show the flat screen.
   */
  onUnavailable?: () => void;
  /**
   * Whether the preview can draw: the model is loaded into the scene, or it
   * is unavailable and the preview shows the flat display. With
   * `client.framePresented`, it tells when the preview has shown its first
   * display frame; until then the consumer shows loading UI.
   */
  onModelSettledChange?: (settled: boolean) => void;
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

/** The flat stream's element, for a model whose client streams one screen. */
function ScreenSource({ client }: { client: DeviceClient }) {
  const { videoKind, attachVideo } = client;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {videoKind === "canvas" ? (
        <canvas ref={attachVideo} style={PANEL_MEDIA_STYLE} />
      ) : videoKind === "video" ? (
        <video ref={attachVideo} autoPlay muted playsInline style={PANEL_MEDIA_STYLE} />
      ) : (
        <img ref={attachVideo} alt="" draggable={false} style={PANEL_MEDIA_STYLE} />
      )}
    </div>
  );
}

export function DeviceModelScreen({
  client,
  model,
  modelUrl,
  cacheScreenOnFold = false,
  sizeMode = "fill",
  onUnavailable,
  onModelSettledChange,
  onCopy,
}: DeviceModelScreenProps) {
  const {
    fold,
    capabilities,
    displays,
    screen,
    framePresented,
    cancelInput,
    sendTouch,
    sendMultiTouch,
    sendScroll,
  } = client;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const streamConfig = useMemo(() => duoStreamConfig(screen, model), [screen, model]);
  // A client that streams each display on its own reports fold events, which frame the model.
  const separateDisplays = model.streams === "displays";
  const framing = useDuoFraming(fold, capabilities.fold, streamConfig);
  // Any other model shows the display that streams, at the client's hinge angle
  // when it reports one, and turns with the device.
  const streamedScreenId = streamConfig?.screenId === 1 ? 1 : 3;
  const angle = fold?.angle ?? (model.hinge && streamedScreenId === 1 ? 0 : 180);
  const mount = modelDisplay(model, streamedScreenId)?.mount ?? 0;
  const orientation = client.orientation ?? streamConfig?.orientation;
  const orientationView = useMemo(
    () => deviceModelView(angle, mount, orientation),
    [angle, mount, orientation],
  );
  const view = separateDisplays ? framing.view : orientationView;
  const commands = separateDisplays ? framing.commands : undefined;
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
  const modelSettledChange = useRef(onModelSettledChange);
  modelSettledChange.current = onModelSettledChange;
  // A model that cannot load ends the wait too: its flat fallback has frames to show.
  const modelSettled = modelStatus !== "loading";
  useEffect(() => {
    modelSettledChange.current?.(modelSettled);
  }, [modelSettled]);
  useEffect(() => () => modelSettledChange.current?.(false), []);
  // @ref LLP 0015#states — no black displays: the model shows once it has a frame to draw
  // The flat fallback of a model that cannot load waits for the frame too: a
  // retained element can still hold a previous session's pixels.
  const hidden = modelStatus === "loading" || !framePresented;
  useReleaseFocusWhenHidden(hostRef, hidden);
  if (separateDisplays && (!fold || !displays)) return null;
  const activeScreenId =
    separateDisplays && displays
      ? displays.find((display) => display.active)?.id === "cover"
        ? 1
        : 3
      : streamedScreenId;
  // The model's hinge handles move a hinge that takes angles.
  const canMoveHinge = !!model.hinge && !!fold && !!capabilities.fold && !!capabilities.fold.angle;

  return (
    <div
      ref={hostRef}
      role="application"
      aria-label={`Interactive ${model.name}. Focus to control it with your keyboard. Press Shift and Escape to stop keyboard control.`}
      // A hidden preview takes no focus, for its hinge handles too, and is not announced.
      tabIndex={hidden ? -1 : 0}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      style={hidden ? { ...HOST_STYLE, opacity: 0, pointerEvents: "none" } : HOST_STYLE}
      onPointerDownCapture={() => hostRef.current?.focus({ preventScroll: true })}
      onBlur={releasePressedKeys}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
      onContextMenu={(event) => event.preventDefault()}
    >
      <DuoModelView
        model={model}
        modelUrl={modelUrl}
        angle={separateDisplays ? fold?.angle : angle}
        pose={
          separateDisplays || fold
            ? fold?.pose
            : model.hinge
              ? angle === 0
                ? "closed"
                : "open"
              : undefined
        }
        physicalPose={fold?.physical?.pose}
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
        {separateDisplays && displays ? (
          displays.map((display) => (
            <DuoPanelSource key={display.id} display={display} videoKind={client.videoKind} />
          ))
        ) : (
          <ScreenSource client={client} />
        )}
      </DuoModelView>
    </div>
  );
}
