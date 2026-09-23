import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  DeviceKitChromeButton,
  DeviceKitChromeDescriptor,
  GridRect,
} from "../utils/grid";
import type { SimulatorOrientation } from "../types";
import { rotationDegreesForOrientation } from "../simulator/orientation";
import { simEndpoint } from "../utils/sim-endpoint";
import { currentDevicePixelRatio, roundToDevicePixel } from "../utils/simulator-resize";

// Shared DeviceKit chrome renderer. Positions the bezel, screen, and hardware
// buttons in the chrome's own frame coordinate space. Live views pass a
// rendered `containerSize` so those rects snap to device pixels; placeholders
// keep percentage layout.

export type ChromeButtonPress = {
  /** "down" on press, "up" on release. Lets the caller hold power / side
   *  buttons for their long-press menus. */
  phase: "down" | "up";
  button: DeviceKitChromeButton;
};

export function DeviceKitChrome({
  chrome,
  screen,
  interactive = false,
  onButton,
  onCrownWheel,
  containerSize,
  orientation = "portrait",
}: {
  chrome: DeviceKitChromeDescriptor;
  /** Rendered inside the screen cutout (the live stream, or a black fill). */
  screen?: ReactNode;
  interactive?: boolean;
  onButton?: (press: ChromeButtonPress) => void;
  /** Wheel over the Digital Crown — forwards rotation to scroll the watch. */
  onCrownWheel?: (deltaY: number, deltaMode: number) => void;
  containerSize?: { width: number; height: number };
  orientation?: SimulatorOrientation;
}) {
  const geometry = deviceKitChromeGeometry(chrome, orientation);
  const rotation = rotationDegreesForOrientation(orientation);
  const sideways = Math.abs(rotation) === 90;
  const artworkSize = sideways && containerSize
    ? { width: containerSize.height, height: containerSize.width }
    : containerSize;
  const artworkStyle: CSSProperties = {
    pointerEvents: "none",
    ...(rotation === 0
      ? { inset: 0 }
      : {
          left: "50%",
          top: "50%",
          width: artworkSize?.width ?? pct(chrome.frame.width, geometry.frame.width),
          height: artworkSize?.height ?? pct(chrome.frame.height, geometry.frame.height),
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          transformOrigin: "center",
        }),
  };
  const renderButton = (button: DeviceKitChromeButton) => (
    <ChromeButton
      key={`button-${button.name}`}
      chrome={chrome}
      button={button}
      interactive={interactive}
      onButton={onButton}
      onWheel={interactive && button.name === "digital-crown" ? onCrownWheel : undefined}
      containerSize={artworkSize}
    />
  );

  // Apple's composite pictures only the bezel — the hardware buttons are
  // separate sprites that poke out past the metal edge (the part overshooting
  // the bezel is what's visible). So every button is always drawn; `onTop` ones
  // (watch crown / side / action) sit above the bezel, the rest behind it.
  return (
    <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
      <div
        data-devicekit-artwork="back"
        className="absolute"
        style={{ ...artworkStyle, zIndex: 1 }}
      >
        {chrome.buttons.filter((button) => !button.onTop).map(renderButton)}
        {/* The bezel and button artwork retain Apple's portrait coordinates;
            the whole layer rotates around the oriented frame's center. */}
        {chrome.compositeImage ? (
          <ChromeImage
            chrome={chrome}
            image={chrome.compositeImage}
            rect={chrome.body}
            zIndex={1}
            containerSize={artworkSize}
          />
        ) : chrome.slice && chrome.corner ? (
          <NineSliceChrome chrome={chrome} containerSize={artworkSize} />
        ) : null}
      </div>

      {/* Stream ON TOP of the bezel (z2), clipped to the active screen rect with
          the inner-corner radius, so it sits exactly in the screen opening with
          the bezel framing it (matches Apple Simulator). */}
      <div
        data-devicekit-screen=""
        className="absolute overflow-hidden bg-black"
        style={{
          ...rectStyle(geometry, geometry.screen, 2, containerSize),
          borderRadius: deviceKitScreenRadius(chrome, orientation),
          pointerEvents: "auto",
        }}
      >
        {screen}
      </div>

      {/* A transformed element creates a stacking context. Front buttons need
          their own layer to stay above the untransformed live screen. */}
      {chrome.buttons.some((button) => button.onTop) && (
        <div
          data-devicekit-artwork="front"
          className="absolute"
          style={{ ...artworkStyle, zIndex: 5 }}
        >
          {chrome.buttons.filter((button) => button.onTop).map(renderButton)}
        </div>
      )}
    </div>
  );
}

/** Oriented frame and axis-aligned screen bounds, in DeviceKit coordinates. */
export function deviceKitChromeGeometry(
  chrome: DeviceKitChromeDescriptor,
  orientation: SimulatorOrientation = "portrait",
): { frame: { width: number; height: number }; screen: GridRect } {
  const { frame, screen } = chrome;
  const { x, y, width, height } = screen;
  switch (orientation) {
    case "landscape_left":
      return {
        frame: { width: frame.height, height: frame.width },
        screen: { x: frame.height - y - height, y: x, width: height, height: width },
      };
    case "portrait_upside_down":
      return {
        frame,
        screen: { x: frame.width - x - width, y: frame.height - y - height, width, height },
      };
    case "landscape_right":
      return {
        frame: { width: frame.height, height: frame.width },
        screen: { x: y, y: frame.width - x - width, width: height, height: width },
      };
    default:
      return { frame, screen };
  }
}

/** Select the chrome measurements for the currently captured screen. */
export function deviceKitChromeForScreen(
  chrome: DeviceKitChromeDescriptor,
  screenId?: number,
): DeviceKitChromeDescriptor {
  return (screenId === undefined ? undefined : chrome.displayVariants?.[screenId]) ?? chrome;
}

/** CSS border-radius for the screen cutout, matched to its measured corners. */
export function deviceKitScreenRadius(
  chrome: DeviceKitChromeDescriptor,
  orientation?: SimulatorOrientation,
): string {
  const landscape = orientation === "landscape_left" || orientation === "landscape_right";
  const width = landscape ? chrome.screen.height : chrome.screen.width;
  const height = landscape ? chrome.screen.width : chrome.screen.height;
  if (chrome.screenCornerRadii) {
    const { topLeft, topRight, bottomRight, bottomLeft } = chrome.screenCornerRadii;
    const radii = orientation === "landscape_left"
      ? [bottomLeft, topLeft, topRight, bottomRight]
      : orientation === "landscape_right"
        ? [topRight, bottomRight, bottomLeft, topLeft]
        : orientation === "portrait_upside_down"
          ? [bottomRight, bottomLeft, topLeft, topRight]
          : [topLeft, topRight, bottomRight, bottomLeft];
    return `${radii.map((radius) => pct(radius, width)).join(" ")} / ${
      radii.map((radius) => pct(radius, height)).join(" ")
    }`;
  }
  return `${pct(chrome.screenRadius, width)} / ${pct(chrome.screenRadius, height)}`;
}

function ChromeButton({
  chrome,
  button,
  interactive,
  onButton,
  onWheel,
  containerSize,
}: {
  chrome: DeviceKitChromeDescriptor;
  button: DeviceKitChromeButton;
  interactive: boolean;
  onButton?: (press: ChromeButtonPress) => void;
  /** Wheel over this cap (the Digital Crown) → (deltaY, deltaMode). */
  onWheel?: (deltaY: number, deltaMode: number) => void;
  containerSize?: { width: number; height: number };
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const activePointerRef = useRef<number | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);

  // Native (non-passive) wheel listener so it can preventDefault — turning the
  // crown scrolls the watch instead of the page.
  const onWheelRef = useRef(onWheel);
  onWheelRef.current = onWheel;
  useEffect(() => {
    const el = elRef.current;
    if (!el || !onWheel) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onWheelRef.current?.(event.deltaY, event.deltaMode);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
    // Keyed on presence, not identity: the handler reads onWheelRef.current,
    // so a new closure each render must not tear down and re-add the listener
    // (the parent re-renders every frame during a resize/inertia drag).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!onWheel]);
  // A button is only pressable when it carries a HID code; decorative inputs
  // (rare) still render but don't intercept pointer events.
  const pressable = interactive && button.usagePage != null && button.usage != null;

  const release = useCallback(() => {
    if (activePointerRef.current === null) return;
    activePointerRef.current = null;
    setPressed(false);
    onButton?.({ phase: "up", button });
  }, [button, onButton]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      event.preventDefault();
      event.stopPropagation();
      activePointerRef.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
      setPressed(true);
      onButton?.({ phase: "down", button });
    },
    [button, onButton],
  );

  // zIndex vs the bezel (z1) and stream (z2). `onTop` caps (e.g. watch crown /
  // side / action) are drawn ABOVE the bezel so the whole cap shows and is the
  // hit target — exactly where it's clicked. iPhone / iPad buttons sit BEHIND
  // the bezel (z0) so only the overshoot past its transparent edge shows.
  const zIndex = button.onTop ? 5 : 0;

  // The cap slides out on hover/press by its rollover travel; the depressed
  // sprite (or a brightened cap) reads the press.
  const active = pressable && (hovered || pressed);
  const tx = (active ? button.hover.x : 0) * 100;
  const ty = (active ? button.hover.y : 0) * 100;
  const sprite = pressed && button.imageDown ? button.imageDown : button.image;

  const handlers = pressable
    ? {
        onPointerDown,
        onPointerUp: release,
        onPointerCancel: release,
        onPointerEnter: () => setHovered(true),
        onPointerLeave: () => {
          setHovered(false);
          release();
        },
      }
    : {};

  return (
    <div
      ref={elRef}
      role={pressable ? "button" : undefined}
      aria-label={pressable ? buttonLabel(button.name) : undefined}
      aria-hidden={pressable ? undefined : true}
      title={pressable ? buttonLabel(button.name) : undefined}
      className="absolute select-none"
      style={{
        ...rectStyle(chrome, button.frame, zIndex, containerSize),
        transform: tx || ty ? `translate(${tx}%, ${ty}%)` : undefined,
        transition: "transform 0.12s ease",
        cursor: pressable ? "pointer" : undefined,
        pointerEvents: pressable ? "auto" : "none",
        touchAction: "none",
      }}
      {...handlers}
    >
      {sprite && (
        <img
          alt=""
          aria-hidden
          draggable={false}
          src={chromeAssetUrl(chrome.identifier, sprite)}
          className="absolute inset-0 size-full select-none"
          style={{
            objectFit: "fill",
            // Without a dedicated pressed sprite, brighten so the press still
            // reads (no low-opacity dimming, per house style).
            filter: pressed && !button.imageDown ? "brightness(1.4)" : undefined,
            transition: "filter 0.12s ease",
            WebkitUserDrag: "none",
          } as CSSProperties}
        />
      )}
    </div>
  );
}

function buttonLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function NineSliceChrome({
  chrome,
  containerSize,
}: {
  chrome: DeviceKitChromeDescriptor;
  containerSize?: { width: number; height: number };
}) {
  if (!chrome.slice || !chrome.corner) return null;
  const { body, corner, slice } = chrome;
  const midWidth = Math.max(body.width - corner.width * 2, 0);
  const midHeight = Math.max(body.height - corner.height * 2, 0);
  const pieces: Array<{ key: string; image: string; rect: GridRect }> = [
    {
      key: "top-left",
      image: slice.topLeft,
      rect: { x: body.x, y: body.y, width: corner.width, height: corner.height },
    },
    {
      key: "top-right",
      image: slice.topRight,
      rect: {
        x: body.x + body.width - corner.width,
        y: body.y,
        width: corner.width,
        height: corner.height,
      },
    },
    {
      key: "bottom-left",
      image: slice.bottomLeft,
      rect: {
        x: body.x,
        y: body.y + body.height - corner.height,
        width: corner.width,
        height: corner.height,
      },
    },
    {
      key: "bottom-right",
      image: slice.bottomRight,
      rect: {
        x: body.x + body.width - corner.width,
        y: body.y + body.height - corner.height,
        width: corner.width,
        height: corner.height,
      },
    },
    {
      key: "top",
      image: slice.top,
      rect: { x: body.x + corner.width, y: body.y, width: midWidth, height: corner.height },
    },
    {
      key: "bottom",
      image: slice.bottom,
      rect: {
        x: body.x + corner.width,
        y: body.y + body.height - corner.height,
        width: midWidth,
        height: corner.height,
      },
    },
    {
      key: "left",
      image: slice.left,
      rect: { x: body.x, y: body.y + corner.height, width: corner.width, height: midHeight },
    },
    {
      key: "right",
      image: slice.right,
      rect: {
        x: body.x + body.width - corner.width,
        y: body.y + corner.height,
        width: corner.width,
        height: midHeight,
      },
    },
  ];

  return (
    <>
      {pieces
        .filter((piece) => piece.rect.width > 0 && piece.rect.height > 0)
        .map((piece) => (
          <ChromeImage
            key={piece.key}
            chrome={chrome}
            image={piece.image}
            rect={piece.rect}
            zIndex={1}
            containerSize={containerSize}
          />
        ))}
    </>
  );
}

export function ChromeImage({
  chrome,
  image,
  rect,
  zIndex,
  containerSize,
}: {
  chrome: DeviceKitChromeDescriptor;
  image: string;
  rect: GridRect;
  zIndex: number;
  containerSize?: { width: number; height: number };
}) {
  return (
    <img
      alt=""
      aria-hidden
      draggable={false}
      src={chromeAssetUrl(chrome.identifier, image)}
      className="absolute select-none"
      style={{
        ...rectStyle(chrome, rect, zIndex, containerSize),
        objectFit: "fill",
        // The bezel must never swallow taps meant for the screen / buttons.
        pointerEvents: "none",
        WebkitUserDrag: "none",
      } as CSSProperties}
    />
  );
}

export function chromeAssetUrl(identifier: string, image: string): string {
  // v2 honors the PDF page rotation; old rasterizations were cached immutable.
  const path = `grid/api/devicekit-chrome?chrome=${encodeURIComponent(identifier)}&image=${encodeURIComponent(image)}&v=2`;
  return typeof window === "undefined" ? `/${path}` : simEndpoint(path);
}

// Neighbours derive their shared edge from the same number, so no hairline
// seams open between adjacent nine-slice pieces.
export function snapChromeRect(
  chrome: Pick<DeviceKitChromeDescriptor, "frame">,
  rect: GridRect,
  container: { width: number; height: number },
  dpr = currentDevicePixelRatio(),
): { left: number; top: number; width: number; height: number } {
  const left = roundToDevicePixel((rect.x / chrome.frame.width) * container.width, dpr);
  const right = roundToDevicePixel(
    ((rect.x + rect.width) / chrome.frame.width) * container.width,
    dpr,
  );
  const top = roundToDevicePixel((rect.y / chrome.frame.height) * container.height, dpr);
  const bottom = roundToDevicePixel(
    ((rect.y + rect.height) / chrome.frame.height) * container.height,
    dpr,
  );
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function rectStyle(
  chrome: Pick<DeviceKitChromeDescriptor, "frame">,
  rect: GridRect,
  zIndex: number,
  containerSize?: { width: number; height: number },
): CSSProperties {
  if (containerSize && containerSize.width > 0 && containerSize.height > 0) {
    const snapped = snapChromeRect(chrome, rect, containerSize);
    return {
      left: snapped.left,
      top: snapped.top,
      width: snapped.width,
      height: snapped.height,
      zIndex,
    };
  }
  return {
    left: pct(rect.x, chrome.frame.width),
    top: pct(rect.y, chrome.frame.height),
    width: pct(rect.width, chrome.frame.width),
    height: pct(rect.height, chrome.frame.height),
    zIndex,
  };
}

function pct(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}
