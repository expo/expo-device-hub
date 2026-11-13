/**
 * Screen shape geometry: the type, rotation, and the CSS that clips an element
 * to a shape. Ported from the expo.dev website (expo/universe#32697, #32698,
 * #32682), which renders the same paths.
 */

import { type DeviceOrientation, type ScreenSize } from "../types";

/** One screen corner: a superellipse with exponent `n` that spans `size` along each edge. */
export interface ScreenCorner {
  size: number;
  n: number;
}

/**
 * The outline of a device screen. `width` and `height` are the screen size in
 * the unit of the corner sizes, points on iOS and density-independent pixels
 * on Android. Corners keep their share of the short side at any rendered size.
 */
export interface ScreenShape {
  width: number;
  height: number;
  topLeft: ScreenCorner;
  topRight: ScreenCorner;
  bottomRight: ScreenCorner;
  bottomLeft: ScreenCorner;
}

/**
 * A screen whose four corners are the same. Internal: it builds the device
 * table, and `@expo/hub-client/shapes` exports device shapes only.
 */
export function uniformScreenShape(
  width: number,
  height: number,
  corner: ScreenCorner,
): ScreenShape {
  return {
    width,
    height,
    topLeft: corner,
    topRight: corner,
    bottomRight: corner,
    bottomLeft: corner,
  };
}

/**
 * The orientation a screen shape turns by for a screen as the viewer sees it
 * (pass `displayScreen(client.screen)`). A landscape frame can only come from a
 * sideways device, also when the stream reports no orientation or an upright
 * one, and hub-client does not say which side is up, so it counts as
 * `landscape_left`. Without a screen, the shape stays upright.
 */
export function screenShapeOrientation(
  screen: Pick<ScreenSize, "width" | "height" | "orientation"> | null | undefined,
): DeviceOrientation {
  const orientation = screen?.orientation ?? "portrait";
  const sideways = orientation === "landscape_left" || orientation === "landscape_right";
  return screen && screen.width > screen.height && !sideways ? "landscape_left" : orientation;
}

const rotatedScreenShapes = new WeakMap<ScreenShape, Map<DeviceOrientation, ScreenShape>>();

/**
 * A portrait screen shape as the viewer sees it on a device in `orientation`.
 * Width and height swap on a sideways device, and each corner moves where the
 * turn puts it: `landscape_left` is a clockwise turn, `landscape_right` a
 * counterclockwise one. The same shape and orientation give the same object,
 * so the clip path cache keeps its entries.
 */
export function rotateScreenShape(shape: ScreenShape, orientation: DeviceOrientation): ScreenShape {
  if (orientation === "portrait") return shape;
  let byOrientation = rotatedScreenShapes.get(shape);
  if (!byOrientation) {
    byOrientation = new Map();
    rotatedScreenShapes.set(shape, byOrientation);
  }
  let rotated = byOrientation.get(orientation);
  if (!rotated) {
    const { width, height, topLeft, topRight, bottomRight, bottomLeft } = shape;
    rotated =
      orientation === "landscape_left"
        ? {
            width: height,
            height: width,
            topLeft: bottomLeft,
            topRight: topLeft,
            bottomRight: topRight,
            bottomLeft: bottomRight,
          }
        : orientation === "landscape_right"
          ? {
              width: height,
              height: width,
              topLeft: topRight,
              topRight: bottomRight,
              bottomRight: bottomLeft,
              bottomLeft: topLeft,
            }
          : {
              width,
              height,
              topLeft: bottomRight,
              topRight: bottomLeft,
              bottomRight: topLeft,
              bottomLeft: topRight,
            };
    byOrientation.set(orientation, rotated);
  }
  return rotated;
}

const Samples = 18;

/** Corners are drawn in a 100 × 100 box and scaled to their size. */
const Tile = 100;

/**
 * The corner curve in a `Tile` × `Tile` box with the outer corner at (0,0),
 * from the vertical edge at (0, Tile) to the horizontal edge at (Tile, 0). It
 * is the superellipse |1 - x/Tile|^n + |1 - y/Tile|^n = 1, so it meets both
 * edges tangentially.
 */
function cornerPoints(n: number) {
  const points: [number, number][] = [];
  for (let i = 0; i <= Samples; i++) {
    const t = (i / Samples) * (Math.PI / 2);
    points.push([Tile - Tile * Math.cos(t) ** (2 / n), Tile - Tile * Math.sin(t) ** (2 / n)]);
  }
  return points;
}

function percent(value: number) {
  return `${Math.round(value * 1e6) / 1e4}%`;
}

/** A rectangle in fractions of an element, with a top-left origin. */
export interface ScreenShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A corner's exponent, and its size divided by the screen's short side. */
export interface ScreenShapeGeometryCorner {
  n: number;
  box: number;
}

/**
 * A screen shape shown in a rectangle of an element: the rectangle and its four
 * corners, clockwise from top left. Two geometries blend with
 * {@link interpolateScreenShapeGeometry}.
 */
export interface ScreenShapeGeometry {
  rect: ScreenShapeRect;
  /** How far the shape's edges move in from `rect` on every side, in CSS pixels. */
  insetPx: number;
  corners: readonly [
    ScreenShapeGeometryCorner,
    ScreenShapeGeometryCorner,
    ScreenShapeGeometryCorner,
    ScreenShapeGeometryCorner,
  ];
}

const FullRect: ScreenShapeRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * A screen shape shown in `rect`, or in the whole element by default, moved in
 * by `insetPx` CSS pixels on every side.
 */
export function screenShapeGeometry(
  shape: ScreenShape,
  rect: ScreenShapeRect = FullRect,
  insetPx = 0,
): ScreenShapeGeometry {
  const shortSide = Math.min(shape.width, shape.height);
  const corner = ({ size, n }: ScreenCorner) => ({ n, box: size / shortSide });
  return {
    rect,
    insetPx,
    corners: [
      corner(shape.topLeft),
      corner(shape.topRight),
      corner(shape.bottomRight),
      corner(shape.bottomLeft),
    ],
  };
}

function mix(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

/** Blends two geometries: each corner's exponent and size, the rectangle, and the inset. */
export function interpolateScreenShapeGeometry(
  from: ScreenShapeGeometry,
  to: ScreenShapeGeometry,
  progress: number,
): ScreenShapeGeometry {
  const corner = (index: 0 | 1 | 2 | 3): ScreenShapeGeometryCorner => ({
    n: mix(from.corners[index].n, to.corners[index].n, progress),
    box: mix(from.corners[index].box, to.corners[index].box, progress),
  });
  return {
    rect: {
      x: mix(from.rect.x, to.rect.x, progress),
      y: mix(from.rect.y, to.rect.y, progress),
      width: mix(from.rect.width, to.rect.width, progress),
      height: mix(from.rect.height, to.rect.height, progress),
    },
    insetPx: mix(from.insetPx, to.insetPx, progress),
    corners: [corner(0), corner(1), corner(2), corner(3)],
  };
}

// @ref LLP 0017#clip-path-not-mask — a mask image lands a few device pixels off at fractional sizes
/**
 * The CSS `clip-path` that shows exactly a geometry: the rectangle, with each
 * corner's curve sized as its share of the rectangle's short side.
 * `aspectRatio` is the element's width divided by its height. The points are
 * percentages of the element, so the shape stays exact at any size with that
 * aspect ratio.
 */
export function screenShapeGeometryClipPath(
  { rect, insetPx, corners }: ScreenShapeGeometry,
  aspectRatio: number,
): string {
  // Work in a box `aspectRatio` wide and 1 high, so the short side is measured in the same unit.
  const left = rect.x * aspectRatio;
  const top = rect.y;
  const right = (rect.x + rect.width) * aspectRatio;
  const bottom = rect.y + rect.height;
  const shortSide = Math.min(right - left, bottom - top);
  // `dx` and `dy` are 1 on the left and top sides and -1 on the right and bottom
  // sides, so a positive `insetPx` moves every point in.
  const offset = (value: string, direction: 1 | -1) => {
    const px = Math.round(direction * insetPx * 1e4) / 1e4;
    return px === 0 ? value : `calc(${value} + ${px}px)`;
  };
  const point = (x: number, y: number, dx: 1 | -1, dy: 1 | -1) =>
    `${offset(percent(x / aspectRatio), dx)} ${offset(percent(y), dy)}`;
  const corner = (index: 0 | 1 | 2 | 3, ox: number, oy: number, sx: 1 | -1, sy: 1 | -1) => {
    const size = corners[index].box * shortSide;
    // From the vertical edge to the horizontal edge, in the corner's own direction.
    return cornerPoints(corners[index].n).map(([u, v]) =>
      point(ox + (sx * u * size) / Tile, oy + (sy * v * size) / Tile, sx, sy),
    );
  };
  // Clockwise: top left (left edge to top edge), top right (top edge to right edge), and so on.
  const points = [
    ...corner(0, left, top, 1, 1),
    ...corner(1, right, top, -1, 1).reverse(),
    ...corner(2, right, bottom, -1, -1),
    ...corner(3, left, bottom, 1, -1).reverse(),
  ];
  return `polygon(${points.join(", ")})`;
}

const clipPaths = new WeakMap<ScreenShape, Map<string, string>>();

/** Options of {@link screenShapeClipPath}. */
export interface ScreenShapeClipOptions {
  /** The element's width divided by its height. Defaults to the shape's own. */
  aspectRatio?: number;
  /** Moves every edge of the shape in by this many CSS pixels. Defaults to 0. */
  insetPx?: number;
}

/**
 * The CSS `clip-path` that clips a whole element to a screen shape. Pass the
 * shape as the viewer sees it, turned with {@link rotateScreenShape}. Results
 * are cached per shape object.
 */
export function screenShapeClipPath(
  shape: ScreenShape,
  { aspectRatio = shape.width / shape.height, insetPx = 0 }: ScreenShapeClipOptions = {},
): string {
  let byKey = clipPaths.get(shape);
  if (!byKey) {
    byKey = new Map();
    clipPaths.set(shape, byKey);
  }
  const key = `${aspectRatio}:${insetPx}`;
  let clipPath = byKey.get(key);
  if (!clipPath) {
    clipPath = screenShapeGeometryClipPath(
      screenShapeGeometry(shape, undefined, insetPx),
      aspectRatio,
    );
    byKey.set(key, clipPath);
  }
  return clipPath;
}
