import type { GeoFix } from "./location.ts";

export type RouteWaypoint = GeoFix;

export type RoutePlaybackRequest = {
  waypoints: RouteWaypoint[];
  speedKph?: number;
  multiplier?: number;
  intervalMs?: number;
  loop?: boolean;
};

export type RoutePlaybackStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "error";

export type RoutePlaybackSnapshot = {
  status: RoutePlaybackStatus;
  waypointCount: number;
  totalMeters: number;
  progressMeters: number;
  speedKph: number;
  multiplier: number;
  intervalMs: number;
  loop: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  currentLocation: (GeoFix & { appliedAt: string }) | null;
};

type RoutePlaybackOpts = {
  applyLocation: (fix: GeoFix) => void | Promise<void>;
  onLocation: (fix: GeoFix & { appliedAt: string }) => void;
};

type PreparedRoute = {
  waypoints: RouteWaypoint[];
  cumulativeMeters: number[];
  totalMeters: number;
};

const EARTH_RADIUS_METERS = 6_371_000;
const DEFAULT_SPEED_KPH = 30;
const DEFAULT_INTERVAL_MS = 1000;
const MAX_WAYPOINTS = 10_000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60_000;

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return finiteNumber(value, name);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function degrees(radiansValue: number): number {
  return (radiansValue * 180) / Math.PI;
}

function distanceMeters(a: RouteWaypoint, b: RouteWaypoint): number {
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const dLat = lat2 - lat1;
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function interpolate(a: RouteWaypoint, b: RouteWaypoint, t: number): GeoFix {
  const lat1 = radians(a.latitude);
  const lon1 = radians(a.longitude);
  const lat2 = radians(b.latitude);
  const lon2 = radians(b.longitude);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
  ));

  if (d === 0) return { ...a };

  const aa = Math.sin((1 - t) * d) / Math.sin(d);
  const bb = Math.sin(t * d) / Math.sin(d);
  const x = aa * Math.cos(lat1) * Math.cos(lon1) + bb * Math.cos(lat2) * Math.cos(lon2);
  const y = aa * Math.cos(lat1) * Math.sin(lon1) + bb * Math.cos(lat2) * Math.sin(lon2);
  const z = aa * Math.sin(lat1) + bb * Math.sin(lat2);
  const lat = Math.atan2(z, Math.sqrt(x ** 2 + y ** 2));
  const lon = Math.atan2(y, x);
  const altitude =
    a.altitude === undefined && b.altitude === undefined
      ? undefined
      : (a.altitude ?? 0) + ((b.altitude ?? a.altitude ?? 0) - (a.altitude ?? 0)) * t;

  return {
    latitude: degrees(lat),
    longitude: degrees(lon),
    ...(altitude === undefined ? {} : { altitude }),
    velocity: a.velocity ?? b.velocity,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWaypoint(value: unknown, index: number): RouteWaypoint {
  if (!isRecord(value)) throw new Error(`waypoint ${index + 1} must be an object`);
  const latitude = finiteNumber(value.latitude ?? value.lat, `waypoint ${index + 1} latitude`);
  const longitude = finiteNumber(
    value.longitude ?? value.lng ?? value.lon,
    `waypoint ${index + 1} longitude`,
  );
  const altitude = optionalNumber(value.altitude ?? value.alt ?? value.ele, `waypoint ${index + 1} altitude`);

  if (latitude < -90 || latitude > 90) {
    throw new Error(`waypoint ${index + 1} latitude must be between -90 and 90`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new Error(`waypoint ${index + 1} longitude must be between -180 and 180`);
  }
  if (altitude !== undefined && (altitude < -1000 || altitude > 100000)) {
    throw new Error(`waypoint ${index + 1} altitude must be between -1000 and 100000`);
  }

  return { latitude, longitude, ...(altitude === undefined ? {} : { altitude }) };
}

function prepareRoute(waypoints: RouteWaypoint[]): PreparedRoute {
  const cumulativeMeters = [0];
  let totalMeters = 0;
  for (let i = 1; i < waypoints.length; i++) {
    totalMeters += distanceMeters(waypoints[i - 1], waypoints[i]);
    cumulativeMeters.push(totalMeters);
  }
  return { waypoints, cumulativeMeters, totalMeters };
}

function segmentForProgress(cumulativeMeters: number[], progress: number): number {
  let low = 1;
  let high = cumulativeMeters.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (cumulativeMeters[mid] >= progress) high = mid;
    else low = mid + 1;
  }
  return low;
}

function locationAt(route: PreparedRoute, progressMeters: number): GeoFix {
  if (route.waypoints.length === 1 || route.totalMeters === 0) return route.waypoints[0];
  const progress = clamp(progressMeters, 0, route.totalMeters);
  const segment = segmentForProgress(route.cumulativeMeters, progress);
  const startMeters = route.cumulativeMeters[segment - 1];
  const endMeters = route.cumulativeMeters[segment];
  const t = endMeters === startMeters ? 0 : (progress - startMeters) / (endMeters - startMeters);
  return interpolate(route.waypoints[segment - 1], route.waypoints[segment], t);
}

export function parseRoutePlaybackRequest(value: unknown): RoutePlaybackRequest {
  if (!isRecord(value)) throw new Error("route payload must be an object");
  if (!Array.isArray(value.waypoints)) throw new Error("waypoints must be an array");
  if (value.waypoints.length < 1) throw new Error("route must include at least one waypoint");
  if (value.waypoints.length > MAX_WAYPOINTS) throw new Error(`route cannot exceed ${MAX_WAYPOINTS} waypoints`);

  const speedKph = optionalNumber(value.speedKph, "speedKph") ?? DEFAULT_SPEED_KPH;
  const multiplier = optionalNumber(value.multiplier, "multiplier") ?? 1;
  const intervalMs = optionalNumber(value.intervalMs, "intervalMs") ?? DEFAULT_INTERVAL_MS;
  if (speedKph <= 0 || speedKph > 500) throw new Error("speedKph must be between 0 and 500");
  if (multiplier <= 0 || multiplier > 100) throw new Error("multiplier must be between 0 and 100");
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new Error(`intervalMs must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`);
  }

  return {
    waypoints: value.waypoints.map(parseWaypoint),
    speedKph,
    multiplier,
    intervalMs: Math.round(intervalMs),
    loop: value.loop === true,
  };
}

export class RoutePlayback {
  #applyLocation: RoutePlaybackOpts["applyLocation"];
  #onLocation: RoutePlaybackOpts["onLocation"];
  #route: PreparedRoute | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #status: RoutePlaybackStatus = "idle";
  #speedKph = DEFAULT_SPEED_KPH;
  #multiplier = 1;
  #intervalMs = DEFAULT_INTERVAL_MS;
  #loop = false;
  #progressMeters = 0;
  #lastTickMs = 0;
  #startedAt: string | null = null;
  #updatedAt: string | null = null;
  #pausedAt: string | null = null;
  #completedAt: string | null = null;
  #lastError: string | null = null;
  #currentLocation: (GeoFix & { appliedAt: string }) | null = null;
  #applying = false;
  #applyId = 0;

  constructor(opts: RoutePlaybackOpts) {
    this.#applyLocation = opts.applyLocation;
    this.#onLocation = opts.onLocation;
  }

  async start(request: RoutePlaybackRequest): Promise<RoutePlaybackSnapshot> {
    this.stop();
    this.#route = prepareRoute(request.waypoints);
    this.#speedKph = request.speedKph ?? DEFAULT_SPEED_KPH;
    this.#multiplier = request.multiplier ?? 1;
    this.#intervalMs = request.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#loop = request.loop ?? false;
    this.#progressMeters = 0;
    this.#lastTickMs = Date.now();
    this.#status = "running";
    this.#startedAt = new Date(this.#lastTickMs).toISOString();
    this.#updatedAt = this.#startedAt;
    this.#pausedAt = null;
    this.#completedAt = null;
    this.#lastError = null;
    await this.#applyCurrentLocation();
    if (this.#status === "running") {
      this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
    }
    return this.snapshot();
  }

  pause(): RoutePlaybackSnapshot {
    if (this.#status === "running") {
      this.#status = "paused";
      this.#pausedAt = new Date().toISOString();
      this.#clearTimer();
    }
    return this.snapshot();
  }

  resume(): RoutePlaybackSnapshot {
    if (this.#status === "paused" && this.#route) {
      this.#status = "running";
      this.#pausedAt = null;
      this.#lastTickMs = Date.now();
      this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
    }
    return this.snapshot();
  }

  stop(): RoutePlaybackSnapshot {
    this.#clearTimer();
    this.#applyId++;
    this.#applying = false;
    this.#route = null;
    this.#status = "idle";
    this.#progressMeters = 0;
    this.#startedAt = null;
    this.#updatedAt = null;
    this.#pausedAt = null;
    this.#completedAt = null;
    this.#lastError = null;
    return this.snapshot();
  }

  snapshot(): RoutePlaybackSnapshot {
    return {
      status: this.#status,
      waypointCount: this.#route?.waypoints.length ?? 0,
      totalMeters: this.#route?.totalMeters ?? 0,
      progressMeters: this.#progressMeters,
      speedKph: this.#speedKph,
      multiplier: this.#multiplier,
      intervalMs: this.#intervalMs,
      loop: this.#loop,
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      pausedAt: this.#pausedAt,
      completedAt: this.#completedAt,
      lastError: this.#lastError,
      currentLocation: this.#currentLocation,
    };
  }

  close(): void {
    this.#clearTimer();
  }

  #tick(): void {
    void this.#tickNow();
  }

  async #tickNow(): Promise<void> {
    if (!this.#route || this.#status !== "running" || this.#applying) return;
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - this.#lastTickMs) / 1000);
    this.#lastTickMs = now;
    this.#progressMeters += (this.#speedKph * 1000 * elapsedSeconds * this.#multiplier) / 3600;

    if (this.#route.totalMeters === 0 || this.#progressMeters >= this.#route.totalMeters) {
      if (this.#loop && this.#route.totalMeters > 0) {
        this.#progressMeters %= this.#route.totalMeters;
      } else {
        this.#progressMeters = this.#route.totalMeters;
        this.#status = "completed";
        this.#completedAt = new Date(now).toISOString();
        this.#clearTimer();
      }
    }
    await this.#applyCurrentLocation();
  }

  async #applyCurrentLocation(): Promise<void> {
    const route = this.#route;
    if (!route) return;
    const applyId = ++this.#applyId;
    this.#applying = true;
    try {
      const fix = locationAt(route, this.#progressMeters);
      await this.#applyLocation(fix);
      if (this.#route !== route || this.#applyId !== applyId) return;
      this.#currentLocation = { ...fix, appliedAt: new Date().toISOString() };
      this.#updatedAt = this.#currentLocation.appliedAt;
      this.#onLocation(this.#currentLocation);
    } catch (err) {
      if (this.#route === route && this.#applyId === applyId) {
        this.#status = "error";
        this.#lastError = err instanceof Error ? err.message : String(err);
        this.#clearTimer();
      }
    } finally {
      if (this.#applyId === applyId) this.#applying = false;
    }
  }

  #clearTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
