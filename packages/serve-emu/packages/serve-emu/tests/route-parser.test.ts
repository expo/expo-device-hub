import { describe, expect, test } from "bun:test";
import {
  RouteParseError,
  parseRouteText,
  type RouteParseErrorCode,
} from "../src/ui/lib/route-parser.ts";
import {
  RouteParserWorkerController,
  type RouteFileLike,
  type RouteParserWorkerResponse,
} from "../src/ui/lib/route-parser-worker.ts";

async function expectRouteError(promise: Promise<unknown>, code: RouteParseErrorCode): Promise<RouteParseError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RouteParseError);
    expect((error as RouteParseError).code).toBe(code);
    return error as RouteParseError;
  }
  throw new Error(`expected ${code} route error`);
}

describe("parseRouteText", () => {
  test("parses GPX track, route, and waypoint elements in document order", async () => {
    const result = await parseRouteText(
      `<?xml version="1.0"?>
       <gpx xmlns="http://www.topografix.com/GPX/1/1">
         <metadata><name>Morning route</name></metadata>
         <wpt lat="51.5" lon="-0.1"><ele>12.5</ele></wpt>
         <rte><rtept lat="51.6" lon="-0.2" /></rte>
         <trk><trkseg><trkpt lat="51.7" lon="-0.3"><ele><![CDATA[14]]></ele></trkpt></trkseg></trk>
       </gpx>`,
      "route.gpx",
    );

    expect(result.format).toBe("gpx");
    expect(result.points).toEqual([
      { latitude: 51.5, longitude: -0.1, altitude: 12.5 },
      { latitude: 51.6, longitude: -0.2 },
      { latitude: 51.7, longitude: -0.3, altitude: 14 },
    ]);
  });

  test("parses namespaced KML coordinates and gx:coord", async () => {
    const result = await parseRouteText(
      `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
         <Document><Placemark><LineString>
           <coordinates>-0.1,51.5,20 -0.2,51.6</coordinates>
         </LineString></Placemark><gx:Track><gx:coord>-0.3 51.7 22</gx:coord></gx:Track></Document>
       </kml>`,
      "route.kml",
    );

    expect(result.format).toBe("kml");
    expect(result.points).toEqual([
      { latitude: 51.5, longitude: -0.1, altitude: 20 },
      { latitude: 51.6, longitude: -0.2 },
      { latitude: 51.7, longitude: -0.3, altitude: 22 },
    ]);
  });

  test("parses waypoint JSON aliases without truncating the validated sequence", async () => {
    const points = Array.from({ length: 10_000 }, (_, index) => ({
      lat: (index % 1_000) / 10_000,
      lng: (index % 1_000) / 10_000 + 1,
      alt: index,
    }));
    const result = await parseRouteText(JSON.stringify({ waypoints: points }), "route.json", {
      yieldControl: async () => {},
    });

    expect(result.points).toHaveLength(10_000);
    expect(result.points[0]).toEqual({ latitude: 0, longitude: 1, altitude: 0 });
    expect(result.points[9_999]).toEqual({ latitude: 0.0999, longitude: 1.0999, altitude: 9_999 });
  });

  test("accepts a UTF-8 BOM before JSON and GeoJSON", async () => {
    const waypoints = await parseRouteText(
      `\ufeff${JSON.stringify([{ latitude: 1, longitude: 2 }])}`,
      "route.json",
    );
    const geoJson = await parseRouteText(
      `\ufeff${JSON.stringify({
        type: "LineString",
        coordinates: [[3, 4], [5, 6]],
      })}`,
      "route.geojson",
    );

    expect(waypoints.points).toEqual([{ latitude: 1, longitude: 2 }]);
    expect(geoJson.points).toEqual([
      { latitude: 4, longitude: 3 },
      { latitude: 6, longitude: 5 },
    ]);
  });

  test("iteratively traverses nested GeoJSON while preserving coordinate order", async () => {
    const result = await parseRouteText(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "GeometryCollection",
              geometries: [
                { type: "LineString", coordinates: [[-0.1, 51.5], [-0.2, 51.6, 8]] },
                { type: "MultiPoint", coordinates: [[-0.3, 51.7], [-0.4, 51.8]] },
              ],
            },
          },
        ],
      }),
      "route.geojson",
    );

    expect(result.points).toEqual([
      { latitude: 51.5, longitude: -0.1 },
      { latitude: 51.6, longitude: -0.2, altitude: 8 },
      { latitude: 51.7, longitude: -0.3 },
      { latitude: 51.8, longitude: -0.4 },
    ]);
  });

  test("enforces the waypoint limit before adding an excess point", async () => {
    const progress: number[] = [];
    const error = await expectRouteError(
      parseRouteText(
        JSON.stringify([
          { latitude: 1, longitude: 2 },
          { latitude: 3, longitude: 4 },
          { latitude: 5, longitude: 6 },
        ]),
        "route.json",
        {
          limits: { maxWaypoints: 2 },
          yieldEvery: 1,
          yieldControl: async () => {},
          onProgress: ({ waypoints }) => progress.push(waypoints),
        },
      ),
      "waypoint-limit",
    );

    expect(error.message).toContain("2 waypoint");
    expect(Math.max(...progress)).toBe(2);
  });

  test("rejects excessive complexity before scheduling a wide traversal", async () => {
    const features = Array.from({ length: 20 }, () => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
    }));
    await expectRouteError(
      parseRouteText(JSON.stringify({ type: "FeatureCollection", features }), "route.geojson", {
        limits: { maxComplexity: 10 },
      }),
      "complexity-limit",
    );
  });

  test("rejects deeply nested coordinates without recursive traversal", async () => {
    let coordinates: unknown = [1, 2];
    for (let index = 0; index < 20; index += 1) coordinates = [coordinates];
    await expectRouteError(
      parseRouteText(JSON.stringify({ type: "LineString", coordinates }), "route.geojson", {
        limits: { maxDepth: 8 },
      }),
      "depth-limit",
    );
  });

  test("enforces XML depth and complexity during token traversal", async () => {
    await expectRouteError(
      parseRouteText(
        `<gpx><a><b><c><wpt lat="1" lon="2" /></c></b></a></gpx>`,
        "route.gpx",
        { limits: { maxDepth: 3 } },
      ),
      "depth-limit",
    );
    await expectRouteError(
      parseRouteText(
        `<gpx>${"<metadata />".repeat(10)}<wpt lat="1" lon="2" /></gpx>`,
        "route.gpx",
        { limits: { maxComplexity: 5 } },
      ),
      "complexity-limit",
    );
  });

  test("cooperatively cancels traversal at a yield checkpoint", async () => {
    const abortController = new AbortController();
    let yields = 0;
    await expectRouteError(
      parseRouteText(
        JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ latitude: 1, longitude: index / 10 }))),
        "route.json",
        {
          signal: abortController.signal,
          yieldEvery: 1,
          yieldControl: async () => {
            yields += 1;
            if (yields === 3) abortController.abort();
          },
        },
      ),
      "cancelled",
    );
    expect(yields).toBe(3);
  });

  test("rejects XML entity expansion and malformed XML", async () => {
    await expectRouteError(
      parseRouteText(
        `<!DOCTYPE gpx [<!ENTITY x "1">]><gpx><wpt lat="&x;" lon="2" /></gpx>`,
        "route.gpx",
      ),
      "dangerous-xml",
    );
    await expectRouteError(
      parseRouteText(`<gpx><trk><trkpt lat="1" lon="2"></trk></trkpt></gpx>`, "route.gpx"),
      "invalid-xml",
    );
  });

  test("rejects invalid points rather than silently dropping them", async () => {
    await expectRouteError(
      parseRouteText(
        JSON.stringify([{ latitude: 1, longitude: 2 }, { latitude: 100, longitude: 3 }]),
        "route.json",
      ),
      "invalid-route",
    );
  });

  test("matches the playback API altitude bounds", async () => {
    const accepted = await parseRouteText(
      JSON.stringify([
        { latitude: 1, longitude: 2, altitude: -1_000 },
        { latitude: 3, longitude: 4, altitude: 100_000 },
      ]),
      "route.json",
    );
    expect(accepted.points.map((point) => point.altitude)).toEqual([
      -1_000,
      100_000,
    ]);

    for (const altitude of [-1_001, 100_001]) {
      await expectRouteError(
        parseRouteText(
          JSON.stringify([{ latitude: 1, longitude: 2, altitude }]),
          "route.json",
        ),
        "invalid-route",
      );
    }
  });
});

describe("RouteParserWorkerController", () => {
  test("rejects an oversized file before reading it", async () => {
    let reads = 0;
    const responses: RouteParserWorkerResponse[] = [];
    const file: RouteFileLike = {
      name: "large.gpx",
      size: 101,
      text: async () => {
        reads += 1;
        return "<gpx />";
      },
    };
    const controller = new RouteParserWorkerController((response) => responses.push(response));

    await controller.handle({ type: "parse", requestId: 1, file, maxFileBytes: 100 });

    expect(reads).toBe(0);
    expect(responses.map(({ type }) => type)).toEqual(["accepted", "error"]);
    expect(responses.at(-1)).toMatchObject({
      type: "error",
      requestId: 1,
      error: { code: "file-too-large" },
    });
  });

  test("allows a file exactly at the configured byte limit", async () => {
    const responses: RouteParserWorkerResponse[] = [];
    const text = JSON.stringify([{ latitude: 1, longitude: 2 }]).padEnd(
      100,
      " ",
    );
    let reads = 0;
    const controller = new RouteParserWorkerController((response) => {
      responses.push(response);
    });

    await controller.handle({
      type: "parse",
      requestId: "boundary",
      file: {
        name: "boundary.json",
        size: new TextEncoder().encode(text).byteLength,
        text: async () => {
          reads += 1;
          return text;
        },
      },
      maxFileBytes: 100,
    });

    expect(reads).toBe(1);
    expect(
      responses.some(
        (response) =>
          response.type === "result" && response.requestId === "boundary",
      ),
    ).toBe(true);
  });

  test("posts structured progress and the full validated result", async () => {
    const responses: RouteParserWorkerResponse[] = [];
    const text = JSON.stringify([
      { latitude: 1, longitude: 2 },
      { latitude: 3, longitude: 4 },
      { latitude: 5, longitude: 6 },
    ]);
    const controller = new RouteParserWorkerController((response) => responses.push(response));

    await controller.handle({
      type: "parse",
      requestId: "route-1",
      file: { name: "route.json", size: new TextEncoder().encode(text).byteLength, text: async () => text },
    });

    expect(responses.some((response) => response.type === "progress" && response.stage === "reading")).toBe(true);
    expect(responses.some((response) => response.type === "progress" && response.stage === "parsing")).toBe(true);
    const result = responses.find((response) => response.type === "result");
    expect(result).toMatchObject({ type: "result", requestId: "route-1" });
    expect(result?.type === "result" ? result.result.points : []).toHaveLength(3);
  });

  test("supersedes an in-flight read and suppresses its stale result", async () => {
    const responses: RouteParserWorkerResponse[] = [];
    let finishFirst!: (text: string) => void;
    const firstText = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    const controller = new RouteParserWorkerController((response) => responses.push(response));
    const first = controller.handle({
      type: "parse",
      requestId: 1,
      file: { name: "old.json", size: 32, text: () => firstText },
    });
    await Promise.resolve();

    await controller.handle({
      type: "parse",
      requestId: 2,
      file: {
        name: "new.json",
        size: 32,
        text: async () => JSON.stringify([{ latitude: 3, longitude: 4 }]),
      },
    });
    finishFirst(JSON.stringify([{ latitude: 1, longitude: 2 }]));
    await first;

    expect(responses).toContainEqual({ type: "cancelled", requestId: 1, reason: "superseded" });
    expect(responses.some((response) => response.type === "result" && response.requestId === 1)).toBe(false);
    expect(responses.some((response) => response.type === "result" && response.requestId === 2)).toBe(true);
  });

  test("explicit cancellation posts once and suppresses completion", async () => {
    const responses: RouteParserWorkerResponse[] = [];
    let finishRead!: (text: string) => void;
    const pendingText = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const controller = new RouteParserWorkerController((response) => responses.push(response));
    const parse = controller.handle({
      type: "parse",
      requestId: "cancel-me",
      file: { name: "route.json", size: 32, text: () => pendingText },
    });
    await Promise.resolve();

    await controller.handle({ type: "cancel", requestId: "cancel-me" });
    finishRead(JSON.stringify([{ latitude: 1, longitude: 2 }]));
    await parse;

    expect(responses.filter((response) => response.type === "cancelled")).toEqual([
      { type: "cancelled", requestId: "cancel-me", reason: "cancelled" },
    ]);
    expect(responses.some((response) => response.type === "result")).toBe(false);
  });
});
