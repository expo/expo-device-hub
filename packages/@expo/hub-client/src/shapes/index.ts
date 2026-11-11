/**
 * Device screen shapes: `@expo/hub-client/shapes`.
 *
 * A separate entry point, so an app that does not show screen shapes bundles
 * neither the shape table nor this code. The main `@expo/hub-client` entry
 * never imports it.
 *
 * - {@link DeviceShape} — a `div` clipped to a device's screen shape, which
 *   follows a device client like `DeviceScreen`.
 * - {@link useScreenShape} — the shape as the viewer sees it, for layout.
 * - {@link resolveScreenShape} + {@link SCREEN_SHAPES} — the shape table, with
 *   real devices only.
 * - {@link screenShapeClipPath} and the geometry helpers — the CSS for an
 *   element that cannot be wrapped, and blends between two shapes.
 */

// @ref LLP 0017#separate-entry — tree shaking keeps the table out of apps without shapes
export { DeviceShape, type DeviceShapeProps } from "./DeviceShape";
export { useScreenShape, type ScreenShapeClient, type ScreenShapeSource } from "./useScreenShape";
export {
  hasDisplayScreenShapes,
  resolveScreenShape,
  SCREEN_SHAPES,
  type ScreenShapeName,
  type ScreenShapeQuery,
} from "./catalog";
export {
  interpolateScreenShapeGeometry,
  rotateScreenShape,
  screenShapeClipPath,
  screenShapeGeometry,
  screenShapeGeometryClipPath,
  screenShapeOrientation,
  type ScreenCorner,
  type ScreenShape,
  type ScreenShapeClipOptions,
  type ScreenShapeGeometry,
  type ScreenShapeGeometryCorner,
  type ScreenShapeRect,
} from "./screen-shape";
