import { describe, expect, test } from "bun:test";
import {
  MAP_TILE_SIZE,
  RouteProjectionCache,
  WEB_MERCATOR_MAX_LATITUDE,
  nearestWrappedWorldX,
  projectLocation,
  routeViewportTransform,
  simplifyRouteForDisplay,
  unprojectLocation,
  worldSizeAtZoom,
  wrapLongitude,
} from "../src/ui/lib/route-map.ts";

describe("route map numeric boundaries", () => {
  test("validates zoom and computes the Web Mercator world size", () => {
    expect(worldSizeAtZoom(0)).toBe(MAP_TILE_SIZE);
    expect(worldSizeAtZoom(24)).toBe(MAP_TILE_SIZE * 2 ** 24);
    for (const zoom of [-1, 1.5, 25, Number.NaN]) {
      expect(() => worldSizeAtZoom(zoom)).toThrow("zoom must be an integer");
    }
  });

  test("wraps longitudes into the canonical half-open range", () => {
    expect(wrapLongitude(180)).toBe(-180);
    expect(wrapLongitude(540)).toBe(-180);
    expect(wrapLongitude(-181)).toBe(179);
    expect(wrapLongitude(12.5)).toBe(12.5);
    expect(() => wrapLongitude(Number.POSITIVE_INFINITY)).toThrow(
      "longitude must be finite",
    );
  });

  test("projects, clamps, and unprojects finite coordinates", () => {
    const zoom = 8;
    const location = { latitude: 51.5072, longitude: -0.1276 };
    const projected = projectLocation(location, zoom);
    const roundTrip = unprojectLocation(projected, zoom);

    expect(roundTrip.latitude).toBeCloseTo(location.latitude, 8);
    expect(roundTrip.longitude).toBeCloseTo(location.longitude, 8);
    expect(
      unprojectLocation(projectLocation({ latitude: 90, longitude: 0 }, zoom), zoom)
        .latitude,
    ).toBeCloseTo(WEB_MERCATOR_MAX_LATITUDE, 8);
    expect(() => projectLocation({ latitude: Number.NaN, longitude: 0 }, zoom)).toThrow(
      "latitude must be finite",
    );
    expect(() => unprojectLocation({ x: 0, y: Number.NaN }, zoom)).toThrow(
      "projected point coordinates must be finite",
    );
  });

  test("chooses the nearest wrapped world and validates every operand", () => {
    expect(nearestWrappedWorldX(5, 265, 256)).toBe(261);
    for (const args of [
      [Number.NaN, 0, 256],
      [0, Number.POSITIVE_INFINITY, 256],
    ] as const) {
      expect(() => nearestWrappedWorldX(args[0], args[1], args[2])).toThrow(
        "world x coordinates must be finite",
      );
    }
    expect(() => nearestWrappedWorldX(0, 0, Number.NaN)).toThrow(
      "worldSize must be a finite positive number",
    );
  });
});

describe("route display boundary behavior", () => {
  test("handles empty, singleton, and already-minimal routes", () => {
    const empty = simplifyRouteForDisplay([], 3);
    expect(empty).toMatchObject({
      sourcePointCount: 0,
      points: [],
      svgPoints: "",
      anchorX: 0,
      simplified: false,
      capped: false,
      maxErrorPx: 0,
    });

    const singleton = simplifyRouteForDisplay(
      [{ latitude: 0, longitude: 0 }],
      3,
    );
    expect(singleton.points).toHaveLength(1);
    expect(singleton.points[0]!.sourceIndex).toBe(0);

    const pair = simplifyRouteForDisplay(
      [
        { latitude: 0, longitude: 0 },
        { latitude: 1, longitude: 1 },
      ],
      3,
      { pixelTolerance: 0, maxDisplayPoints: 2 },
    );
    expect(pair.points.map((point) => point.sourceIndex)).toEqual([0, 1]);
    expect(pair.capped).toBe(false);
  });

  test("rejects invalid simplification options and projections", () => {
    for (const pixelTolerance of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        simplifyRouteForDisplay([], 0, { pixelTolerance }),
      ).toThrow("pixelTolerance");
    }
    for (const maxDisplayPoints of [0, 1, 2.5, Number.MAX_VALUE]) {
      expect(() =>
        simplifyRouteForDisplay([], 0, { maxDisplayPoints }),
      ).toThrow("maxDisplayPoints");
    }
    expect(() =>
      simplifyRouteForDisplay([{ latitude: 0, longitude: 0 }], 0, {
        project: () => ({ x: Number.NaN, y: 0 }),
      }),
    ).toThrow("non-finite coordinate at index 0");
  });

  test("validates viewport coordinates and dimensions", () => {
    const route = simplifyRouteForDisplay(
      [
        { latitude: 0, longitude: 0 },
        { latitude: 1, longitude: 1 },
      ],
      2,
    );
    expect(routeViewportTransform(route, route.points[0]!, { width: 100, height: 50 })).toEqual({
      translateX: 50 - route.points[0]!.x,
      translateY: 25 - route.points[0]!.y,
    });
    expect(() =>
      routeViewportTransform(route, { x: Number.NaN, y: 0 }, { width: 1, height: 1 }),
    ).toThrow("centerWorld coordinates must be finite");
    expect(() =>
      routeViewportTransform(route, { x: 0, y: 0 }, { width: 0, height: 1 }),
    ).toThrow("viewport width must be a finite positive number");
    expect(() =>
      routeViewportTransform(route, { x: 0, y: 0 }, { width: 1, height: Number.NaN }),
    ).toThrow("viewport height must be a finite positive number");
  });
});

describe("RouteProjectionCache boundaries", () => {
  test("validates capacity and caches option variants independently", () => {
    for (const maxEntries of [0, 1.5, Number.MAX_VALUE]) {
      expect(() => new RouteProjectionCache({ maxEntries })).toThrow(
        "maxEntries must be a positive safe integer",
      );
    }

    const cache = new RouteProjectionCache({ maxEntries: 2 });
    const identity = {};
    const points = [
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 1 },
      { latitude: 0, longitude: 2 },
    ];
    const first = cache.get(identity, points, 4, { pixelTolerance: 0.5 });
    const second = cache.get(identity, points, 4, { pixelTolerance: 1 });

    expect(second).not.toBe(first);
    expect(cache.get(identity, points, 4, { pixelTolerance: 0.5 })).toBe(first);
    cache.get({}, points, 5);
    expect(cache.stats()).toMatchObject({ entries: 2, hits: 1, misses: 3 });
  });
});
