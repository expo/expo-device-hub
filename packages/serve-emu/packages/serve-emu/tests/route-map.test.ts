import { describe, expect, test } from "bun:test";
import {
  RouteProjectionCache,
  nearestWrappedWorldX,
  projectLocation,
  routeViewportTransform,
  simplifyRouteForDisplay,
  worldSizeAtZoom,
  type LocationPoint,
  type ProjectedDisplayRoute,
  type WorldPoint,
} from "../src/ui/lib/route-map.ts";

function pointToSegmentDistance(point: WorldPoint, start: WorldPoint, end: WorldPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.min(
    1,
    Math.max(
      0,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

function projectContinuous(points: readonly LocationPoint[], zoom: number): WorldPoint[] {
  const size = worldSizeAtZoom(zoom);
  let previousX: number | undefined;
  return points.map((point) => {
    const projected = projectLocation(point, zoom);
    const x =
      previousX === undefined
        ? projected.x
        : projected.x + Math.round((previousX - projected.x) / size) * size;
    previousX = x;
    return { x, y: projected.y };
  });
}

function maximumDisplayError(
  source: readonly WorldPoint[],
  display: ProjectedDisplayRoute,
): number {
  let maximum = 0;
  for (let displayIndex = 1; displayIndex < display.points.length; displayIndex += 1) {
    const start = display.points[displayIndex - 1]!;
    const end = display.points[displayIndex]!;
    for (let sourceIndex = start.sourceIndex + 1; sourceIndex < end.sourceIndex; sourceIndex += 1) {
      maximum = Math.max(maximum, pointToSegmentDistance(source[sourceIndex]!, start, end));
    }
  }
  return maximum;
}

function smoothRoute(count: number): LocationPoint[] {
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    return {
      latitude: 30 + Math.sin(progress * Math.PI * 20) * 0.03,
      longitude: -20 + progress * 40,
    };
  });
}

describe("screen-space route simplification", () => {
  test("a 10,000-point route is display-capped without mutating the playback sequence", () => {
    const points = Array.from({ length: 10_000 }, (_, index) => ({
      latitude: index % 2 === 0 ? -1 : 1,
      longitude: -10 + (index / 9_999) * 20,
      altitude: index,
    }));
    const references = points.slice();

    const display = simplifyRouteForDisplay(points, 12, {
      pixelTolerance: 0.1,
      maxDisplayPoints: 128,
    });

    expect(display.sourcePointCount).toBe(10_000);
    expect(display.points).toHaveLength(128);
    expect(display.points[0]!.sourceIndex).toBe(0);
    expect(display.points.at(-1)!.sourceIndex).toBe(9_999);
    expect(display.simplified).toBe(true);
    expect(display.capped).toBe(true);
    expect(points).toHaveLength(10_000);
    expect(points.every((point, index) => point === references[index])).toBe(true);
    expect(points[5_000]!.altitude).toBe(5_000);
  });

  test("keeps the requested pixel error bound at several zoom levels", () => {
    const points = smoothRoute(2_001);
    const counts: number[] = [];

    for (const zoom of [4, 8, 12]) {
      const display = simplifyRouteForDisplay(points, zoom, {
        pixelTolerance: 0.75,
        maxDisplayPoints: points.length,
      });
      const measuredError = maximumDisplayError(projectContinuous(points, zoom), display);
      expect(measuredError).toBeLessThanOrEqual(0.750_000_001);
      expect(Math.abs(measuredError - display.maxErrorPx)).toBeLessThan(1e-8);
      expect(display.capped).toBe(false);
      counts.push(display.points.length);
    }

    expect(counts[0]!).toBeLessThan(counts[1]!);
    expect(counts[1]!).toBeLessThan(counts[2]!);
  });

  test("the hard cap reports the actual remaining error", () => {
    const points = smoothRoute(2_001);
    const display = simplifyRouteForDisplay(points, 12, {
      pixelTolerance: 0.01,
      maxDisplayPoints: 16,
    });
    const measuredError = maximumDisplayError(projectContinuous(points, 12), display);

    expect(display.points).toHaveLength(16);
    expect(display.capped).toBe(true);
    expect(display.maxErrorPx).toBeGreaterThan(display.requestedTolerancePx);
    expect(Math.abs(measuredError - display.maxErrorPx)).toBeLessThan(1e-8);
  });

  test("keeps coordinates finite and capped at the UI maximum zoom", () => {
    const points = smoothRoute(10_000);
    const display = simplifyRouteForDisplay(points, 18);
    const center = projectLocation(points[5_000]!, 18);
    const transform = routeViewportTransform(display, center, {
      width: 320,
      height: 220,
    });

    expect(display.points.length).toBeLessThanOrEqual(1_024);
    expect(
      display.points.every(
        (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
      ),
    ).toBe(true);
    expect(Number.isFinite(transform.translateX)).toBe(true);
    expect(Number.isFinite(transform.translateY)).toBe(true);
  });
});

describe("antimeridian-safe route projection", () => {
  test("uses the short world copy on both sides of the antimeridian", () => {
    const display = simplifyRouteForDisplay(
      [
        { latitude: 0, longitude: 179 },
        { latitude: 0.2, longitude: 179.8 },
        { latitude: -0.1, longitude: -179.8 },
        { latitude: 0, longitude: -179 },
      ],
      3,
      { pixelTolerance: 0, maxDisplayPoints: 10 },
    );
    const xs = display.points.map((point) => point.x);

    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(12);
    for (let index = 1; index < xs.length; index += 1) {
      expect(Math.abs(xs[index]! - xs[index - 1]!)).toBeLessThan(6);
    }

    for (const longitude of [179.5, -179.5]) {
      const center = projectLocation({ latitude: 0, longitude }, 3);
      const transform = routeViewportTransform(display, center, { width: 320, height: 220 });
      const viewportXs = xs.map((x) => x + transform.translateX);
      expect(Math.min(...viewportXs)).toBeGreaterThan(140);
      expect(Math.max(...viewportXs)).toBeLessThan(180);
    }
  });

  test("places a wrapped marker in the nearest world copy", () => {
    const zoom = 3;
    const worldSize = worldSizeAtZoom(zoom);
    const eastCenter = projectLocation({ latitude: 0, longitude: 179.8 }, zoom);
    const westMarker = projectLocation({ latitude: 0, longitude: -179.8 }, zoom);
    const markerX = nearestWrappedWorldX(
      westMarker.x,
      eastCenter.x,
      worldSize,
    );

    expect(Math.abs(markerX - eastCenter.x)).toBeLessThan(3);
    expect(() => nearestWrappedWorldX(0, 0, 0)).toThrow("worldSize");
  });
});

describe("RouteProjectionCache", () => {
  test("projects source points once per route identity and zoom while pan only translates", () => {
    const points = smoothRoute(10_000);
    let projectionCalls = 0;
    const cache = new RouteProjectionCache({
      maxEntries: 3,
      project(point, zoom) {
        projectionCalls += 1;
        return projectLocation(point, zoom);
      },
    });

    const first = cache.get(points, points, 10, { pixelTolerance: 1, maxDisplayPoints: 256 });
    expect(projectionCalls).toBe(10_000);
    const cached = cache.get(points, points, 10, { pixelTolerance: 1, maxDisplayPoints: 256 });
    expect(cached).toBe(first);
    expect(projectionCalls).toBe(10_000);

    for (let index = 0; index < 100; index += 1) {
      routeViewportTransform(
        first,
        projectLocation({ latitude: 30, longitude: -5 + index / 10 }, 10),
        { width: 320, height: 220 },
      );
    }
    expect(projectionCalls).toBe(10_000);

    const zoomed = cache.get(points, points, 11, { pixelTolerance: 1, maxDisplayPoints: 256 });
    expect(zoomed).not.toBe(first);
    expect(projectionCalls).toBe(20_000);
    expect(cache.stats()).toEqual({
      entries: 2,
      hits: 1,
      misses: 2,
      projectedSourcePoints: 20_000,
    });
  });

  test("bounds cached projections and supports explicit route invalidation", () => {
    const cache = new RouteProjectionCache({ maxEntries: 2 });
    const firstIdentity = {};
    const secondIdentity = {};
    const thirdIdentity = {};
    const points = smoothRoute(100);

    cache.get(firstIdentity, points, 8);
    cache.get(secondIdentity, points, 8);
    cache.get(firstIdentity, points, 8);
    cache.get(thirdIdentity, points, 8);
    expect(cache.stats().entries).toBe(2);
    expect(cache.delete(firstIdentity)).toBe(true);
    expect(cache.delete(firstIdentity)).toBe(false);
    expect(cache.stats().entries).toBe(1);
    cache.clear();
    expect(cache.stats().entries).toBe(0);
  });
});
