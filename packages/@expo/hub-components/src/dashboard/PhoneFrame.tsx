import { type ComponentType, type CSSProperties, useLayoutEffect, useState } from "react";

import {
  type AgentInteraction,
  type DeviceClient,
  type DeviceScreenProps,
  type ScreenSize,
} from "@expo/hub-client";
import type { DeviceShapeProps } from "@expo/hub-client/shapes";
import { duoStageMaxSide } from "../foldable/duo-stage";
import type { FoldableDeviceScreenProps } from "../foldable/FoldableDeviceScreen";
import { bg } from "../primitives";
import { AgentDeviceOverlay } from "./AgentDeviceOverlay";
import { type Device } from "./data";
import { DeviceScreenStatus, deviceScreenLoading } from "./DeviceScreenStatus";
import { deviceViewportStyle } from "./deviceViewport";
import {
  deviceScreenClipPath,
  deviceScreenCornersClipPath,
  type ScreenCornerRadiiCqw,
} from "./deviceScreenClipPath";

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

// The iPhone Duo's 3D stage is as large as the flat Duo can be: the cover's
// long side at the MAX_SHORT_SIDE cap, on both axes so that any pose or
// rotation fits, plus the model's fill inset on each side. Below that size it
// shrinks to the stream area, so there the model is two fill insets (64 px)
// smaller than the flat Duo on its limiting side. The stream area is the
// space that StreamPanel keeps clear of the device title and the controls.
// Only that container sizes it, never a native screen configuration,
// so the stage keeps its footprint as the device folds and changes active
// displays: resizing it then would animate on top of the hinge motion. Window
// and sidebar resizes do resize it.
// @ref LLP 0004#stage-size — the Hub caps the stage at the flat Duo's size; serve-sim keeps a fixed 1:1 stage
const DUO_STAGE_MAX_SIDE = duoStageMaxSide(MAX_SHORT_SIDE);
const DUO_STAGE_STYLE: CSSProperties = {
  width: `min(${DUO_STAGE_MAX_SIDE.toFixed(3)}px, 100cqw)`,
  height: `min(${DUO_STAGE_MAX_SIDE.toFixed(3)}px, 100cqh)`,
  flexShrink: 0,
  position: "relative",
  isolation: "isolate",
  containerType: "inline-size",
};

/** How an iPhone Duo is presented: the flat active display, or Xcode's folding 3D model. */
export type FoldPreviewMode = "2d" | "3d";

/** Viewer-local 3D choices; the options pass through to `FoldableDeviceScreen`. */
export type PhoneFrameFoldPreview = { mode: FoldPreviewMode } & Pick<
  FoldableDeviceScreenProps,
  "cacheScreenOnFold" | "sizeMode" | "onUnavailable"
>;

const CONFIG: Record<
  Device["platform"],
  { ratio: number; radiusFraction: number; squircle: boolean }
> = {
  ios: { ratio: 320 / 695, radiusFraction: 55 / 391, squircle: true },
  android: { ratio: 320 / 711, radiusFraction: 10 / 390, squircle: false },
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
 * aspect ratio. The screen is clipped to its device shape, or shows the plain
 * video rectangle when the viewer turns the shape off. The iPhone Duo's 3D stage
 * is capped at the flat Duo's long side on both axes.
 */
// @ref LLP 0013#input-feedback — consumers own input notices without replacing live media
export function PhoneFrame({
  device,
  client,
  agentInteraction,
  onCopy,
  preserveKeyboardFocus = false,
  DeviceScreen,
  FoldableDeviceScreen,
  DeviceShape,
  foldPreview,
  displayScreen,
  showScreenShape = true,
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
   * iPhone Duo 3D renderer from `@expo/hub-components/foldable`, injected so
   * that this entry never loads three.js; without it the Duo stays flat.
   */
  FoldableDeviceScreen?: ComponentType<FoldableDeviceScreenProps>;
  /**
   * Screen shape clip from `@expo/hub-client/shapes`, injected so that this
   * entry bundles the shape table only for a consumer that passes it. It gives
   * a device with a known `model` its own screen corners; without it, or for an
   * unknown model, the screen keeps the platform's generic corners.
   */
  DeviceShape?: ComponentType<DeviceShapeProps>;
  foldPreview?: PhoneFrameFoldPreview;
  /** Orientation-corrected screen sizer, injected from `@expo/hub-client`. */
  displayScreen: (screen?: ScreenSize | null) => ScreenSize | null;
  /**
   * Viewer-local preference: clip the screen to its device shape. Off, the
   * stream shows as the plain video rectangle. Defaults to on.
   */
  showScreenShape?: boolean;
  /** Whether the screen shows its first-load spinner, for a status label beside the frame. */
  onLoadingChange?: (loading: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  // The device whose 3D model is loaded or unavailable; the 3D preview loads until it has one.
  const [modelSettledDevice, setModelSettledDevice] = useState<string | null>(null);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
  const { ratio: fallbackRatio, radiusFraction, squircle } = CONFIG[device.platform];

  // Prefer the live screen's aspect ratio once known, so the stream fills the
  // frame 1:1 instead of being stretched to the placeholder's body ratio. Uses
  // the orientation-corrected (display) size so a rotated device shows landscape.
  const display = client ? displayScreen(client.screen) : null;
  const ratio = display && display.height > 0 ? display.width / display.height : fallbackRatio;

  // The container's width is the phone width; `cqw` on the child resolves
  // against it, so the radius is always `radiusFraction` of the rendered width.
  // The pixel cap applies to the short side: in portrait (ratio < 1) it caps the
  // width directly; in landscape it caps the height (width / ratio), so the
  // frame widens on rotation instead of squeezing into the portrait width.
  const wrapperStyle: CSSProperties = {
    ...deviceViewportStyle({ maxShortSide: MAX_SHORT_SIDE, ratio }),
    ...(client?.fold ? { transition: "width 250ms ease, aspect-ratio 250ms ease" } : {}),
    containerType: "inline-size",
  };

  // `cqw` resolves against the width, but the radius should stay a fraction of
  // the *short* side so the corners look the same in portrait and landscape.
  const radiusCqw = (radiusFraction / Math.max(ratio, 1)) * 100;
  // A display that describes its own glass, like the iPhone Duo's cover and
  // inner panel, is clipped to those corners: what the 3D model shows head-on,
  // without the frame. The client already turned them with the device.
  const displayCorners: ScreenCornerRadiiCqw | null = client?.displayCorners
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
    : `${radiusCqw.toFixed(3)}cqw`;
  const live = client && client.status !== "idle";
  // The folding model needs the client's fold state, separate display streams, and Xcode's model.
  const foldable = !!(
    live &&
    foldPreview?.mode === "3d" &&
    FoldableDeviceScreen &&
    client.fold &&
    client.displays &&
    client.deviceModelUrl
  );
  const loading =
    !!live && deviceScreenLoading(client, !foldable || modelSettledDevice === device.id);
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

  // The folding model draws its own device, so the screen clip does not apply;
  // the status layer and the agent overlay still cover the stage.
  if (foldable && client && FoldableDeviceScreen && foldPreview) {
    const { mode: _mode, ...modelOptions } = foldPreview;
    return (
      <div
        data-testid="device-screen-frame"
        data-device-frame-kind="duo-model"
        data-agent-active={agentInteraction ? "true" : "false"}
        style={DUO_STAGE_STYLE}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
      >
        <div data-testid="device-screen-clip" style={{ position: "absolute", inset: 0 }}>
          <FoldableDeviceScreen
            key={device.id}
            client={client}
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
    clipPath: showScreenShape
      ? displayCorners
        ? deviceScreenCornersClipPath(displayCorners, false)
        : deviceScreenClipPath(radiusCqw, squircle)
      : undefined,
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
      data-display-corners={showScreenShape && displayCorners ? "device" : undefined}
      data-agent-active={agentInteraction ? "true" : "false"}
      style={showScreenShape ? { ...wrapperStyle, borderRadius } : wrapperStyle}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      {DeviceShape ? (
        // A known model's screen shape replaces the generic clip in `screenStyle`;
        // an unknown model keeps it. With the shape off, neither clips. The element
        // stays a DeviceShape either way, so turning the shape on or off does not
        // remount the live screen inside it.
        <DeviceShape
          data-testid="device-screen-clip"
          client={client}
          platform={device.platform}
          model={device.model}
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
