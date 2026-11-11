import { type ComponentType, type CSSProperties, useLayoutEffect, useState } from "react";

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
} from "@expo/hub-client";
import type { DeviceShapeProps } from "@expo/hub-client/shapes";
import {
  type DeviceModelAssets,
  type DeviceModelDescription,
  deviceModelPreview,
} from "../foldable/device-models";
import type { DeviceModelScreenProps } from "../foldable/DeviceModelScreen";
import { modelStageMaxSide } from "../foldable/duo-stage";
import { bg } from "../primitives";
import { AgentDeviceOverlay } from "./AgentDeviceOverlay";
import { type Device } from "./data";
import { DeviceScreenStatus, deviceScreenLoading } from "./DeviceScreenStatus";
import { deviceViewportStyle } from "./deviceViewport";
import { deviceScreenCornersClipPath, type ScreenCornerRadiiCqw } from "./deviceScreenClipPath";

// No solid layer stays under a presented stream. The browser blends the
// anti-aliased clipped edge of every layer it clips, so a solid layer under the
// stream shows as a thin line along the screen's edge. The surface is its own
// layer, shown only until the stream presents its first frame.
// @ref LLP 0017#hub-dashboard — no solid layer under the stream; the shape moves in by 1px
const SCREEN_SURFACE_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  backgroundColor: bg.element,
};

// A stream can paint up to about 0.75 CSS px short of its box, so a known screen
// shape moves in by this much and the picture reaches past its edges.
const SCREEN_SHAPE_INSET_PX = 1;

// Cap on the device's *short* side (portrait width / landscape height). Sizing
// by the short side keeps the physical phone the same size across rotations:
// in landscape the long side lies horizontally, so what was the portrait
// height becomes the width instead of the frame shrinking into the old width.
const MAX_SHORT_SIDE = 480;

// A model's 3D stage is as large as the flat device can be: the long side of
// its longest display at the MAX_SHORT_SIDE cap (the iPhone Duo's cover), on
// both axes so that any pose or rotation fits, plus the model's fill inset on
// each side. Below that size it shrinks to the stream area, so there the model
// is two fill insets (64 px) smaller than the flat device on its limiting
// side. The stream area is the space that StreamPanel keeps clear of the
// device title and the controls. Only that container sizes it, never a native
// screen configuration, so the stage keeps its footprint as the device folds,
// turns, and changes active displays: resizing it then would animate on top of
// the hinge motion. Window and sidebar resizes do resize it.
// @ref LLP 0004#stage-size — the Hub caps the stage at the flat device's size; serve-sim keeps a fixed 1:1 stage
function modelStageStyle(model: DeviceModelDescription): CSSProperties {
  const maxSide = modelStageMaxSide(model, MAX_SHORT_SIDE);
  return {
    width: `min(${maxSide.toFixed(3)}px, 100cqw)`,
    height: `min(${maxSide.toFixed(3)}px, 100cqh)`,
    flexShrink: 0,
    position: "relative",
    isolation: "isolate",
    containerType: "inline-size",
  };
}

/** How a device with a 3D model is presented: the flat active display, or its 3D model. */
export type FoldPreviewMode = "2d" | "3d";

/** Viewer-local 3D choices; the options pass through to `DeviceModelScreen`. */
export type PhoneFrameFoldPreview = { mode: FoldPreviewMode } & Pick<
  DeviceModelScreenProps,
  "cacheScreenOnFold" | "sizeMode" | "onUnavailable"
>;

/** The screen's aspect ratio before the stream reports its size. */
const PLACEHOLDER_RATIO: Record<Device["platform"], number> = {
  ios: 320 / 695,
  android: 320 / 711,
};

/**
 * The selected device's screen. When a {@link DeviceClient} connection is active
 * (a serve-sim/serve-emu server is selected) it renders the live, interactive
 * `DeviceScreen` — injected by the consumer from `@expo/hub-client` so this
 * library stays free of a runtime dependency on it; otherwise it shows an empty
 * idle surface. It draws the screen's loading spinner and errors over both
 * renderers, which draw neither.
 *
 * The phone stays as large as fits (short side capped at {@link MAX_SHORT_SIDE},
 * shrinking to the available height or panel width), with the stream's exact
 * aspect ratio. The screen is clipped to its device shape. A device without a
 * known shape, or a viewer who turns the shape off, sees the whole video
 * rectangle. A device's 3D stage is capped at the flat device's long side on
 * both axes.
 */
// @ref LLP 0013#input-feedback — consumers own input notices without replacing live media
export function PhoneFrame({
  device,
  client,
  agentInteraction,
  onCopy,
  preserveKeyboardFocus = false,
  DeviceScreen,
  DeviceModelScreen,
  DeviceShape,
  foldPreview,
  displayScreen,
  showScreenShape = true,
  deviceModelAssets,
  onLoadingChange,
}: {
  device: Device;
  client?: DeviceClient;
  agentInteraction?: AgentInteraction | null;
  onCopy?: DeviceScreenProps["onCopy"];
  preserveKeyboardFocus?: boolean;
  /** Live-stream renderer, injected from `@expo/hub-client` by the consumer. */
  DeviceScreen: ComponentType<DeviceScreenProps>;
  /**
   * 3D renderer from `@expo/hub-components/foldable`, injected so that this
   * entry never loads three.js; without it every device stays flat.
   */
  DeviceModelScreen?: ComponentType<DeviceModelScreenProps>;
  /**
   * Screen shape clip from `@expo/hub-client/shapes`, injected so that this
   * entry bundles the shape table only for a consumer that passes it. It gives
   * a device with a known `model` its own screen corners; without it, or for an
   * unknown model, the screen is the whole video rectangle.
   */
  DeviceShape?: ComponentType<DeviceShapeProps>;
  foldPreview?: PhoneFrameFoldPreview;
  /** Orientation-corrected screen sizer, injected from `@expo/hub-client`. */
  displayScreen: (screen?: ScreenSize | null) => ScreenSize | null;
  /**
   * Viewer-local preference: clip the screen to its device shape. Off, the
   * stream shows as the whole video rectangle. Defaults to on.
   */
  showScreenShape?: boolean;
  /** Consumer-owned 3D model files; a device whose model has no URL stays flat. */
  deviceModelAssets?: DeviceModelAssets;
  /** Whether the screen shows its first-load spinner, for a status label beside the frame. */
  onLoadingChange?: (loading: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  // The device whose 3D model is loaded or unavailable; the 3D preview loads until it has one.
  const [modelSettledDevice, setModelSettledDevice] = useState<string | null>(null);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
  const fallbackRatio = PLACEHOLDER_RATIO[device.platform];

  // Prefer the live screen's aspect ratio once known, so the stream fills the
  // frame 1:1 instead of being stretched to the placeholder's body ratio. Uses
  // the orientation-corrected (display) size so a rotated device shows landscape.
  const display = client ? displayScreen(client.screen) : null;
  const ratio = display && display.height > 0 ? display.width / display.height : fallbackRatio;

  // The pixel cap applies to the short side: in portrait (ratio < 1) it caps the
  // width directly; in landscape it caps the height (width / ratio), so the
  // frame widens on rotation instead of squeezing into the portrait width.
  const wrapperStyle: CSSProperties = {
    ...deviceViewportStyle({ maxShortSide: MAX_SHORT_SIDE, ratio }),
    ...(client?.fold ? { transition: "width 250ms ease, aspect-ratio 250ms ease" } : {}),
    containerType: "inline-size",
  };

  // A display that describes its own glass, like the iPhone Duo's cover and
  // inner panel, is clipped to those corners when no table shape is known for
  // its model: what the 3D model shows head-on. The client already turned them
  // with the device. `cqw` resolves against the frame's width.
  const displayCorners: ScreenCornerRadiiCqw | null =
    showScreenShape && client?.displayCorners
      ? {
          topLeft: client.displayCorners.topLeft * 100,
          topRight: client.displayCorners.topRight * 100,
          bottomRight: client.displayCorners.bottomRight * 100,
          bottomLeft: client.displayCorners.bottomLeft * 100,
        }
      : null;
  const borderRadius = displayCorners
    ? [
        displayCorners.topLeft,
        displayCorners.topRight,
        displayCorners.bottomRight,
        displayCorners.bottomLeft,
      ]
        .map((corner) => `${corner.toFixed(3)}cqw`)
        .join(" ")
    : undefined;
  const live = client && client.status !== "idle";
  // The model needs the device's model file and, for the iPhone Duo, its fold state and both displays.
  const modelPreview =
    live && foldPreview?.mode === "3d" && DeviceModelScreen
      ? deviceModelPreview(device, client, deviceModelAssets)
      : null;
  const loading =
    !!live && deviceScreenLoading(client, !modelPreview || modelSettledDevice === device.id);
  useLayoutEffect(() => {
    onLoadingChange?.(loading);
  }, [onLoadingChange, loading]);
  const screenStatus = live ? (
    <DeviceScreenStatus
      loading={loading}
      error={client.status === "error" ? (client.error ?? "Disconnected") : null}
      inputError={client.inputError}
    />
  ) : null;
  const overlayVisible =
    !!agentInteraction && hovered && dismissedInteractionId !== agentInteraction.id;

  const deviceSurface = live ? (
    <DeviceScreen
      client={client}
      agentInteraction={agentInteraction}
      onCopy={onCopy}
      preserveKeyboardFocus={preserveKeyboardFocus}
    />
  ) : (
    <div style={SCREEN_SURFACE_STYLE} />
  );
  const takeoverOverlay = (
    <div
      data-testid="agent-device-overlay-clip"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 2,
        pointerEvents: overlayVisible ? "auto" : "none",
      }}
    >
      <AgentDeviceOverlay
        visible={overlayVisible}
        onTakeOver={() => setDismissedInteractionId(agentInteraction?.id ?? null)}
      />
    </div>
  );

  // The model draws its own device, so the screen clip does not apply; the
  // status layer and the agent overlay still cover the stage.
  if (modelPreview && client && DeviceModelScreen && foldPreview) {
    const { mode: _mode, ...modelOptions } = foldPreview;
    return (
      <div
        data-testid="device-screen-frame"
        data-device-frame-kind="device-model"
        data-device-model={modelPreview.model.id}
        data-agent-active={agentInteraction ? "true" : "false"}
        style={modelStageStyle(modelPreview.model)}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
      >
        <div data-testid="device-screen-clip" style={{ position: "absolute", inset: 0 }}>
          <DeviceModelScreen
            key={device.id}
            client={client}
            model={modelPreview.model}
            modelUrl={modelPreview.url}
            onCopy={onCopy}
            onModelSettledChange={(settled) => setModelSettledDevice(settled ? device.id : null)}
            {...modelOptions}
          />
          {screenStatus}
          {takeoverOverlay}
        </div>
      </div>
    );
  }

  const screenStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    // One responsive path clips both the stream and every overlay, which
    // avoids fractional seams between separate composited masks.
    clipPath: displayCorners ? deviceScreenCornersClipPath(displayCorners, false) : undefined,
  };

  const screenContent = (
    <>
      {live && !client.framePresented ? (
        <div data-testid="device-screen-surface" style={SCREEN_SURFACE_STYLE} />
      ) : null}
      <div data-testid="device-screen-stream" style={{ position: "absolute", inset: 0 }}>
        {deviceSurface}
      </div>
      {screenStatus}
      {takeoverOverlay}
    </>
  );

  return (
    <div
      data-testid="device-screen-frame"
      data-device-frame-kind="flat"
      data-display-corners={displayCorners ? "device" : undefined}
      data-agent-active={agentInteraction ? "true" : "false"}
      style={borderRadius ? { ...wrapperStyle, borderRadius } : wrapperStyle}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      {DeviceShape ? (
        // A known model's screen shape replaces the DeviceKit corners in
        // `screenStyle`. An unknown model, or the shape turned off, shows the whole
        // video rectangle. The element stays a DeviceShape either way, so turning
        // the shape on or off does not remount the live screen inside it.
        // @ref LLP 0017#hub-dashboard — no shape known, no clip: the whole stream rectangle
        <DeviceShape
          data-testid="device-screen-clip"
          client={client}
          platform={device.platform}
          // A device whose model the server cannot name has no shape: an empty
          // model stops the fallback to the client's device name, which a user
          // can rename.
          model={device.model ?? ""}
          shape={showScreenShape ? undefined : null}
          aspectRatio={ratio}
          insetPx={SCREEN_SHAPE_INSET_PX}
          style={screenStyle}
        >
          {screenContent}
        </DeviceShape>
      ) : (
        <div data-testid="device-screen-clip" style={screenStyle}>
          {screenContent}
        </div>
      )}
    </div>
  );
}
