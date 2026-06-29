import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { useApi } from "../lib/device";

type Point = { x: number; y: number };
type LocationPoint = { latitude: number; longitude: number; altitude?: number };
type Tile = { key: string; x: number; y: number; left: number; top: number; wrappedX: number };
type RouteSnapshot = {
  status: "idle" | "running" | "paused" | "completed" | "error";
  waypointCount: number;
  totalMeters: number;
  progressMeters: number;
  speedKph: number;
  multiplier: number;
  loop: boolean;
  lastError: string | null;
  currentLocation: (LocationPoint & { appliedAt: string }) | null;
};

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
const DEFAULT_LOCATION: LocationPoint = { latitude: 37.5665, longitude: 126.978 };
const DEFAULT_SIZE = { width: 320, height: 220 };

const PRESETS: (LocationPoint & { label: string })[] = [
  { label: "Seoul", latitude: 37.5665, longitude: 126.978 },
  { label: "London", latitude: 51.5072, longitude: -0.1276 },
  { label: "SF", latitude: 37.7749, longitude: -122.4194 },
];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function wrapLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

function project(location: LocationPoint, zoom: number): Point {
  const sin = Math.sin((clamp(location.latitude, -85.05112878, 85.05112878) * Math.PI) / 180);
  const size = worldSize(zoom);
  return {
    x: ((wrapLongitude(location.longitude) + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

function unproject(point: Point, zoom: number): LocationPoint {
  const size = worldSize(zoom);
  const lng = (point.x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * point.y) / size;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return {
    latitude: clamp(lat, -85.05112878, 85.05112878),
    longitude: wrapLongitude(lng),
  };
}

function formatCoord(n: number): string {
  return n.toFixed(6);
}

function normalizedTileX(x: number, zoom: number): number {
  const count = 2 ** zoom;
  return ((x % count) + count) % count;
}

function tileUrl(tile: Tile, zoom: number): string {
  return `https://tile.openstreetmap.org/${zoom}/${tile.wrappedX}/${tile.y}.png`;
}

function waypointFromRecord(value: unknown): LocationPoint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const latitude = Number(record.latitude ?? record.lat);
  const longitude = Number(record.longitude ?? record.lng ?? record.lon);
  const altitudeRaw = record.altitude ?? record.alt ?? record.ele;
  const altitude = altitudeRaw === undefined || altitudeRaw === null ? undefined : Number(altitudeRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  if (altitude !== undefined && !Number.isFinite(altitude)) return null;
  return {
    latitude,
    longitude,
    ...(altitude === undefined ? {} : { altitude }),
  };
}

function waypointsFromCoordinates(coordinates: unknown): LocationPoint[] {
  if (!Array.isArray(coordinates)) return [];
  if (coordinates.length >= 2 && typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    const longitude = coordinates[0];
    const latitude = coordinates[1];
    const altitude = typeof coordinates[2] === "number" ? coordinates[2] : undefined;
    return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? [{ latitude, longitude, ...(altitude === undefined ? {} : { altitude }) }]
      : [];
  }
  return coordinates.flatMap(waypointsFromCoordinates);
}

function waypointsFromGeoJson(value: unknown): LocationPoint[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (record.type === "FeatureCollection" && Array.isArray(record.features)) {
    return record.features.flatMap(waypointsFromGeoJson);
  }
  if (record.type === "Feature") return waypointsFromGeoJson(record.geometry);
  if (record.coordinates) return waypointsFromCoordinates(record.coordinates);
  return [];
}

function parseJsonWaypoints(text: string): LocationPoint[] {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    const fromArray = parsed.map(waypointFromRecord).filter((p): p is LocationPoint => Boolean(p));
    if (fromArray.length > 0) return fromArray;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const waypoints = (parsed as Record<string, unknown>).waypoints;
    if (Array.isArray(waypoints)) {
      const fromWaypoints = waypoints.map(waypointFromRecord).filter((p): p is LocationPoint => Boolean(p));
      if (fromWaypoints.length > 0) return fromWaypoints;
    }
  }
  const fromGeoJson = waypointsFromGeoJson(parsed);
  if (fromGeoJson.length > 0) return fromGeoJson;
  throw new Error("JSON must be a waypoint array or GeoJSON route");
}

function parseXmlWaypoints(text: string, kind: "gpx" | "kml"): LocationPoint[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`${kind.toUpperCase()} parse failed`);
  if (kind === "gpx") {
    const nodes = Array.from(doc.querySelectorAll("trkpt, rtept, wpt"));
    return nodes.flatMap((node) => {
      const latitude = Number(node.getAttribute("lat"));
      const longitude = Number(node.getAttribute("lon"));
      const ele = node.querySelector("ele")?.textContent;
      const altitude = ele ? Number(ele) : undefined;
      return waypointFromRecord({ latitude, longitude, altitude }) ?? [];
    });
  }
  return Array.from(doc.querySelectorAll("coordinates")).flatMap((node) =>
    (node.textContent ?? "")
      .trim()
      .split(/\s+/)
      .flatMap((tuple) => {
        const [longitude, latitude, altitude] = tuple.split(",").map(Number);
        return waypointFromRecord({ latitude, longitude, altitude }) ?? [];
      }),
  );
}

function parseRouteText(text: string, fileName: string): LocationPoint[] {
  const lower = fileName.toLowerCase();
  const trimmed = text.trim();
  if (lower.endsWith(".gpx") || (trimmed.startsWith("<") && trimmed.includes("<gpx"))) {
    return parseXmlWaypoints(text, "gpx");
  }
  if (lower.endsWith(".kml") || (trimmed.startsWith("<") && trimmed.includes("<kml"))) {
    return parseXmlWaypoints(text, "kml");
  }
  return parseJsonWaypoints(text);
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export function LocationPanel() {
  const mapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ start: Point; center: Point; moved: boolean } | null>(null);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [zoom, setZoom] = useState(12);
  const [center, setCenter] = useState<LocationPoint>(DEFAULT_LOCATION);
  const [draft, setDraft] = useState<LocationPoint>(DEFAULT_LOCATION);
  const [latText, setLatText] = useState(formatCoord(DEFAULT_LOCATION.latitude));
  const [lngText, setLngText] = useState(formatCoord(DEFAULT_LOCATION.longitude));
  const [status, setStatus] = useState("Ready");
  const [routePoints, setRoutePoints] = useState<LocationPoint[]>([]);
  const [routeStatus, setRouteStatus] = useState<RouteSnapshot | null>(null);
  const [speedKph, setSpeedKph] = useState("30");
  const [multiplier, setMultiplier] = useState("1");
  const [loop, setLoop] = useState(false);
  const api = useApi();

  const syncDraft = useCallback((next: LocationPoint, recenter = false) => {
    const normalized = {
      latitude: clamp(next.latitude, -85.05112878, 85.05112878),
      longitude: wrapLongitude(next.longitude),
    };
    setDraft(normalized);
    setLatText(formatCoord(normalized.latitude));
    setLngText(formatCoord(normalized.longitude));
    if (recenter) setCenter(normalized);
  }, []);

  useEffect(() => {
    const node = mapRef.current;
    if (!node) return;
    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    api
      .fetch("/api/location")
      .then((r) => r.json())
      .then((data: { location?: LocationPoint | null }) => {
        if (data.location) syncDraft(data.location, true);
      })
      .catch(() => {});
  }, [syncDraft, api]);

  useEffect(() => {
    let cancelled = false;
    const syncRoute = () => {
      api
        .fetch("/api/route")
        .then((r) => r.json() as Promise<RouteSnapshot>)
        .then((route) => {
          if (cancelled) return;
          setRouteStatus(route);
          if (route.currentLocation) syncDraft(route.currentLocation, route.status === "running");
          if (route.lastError) setStatus(route.lastError);
        })
        .catch(() => {});
    };
    syncRoute();
    const timer = setInterval(syncRoute, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [syncDraft, api]);

  const centerPixel = useMemo(() => project(center, zoom), [center, zoom]);
  const draftPixel = useMemo(() => project(draft, zoom), [draft, zoom]);

  const tiles = useMemo<Tile[]>(() => {
    const maxTile = 2 ** zoom - 1;
    const leftWorld = centerPixel.x - size.width / 2;
    const topWorld = centerPixel.y - size.height / 2;
    const startX = Math.floor(leftWorld / TILE_SIZE);
    const endX = Math.floor((leftWorld + size.width) / TILE_SIZE);
    const startY = clamp(Math.floor(topWorld / TILE_SIZE), 0, maxTile);
    const endY = clamp(Math.floor((topWorld + size.height) / TILE_SIZE), 0, maxTile);
    const out: Tile[] = [];
    for (let y = startY; y <= endY; y++) {
      for (let x = startX; x <= endX; x++) {
        out.push({
          key: `${zoom}-${x}-${y}`,
          x,
          y,
          wrappedX: normalizedTileX(x, zoom),
          left: x * TILE_SIZE - leftWorld,
          top: y * TILE_SIZE - topWorld,
        });
      }
    }
    return out;
  }, [centerPixel, size.height, size.width, zoom]);

  const locationFromClient = (clientX: number, clientY: number): LocationPoint | null => {
    const node = mapRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return unproject(
      {
        x: centerPixel.x + clientX - rect.left - rect.width / 2,
        y: centerPixel.y + clientY - rect.top - rect.height / 2,
      },
      zoom,
    );
  };

  const markerLeft = draftPixel.x - centerPixel.x + size.width / 2;
  const markerTop = draftPixel.y - centerPixel.y + size.height / 2;
  const routePolyline = useMemo(
    () =>
      routePoints
        .map((point) => {
          const p = project(point, zoom);
          return `${p.x - centerPixel.x + size.width / 2},${p.y - centerPixel.y + size.height / 2}`;
        })
        .join(" "),
    [centerPixel.x, centerPixel.y, routePoints, size.height, size.width, zoom],
  );
  const progress =
    routeStatus && routeStatus.totalMeters > 0
      ? Math.min(100, Math.round((routeStatus.progressMeters / routeStatus.totalMeters) * 100))
      : 0;

  const applyLocation = async (location = draft) => {
    setStatus("Setting...");
    try {
      const res = await api.fetch("/api/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: location.latitude,
          longitude: location.longitude,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "location update failed");
      setStatus(`Applied ${formatCoord(location.latitude)}, ${formatCoord(location.longitude)}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const applyText = () => {
    const latitude = Number(latText);
    const longitude = Number(lngText);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setStatus("Coordinates must be numbers");
      return;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      setStatus("Coordinates are out of range");
      return;
    }
    const next = { latitude, longitude };
    syncDraft(next, true);
    void applyLocation(next);
  };

  const readRouteFile = async (file: File) => {
    setStatus("Loading route...");
    try {
      const points = parseRouteText(await file.text(), file.name);
      if (points.length < 1) throw new Error("route file has no waypoints");
      setRoutePoints(points.slice(0, 10_000));
      syncDraft(points[0], true);
      setStatus(`Loaded ${points.length} waypoints`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const startRoute = async () => {
    if (routePoints.length < 1) {
      setStatus("Load a route first");
      return;
    }
    const speed = Number(speedKph);
    const rate = Number(multiplier);
    if (!Number.isFinite(speed) || speed <= 0) {
      setStatus("Speed must be positive");
      return;
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      setStatus("Rate must be positive");
      return;
    }
    setStatus("Starting route...");
    try {
      const res = await api.fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waypoints: routePoints,
          speedKph: speed,
          multiplier: rate,
          intervalMs: 1000,
          loop,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; route?: RouteSnapshot };
      if (!res.ok || !data.ok || !data.route) throw new Error(data.error || "route start failed");
      setRouteStatus(data.route);
      setStatus("Route running");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const controlRoute = async (action: "pause" | "resume" | "stop") => {
    try {
      const res = await api.fetch("/api/route/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; route?: RouteSnapshot };
      if (!res.ok || !data.ok || !data.route) throw new Error(data.error || "route control failed");
      setRouteStatus(data.route);
      setStatus(action === "stop" ? "Route stopped" : `Route ${data.route.status}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    mapRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = {
      start: { x: e.clientX, y: e.clientY },
      center: centerPixel,
      moved: false,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.start.x;
    const dy = e.clientY - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    setCenter(unproject({ x: drag.center.x - dx, y: drag.center.y - dy }, zoom));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      mapRef.current?.releasePointerCapture(e.pointerId);
    } catch {}
    if (drag?.moved) return;
    const next = locationFromClient(e.clientX, e.clientY);
    if (next) syncDraft(next);
  };

  return (
    <aside className="location-panel">
      <div className="panel-heading">
        <h2>Location</h2>
        <div className="location-status">{status}</div>
      </div>
      <div
        className="map"
        ref={mapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        {tiles.map((tile) => (
          <img
            alt=""
            className="map-tile"
            draggable={false}
            key={tile.key}
            src={tileUrl(tile, zoom)}
            style={{
              left: tile.left,
              top: tile.top,
            }}
          />
        ))}
        {routePolyline && (
          <svg className="route-overlay" viewBox={`0 0 ${size.width} ${size.height}`}>
            <polyline points={routePolyline} />
          </svg>
        )}
        <div
          className="map-marker"
          style={{
            transform: `translate(${markerLeft}px, ${markerTop}px)`,
          }}
        />
        <div className="map-attribution">© OpenStreetMap</div>
      </div>
      <div className="map-controls">
        <button onClick={() => setZoom((z) => clamp(z + 1, MIN_ZOOM, MAX_ZOOM))}>+</button>
        <button onClick={() => setZoom((z) => clamp(z - 1, MIN_ZOOM, MAX_ZOOM))}>-</button>
        <button onClick={() => setCenter(draft)}>Center</button>
      </div>
      <div className="coordinate-grid">
        <label>
          Lat
          <input
            inputMode="decimal"
            onChange={(e) => setLatText(e.currentTarget.value)}
            value={latText}
          />
        </label>
        <label>
          Lng
          <input
            inputMode="decimal"
            onChange={(e) => setLngText(e.currentTarget.value)}
            value={lngText}
          />
        </label>
      </div>
      <div className="preset-row">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              syncDraft(preset, true);
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <button className="primary-action" onClick={applyText}>
        Set Location
      </button>
      <section className="route-panel">
        <div className="panel-heading">
          <h2>Route</h2>
          <div className="location-status">{routeStatus?.status ?? "idle"} {progress}%</div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".gpx,.geojson,.json,.kml,application/json,application/geo+json"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void readRouteFile(file);
          }}
        />
        <div className="route-meta">
          {routePoints.length} pts
          {routeStatus ? ` • ${formatDistance(routeStatus.progressMeters)} / ${formatDistance(routeStatus.totalMeters)}` : ""}
        </div>
        <div className="coordinate-grid">
          <label>
            km/h
            <input
              inputMode="decimal"
              onChange={(e) => setSpeedKph(e.currentTarget.value)}
              value={speedKph}
            />
          </label>
          <label>
            Rate
            <input
              inputMode="decimal"
              onChange={(e) => setMultiplier(e.currentTarget.value)}
              value={multiplier}
            />
          </label>
        </div>
        <label className="toggle-row">
          <input
            checked={loop}
            onChange={(e) => setLoop(e.currentTarget.checked)}
            type="checkbox"
          />
          Loop
        </label>
        <div className="route-actions">
          <button onClick={startRoute}>Play</button>
          <button
            onClick={() => {
              void controlRoute(routeStatus?.status === "paused" ? "resume" : "pause");
            }}
          >
            {routeStatus?.status === "paused" ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => {
              void controlRoute("stop");
            }}
          >
            Stop
          </button>
        </div>
      </section>
    </aside>
  );
}
