/**
 * Stage fitting and hinge-handle projection for the iPhone Duo model, ported
 * from serve-sim's `src/client/simulator/duo-layout.ts` (@expo/serve-sim 0.5.0).
 */

import { Box3, Matrix4, Mesh, Vector3, type Object3D, type PerspectiveCamera } from "three";

import { stepDuoSpring } from "./duo-pose";

export type DuoViewportSize = { width: number; height: number };
export type DuoCanvasRect = DuoViewportSize & { left: number; top: number };
export type DuoScreenPoint = { x: number; y: number };

function validSize(size: DuoViewportSize) {
  return (
    Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0
  );
}

function visitBoxCorners(box: Box3, point: Vector3, visit: (point: Vector3) => void) {
  for (let corner = 0; corner < 8; corner++) {
    point.set(
      corner & 1 ? box.max.x : box.min.x,
      corner & 2 ? box.max.y : box.min.y,
      corner & 4 ? box.max.z : box.min.z,
    );
    visit(point);
  }
}

/**
 * The camera zoom for the scene's base view: its vertical field of view spans
 * the largest centered square of the stage. On serve-sim's fixed 1:1 stage this
 * is its stage.height / viewport.height zoom. The Hub's stage fills the stream
 * area instead, so its short side limits the base view, and the physical size
 * never crosses the edges of a stage that is narrower than it is tall.
 */
// @ref LLP 0004#stage-size — the Hub's stage has any aspect ratio; serve-sim's is square
export function duoStageZoom(viewport: DuoViewportSize, stage: DuoViewportSize): number {
  if (!validSize(viewport) || !validSize(stage)) return 1;
  return Math.min(stage.width, stage.height) / viewport.height;
}

/** The camera zoom that shows the base view of this stage scaled by `scale`. */
export function duoCameraZoom(
  viewport: DuoViewportSize,
  stage: DuoViewportSize,
  scale: number,
): number {
  return duoStageZoom(viewport, stage) * scale;
}

export type DuoFit = { scale: number; velocity: number };

/**
 * Move the fill factor toward its target. A new pose springs, so the model
 * eases into its framing. A stage or window resize snaps: the base zoom follows
 * a resize at once, and a factor that lagged behind it would push the model
 * past the stage edge, where the host clips it. This happens when a sidebar
 * narrows a stage whose short side is its height.
 */
// @ref LLP 0004#stage-size — a stage or window resize snaps the fit; only a new pose springs it
export function stepDuoFit(fit: DuoFit, target: number, seconds: number, snap: boolean): DuoFit {
  if (snap) return { scale: target, velocity: 0 };
  const step = stepDuoSpring(fit.scale, fit.velocity, target, seconds);
  return { scale: step.value, velocity: step.velocity };
}

/**
 * Fit the current articulated geometry inside a centered logical stage.
 * The result multiplies the {@link duoStageZoom} base zoom.
 * This uses the scene's centered perspective camera and never changes its
 * zoom or the model's transforms. Mesh bounds are cached by the geometry.
 */
export function duoFitScale(
  model: Object3D,
  camera: PerspectiveCamera,
  viewport: DuoViewportSize,
  stage: DuoViewportSize,
  inset = 24,
): number {
  if (!validSize(viewport) || !validSize(stage) || !(camera.zoom > 0)) return 1;
  model.updateWorldMatrix(true, true);
  camera.updateWorldMatrix(true, false);
  let extentX = 0;
  let extentY = 0;
  let crossesCamera = false;
  const point = new Vector3();
  model.traverseVisible((child) => {
    if (!(child instanceof Mesh)) return;
    const geometry = child.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (!bounds || bounds.isEmpty()) return;
    visitBoxCorners(bounds, point, (corner) => {
      corner.applyMatrix4(child.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      if (corner.z >= -camera.near) {
        crossesCamera = true;
        return;
      }
      corner.applyMatrix4(camera.projectionMatrix);
      extentX = Math.max(extentX, Math.abs(corner.x / camera.zoom));
      extentY = Math.max(extentY, Math.abs(corner.y / camera.zoom));
    });
  });
  if (crossesCamera || !(extentX > 0) || !(extentY > 0)) return 1;
  const padding = Number.isFinite(inset) ? Math.max(0, inset) : 24;
  const availableX = Math.max(1, stage.width - 2 * padding) / viewport.width;
  const availableY = Math.max(1, stage.height - 2 * padding) / viewport.height;
  const zoom = Math.min(availableX / extentX, availableY / extentY);
  const scale = zoom / duoStageZoom(viewport, stage);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Midpoint on the front of the chosen panel's outer edge, in panel-local coordinates. */
export function duoPanelEdgeAnchor(panel: Object3D, side: "left" | "right"): Vector3 | null {
  panel.updateWorldMatrix(true, true);
  const inverse = panel.matrixWorld.clone().invert();
  const relative = new Matrix4();
  const bounds = new Box3();
  const point = new Vector3();
  panel.traverseVisible((child) => {
    if (!(child instanceof Mesh)) return;
    const geometry = child.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box || box.isEmpty()) return;
    relative.multiplyMatrices(inverse, child.matrixWorld);
    visitBoxCorners(box, point, (corner) => bounds.expandByPoint(corner.applyMatrix4(relative)));
  });
  if (bounds.isEmpty()) return null;
  return new Vector3(
    side === "left" ? bounds.min.x : bounds.max.x,
    (bounds.min.y + bounds.max.y) / 2,
    bounds.max.z,
  );
}

/** Project a physical anchor into the same client-coordinate space as pointer events. */
export function duoProjectAnchor(
  anchor: Vector3,
  panel: Object3D,
  camera: PerspectiveCamera,
  canvas: DuoCanvasRect,
): DuoScreenPoint | null {
  if (!validSize(canvas)) return null;
  panel.updateWorldMatrix(true, false);
  camera.updateWorldMatrix(true, false);
  const point = anchor
    .clone()
    .applyMatrix4(panel.matrixWorld)
    .applyMatrix4(camera.matrixWorldInverse);
  if (point.z >= -camera.near) return null;
  point.applyMatrix4(camera.projectionMatrix);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return {
    x: canvas.left + ((point.x + 1) * canvas.width) / 2,
    y: canvas.top + ((1 - point.y) * canvas.height) / 2,
  };
}

/**
 * Map pointer travel from a fixed drag start to either endpoint. The common
 * closed-to-open axis selects the direction; the distance from the starting
 * handle to that endpoint determines the remaining travel. Curved model
 * presentation never changes this mapping underneath an active drag.
 */
export function duoHingeDragAngle(
  startAngle: number,
  startPoint: DuoScreenPoint,
  closedPoint: DuoScreenPoint,
  openPoint: DuoScreenPoint,
  delta: DuoScreenPoint,
): number {
  const start = Number.isFinite(startAngle) ? Math.max(0, Math.min(180, startAngle)) : 90;
  if (
    ![
      startPoint.x,
      startPoint.y,
      closedPoint.x,
      closedPoint.y,
      openPoint.x,
      openPoint.y,
      delta.x,
      delta.y,
    ].every(Number.isFinite)
  ) {
    return start;
  }
  const dx = openPoint.x - closedPoint.x;
  const dy = openPoint.y - closedPoint.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return start;
  const axisX = dx / length;
  const axisY = dy / length;
  const travel = delta.x * axisX + delta.y * axisY;
  if (Math.abs(travel) < 1e-8) return start;
  const opening = travel > 0;
  const endpoint = opening ? openPoint : closedPoint;
  const target = opening ? 180 : 0;
  if (target === start) return start;
  const projectedDistance = Math.abs(
    (endpoint.x - startPoint.x) * axisX + (endpoint.y - startPoint.y) * axisY,
  );
  // A presentation can place the current handle on an endpoint before its
  // hinge reaches it. Use proportional travel in that collapsed interval.
  const distance =
    projectedDistance > 1e-6 ? projectedDistance : (length * Math.abs(target - start)) / 180;
  const progress = Math.min(1, Math.abs(travel) / distance);
  return start + (target - start) * progress;
}
