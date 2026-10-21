import { type CSSProperties } from "react";
import {
  type DeviceChrome,
  type DeviceChromeButton,
  type DeviceChromeRect,
  type DeviceOrientation,
} from "@expo/hub-client";

import { FRAME_BUTTON_TRANSITION, type FrameButtonActivity } from "./hardwareButtons";
import {
  deviceFramePresentation,
  deviceFrameRotation,
  deviceFrameLayout,
  type DeviceFramePresentation,
  type DeviceFrameRotation,
} from "./deviceFrame";

// Apple's DeviceKit chrome, as serve-sim resolves it, drawn the way serve-sim's preview draws it
// (`device-chrome-frame.tsx`): the bezel artwork is opaque inside the screen opening, so the
// live screen sits above it, clipped to the opening with Apple's measured corners.

export type DeviceKitArtworkPiece = {
  key: string;
  image: string;
  rect: DeviceChromeRect;
  /** `back` sits behind the bezel, `front` above the screen (watch crowns). */
  layer: "back" | "bezel" | "front";
  /** The hardware button this sprite draws. */
  button?: DeviceChromeButton;
};

/** Every image of a chrome in drawing order, in its portrait frame coordinates. */
export function deviceKitArtworkPieces(chrome: DeviceChrome): DeviceKitArtworkPiece[] {
  const buttons = (onTop: boolean): DeviceKitArtworkPiece[] =>
    chrome.buttons
      .filter((button) => button.onTop === onTop)
      .map((button) => ({
        key: `button-${button.name}`,
        image: button.image,
        rect: button.frame,
        layer: onTop ? "front" : "back",
        button,
      }));
  return [...buttons(false), ...bezelPieces(chrome), ...buttons(true)];
}

function bezelPieces(chrome: DeviceChrome): DeviceKitArtworkPiece[] {
  const { body, corner, slice } = chrome;
  if (chrome.compositeImage) {
    return [{ key: "composite", image: chrome.compositeImage, rect: body, layer: "bezel" }];
  }
  if (!slice || !corner) return [];
  const midWidth = Math.max(body.width - corner.width * 2, 0);
  const midHeight = Math.max(body.height - corner.height * 2, 0);
  const right = body.x + body.width - corner.width;
  const bottom = body.y + body.height - corner.height;
  const piece = (key: string, image: string, x: number, y: number, width: number, height: number) =>
    ({ key, image, rect: { x, y, width, height }, layer: "bezel" }) as DeviceKitArtworkPiece;
  return [
    piece("top-left", slice.topLeft, body.x, body.y, corner.width, corner.height),
    piece("top-right", slice.topRight, right, body.y, corner.width, corner.height),
    piece("bottom-left", slice.bottomLeft, body.x, bottom, corner.width, corner.height),
    piece("bottom-right", slice.bottomRight, right, bottom, corner.width, corner.height),
    piece("top", slice.top, body.x + corner.width, body.y, midWidth, corner.height),
    piece("bottom", slice.bottom, body.x + corner.width, bottom, midWidth, corner.height),
    piece("left", slice.left, body.x, body.y + corner.height, corner.width, midHeight),
    piece("right", slice.right, right, body.y + corner.height, corner.width, midHeight),
  ];
}

const SLICE_BLEED_PX = 0.5;
const STRETCHED_SLICES = new Set(["top", "bottom", "left", "right"]);

function percent(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(4)}%`;
}

/** Portrait corners in CSS order (top-left, top-right, bottom-right, bottom-left) after rotation. */
function rotatedCorners(chrome: DeviceChrome, rotation: DeviceFrameRotation): number[] {
  const r = chrome.screenCornerRadii ?? {
    topLeft: chrome.screenRadius,
    topRight: chrome.screenRadius,
    bottomRight: chrome.screenRadius,
    bottomLeft: chrome.screenRadius,
  };
  switch (rotation) {
    case 90:
      return [r.bottomLeft, r.topLeft, r.topRight, r.bottomRight];
    case -90:
      return [r.topRight, r.bottomRight, r.bottomLeft, r.topLeft];
    case 180:
      return [r.bottomRight, r.bottomLeft, r.topLeft, r.topRight];
    default:
      return [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft];
  }
}

export type DeviceKitFramePresentation = DeviceFramePresentation & {
  /** Rotated box for the `front` pieces, above the screen. */
  frontArtworkStyle: CSSProperties;
  rotation: DeviceFrameRotation;
};

/** The Hub's framed layout for a DeviceKit chrome: same sizing and rotation as a PNG frame. */
export function deviceKitFramePresentation({
  chrome,
  orientation,
  displayRatio,
  maxScreenShortSide,
}: {
  chrome: DeviceChrome;
  orientation: DeviceOrientation | null | undefined;
  displayRatio: number;
  maxScreenShortSide: number;
}): DeviceKitFramePresentation {
  const asset = {
    width: chrome.frame.width,
    height: chrome.frame.height,
    screen: chrome.screen,
    screenRadius: chrome.screenRadius,
  };
  const base = deviceFramePresentation({ asset, orientation, displayRatio, maxScreenShortSide });
  const rotation = deviceFrameRotation(orientation, displayRatio);
  const layout = deviceFrameLayout(asset, rotation);
  const corners = rotatedCorners(chrome, rotation);
  const cqw = corners.map((r) => `${((r / layout.width) * 100).toFixed(4)}cqw`).join(" ");
  const cqh = corners.map((r) => `${((r / layout.height) * 100).toFixed(4)}cqh`).join(" ");
  return {
    ...base,
    rotation,
    screenStyle: {
      position: "absolute",
      left: percent(layout.screen.x, layout.width),
      top: percent(layout.screen.y, layout.height),
      width: percent(layout.screen.width, layout.width),
      height: percent(layout.screen.height, layout.height),
      containerType: "size",
      zIndex: 2,
      overflow: "hidden",
      borderRadius: `${cqw} / ${cqh}`,
    } as CSSProperties,
    artworkStyle: { ...base.artworkStyle, zIndex: 1 },
    frontArtworkStyle: { ...base.artworkStyle, zIndex: 3 },
  };
}

/** The pieces of one layer group, placed by percent inside a rotated artwork box. */
export function DeviceKitArtwork({
  chrome,
  layers,
  style,
  name,
  activity,
}: {
  chrome: DeviceChrome;
  layers: ReadonlyArray<DeviceKitArtworkPiece["layer"]>;
  style: CSSProperties;
  name: string;
  /** The hovered cap slides out by its rollover travel; the pressed one shows its down image. */
  activity?: FrameButtonActivity;
}) {
  const pieces = deviceKitArtworkPieces(chrome).filter((piece) => layers.includes(piece.layer));
  if (!pieces.length) return null;
  const { frame } = chrome;
  // Percent edges land on fractional pixels, which open hairline seams between nine-slice
  // pieces; serve-sim snaps them to device pixels, and here they overlap by half a pixel.
  const place = (value: number, total: number, sliced: boolean) =>
    sliced ? `calc(${percent(value, total)} - ${SLICE_BLEED_PX}px)` : percent(value, total);
  const size = (value: number, total: number, sliced: boolean) =>
    sliced ? `calc(${percent(value, total)} + ${SLICE_BLEED_PX * 2}px)` : percent(value, total);
  return (
    <div data-devicekit-artwork={name} aria-hidden="true" style={style}>
      {pieces.map((piece) => {
        const sliced = piece.layer === "bezel" && piece.key !== "composite";
        // The edge slices are one pixel thick; smooth stretching fades their ends into seams.
        const stretched = sliced && STRETCHED_SLICES.has(piece.key);
        if (piece.button) {
          const { button } = piece;
          const hovered = activity?.hovered === button.name || activity?.pressed === button.name;
          const pressed = activity?.pressed === button.name;
          return (
            <div
              key={piece.key}
              style={{
                position: "absolute",
                left: percent(piece.rect.x, frame.width),
                top: percent(piece.rect.y, frame.height),
                width: percent(piece.rect.width, frame.width),
                height: percent(piece.rect.height, frame.height),
                transform: hovered
                  ? `translate(${button.hover.x * 100}%, ${button.hover.y * 100}%)`
                  : undefined,
                transition: `transform ${FRAME_BUTTON_TRANSITION}`,
              }}
            >
              <img
                src={chrome.assetUrl(pressed && button.imageDown ? button.imageDown : piece.image)}
                alt=""
                draggable={false}
                decoding="async"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "fill",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              />
            </div>
          );
        }
        return (
          <img
            key={piece.key}
            src={chrome.assetUrl(piece.image)}
            alt=""
            draggable={false}
            decoding="async"
            style={{
              position: "absolute",
              left: place(piece.rect.x, frame.width, sliced),
              top: place(piece.rect.y, frame.height, sliced),
              width: size(piece.rect.width, frame.width, sliced),
              height: size(piece.rect.height, frame.height, sliced),
              objectFit: "fill",
              imageRendering: stretched ? "pixelated" : undefined,
              userSelect: "none",
              pointerEvents: "none",
            }}
          />
        );
      })}
    </div>
  );
}
