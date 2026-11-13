import {
  CAMERA_FACINGS,
  isOrientationMode,
  type ApiMethod,
  type ApiPath,
  type CameraFacing,
  type SessionAction,
  type SessionAppAction,
  type SessionSettingName,
} from "./shared/api-contracts.ts";

/** What a successful request to one route adds to the session events. */
export type SessionEventPolicy =
  /** The route records its own input entry: a gesture or a location. */
  | { record: "input" }
  /**
   * Record an action entry after a successful response. With `payload`, `action` gets the
   * request's JSON body; the route already accepted it.
   */
  | {
      record: "action";
      payload?: true;
      action: (request: { payload: unknown; url: URL }) => SessionAction | null;
    }
  /** Not a device interaction. `reason` says why. */
  | { record: "none"; reason: string };

/** `METHOD /path` for every contract route that is not a read. */
type MutatingContractRoute = {
  [Path in ApiPath]: `${Exclude<ApiMethod<Path>, "GET">} ${Path}`;
}[ApiPath];

/** The middleware's Appearance route, which the standalone server names `/api/night-mode`. */
type MiddlewareOnlyRoute = "POST /api/uimode";

function field(payload: unknown, name: string): unknown {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

function stringField(payload: unknown, name: string): string | undefined {
  const value = field(payload, name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function setting(
  name: SessionSettingName,
  key: "enabled" | "scale",
): Extract<SessionEventPolicy, { record: "action" }> {
  return {
    record: "action",
    payload: true,
    action: ({ payload }) => {
      const value = field(payload, key);
      if (key === "enabled" ? typeof value !== "boolean" : typeof value !== "number") return null;
      return { type: "setting", setting: name, value: value as boolean | number };
    },
  };
}

function nightMode(
  key: "mode" | "night",
  values: Record<string, "dark" | "light" | "auto">,
): Extract<SessionEventPolicy, { record: "action" }> {
  return {
    record: "action",
    payload: true,
    action: ({ payload }) => {
      const value = field(payload, key);
      const mode = typeof value === "string" && Object.hasOwn(values, value) ? values[value] : null;
      return mode ? { type: "setting", setting: "night-mode", value: mode } : null;
    },
  };
}

function app(
  action: SessionAppAction,
  fields: { packageName?: true; permission?: true } = {},
): Extract<SessionEventPolicy, { record: "action" }> {
  const usesPayload = Boolean(fields.packageName || fields.permission);
  return {
    record: "action",
    ...(usesPayload ? { payload: true as const } : {}),
    action: ({ payload }) => {
      const packageName = fields.packageName ? stringField(payload, "packageName") : undefined;
      const permission = fields.permission ? stringField(payload, "permission") : undefined;
      return {
        type: "app",
        action,
        ...(packageName ? { packageName } : {}),
        ...(permission ? { permission } : {}),
      };
    },
  };
}

function camera(action: "set-image" | "clear-image"): SessionEventPolicy {
  return {
    record: "action",
    action: ({ url }) => {
      const facing = url.searchParams.get("facing");
      return CAMERA_FACINGS.includes(facing as CameraFacing)
        ? { type: "camera", action, facing: facing as CameraFacing }
        : null;
    },
  };
}

const FLEET = "Acts on the device fleet, not on one device's session.";
const VIEWER = "Changes how viewers receive the stream, not the device.";
const RECORDING = "Acts on the session recording itself.";

// @ref LLP 0025#policy — one table decides what each mutating route adds to the session events
/**
 * Every route that changes state, and what it adds to the session events. The type lists every
 * mutating contract route, so a new route does not typecheck until it is classified here.
 */
export const SESSION_EVENT_POLICY = {
  "POST /api/tap": { record: "input" },
  "POST /api/swipe": { record: "input" },
  "POST /api/text": { record: "input" },
  "POST /api/key": { record: "input" },
  "POST /api/accessibility/tap": { record: "input" },
  "POST /api/location": { record: "input" },

  "POST /api/screenshot": { record: "action", action: () => ({ type: "screenshot" }) },
  "POST /api/orientation": {
    record: "action",
    payload: true,
    action: ({ payload }) => {
      const orientation = field(payload, "orientation");
      return isOrientationMode(orientation) ? { type: "orientation", orientation } : null;
    },
  },
  "POST /api/fold": {
    record: "action",
    payload: true,
    action: ({ payload }) => {
      const hingeAngle = field(payload, "hingeAngle");
      if (typeof hingeAngle === "number") return { type: "fold", hingeAngle };
      const posture = field(payload, "posture");
      return posture === "closed" || posture === "opened" ? { type: "fold", posture } : null;
    },
  },
  "POST /api/night-mode": nightMode("mode", { dark: "dark", light: "light", auto: "auto" }),
  "POST /api/uimode": nightMode("night", { yes: "dark", no: "light", auto: "auto" }),
  "POST /api/font-scale": setting("font-scale", "scale"),
  "POST /api/display-density": setting("display-density", "scale"),
  "POST /api/network": setting("network", "enabled"),
  "POST /api/reduce-motion": setting("reduce-motion", "enabled"),
  "POST /api/high-text-contrast": setting("high-text-contrast", "enabled"),
  "POST /api/font-weight": setting("font-weight", "enabled"),
  "POST /api/software-keyboard": setting("software-keyboard", "enabled"),

  // The APK and the imported file are multipart bodies, so these entries carry no details.
  "POST /api/apps/install": app("install"),
  "POST /api/files/import": { record: "action", action: () => ({ type: "file-import" }) },
  "POST /api/apps/launch": app("launch", { packageName: true }),
  "POST /api/apps/clear": app("clear", { packageName: true }),
  "POST /api/apps/force-stop": app("force-stop", { packageName: true }),
  "POST /api/apps/grant": app("grant", { packageName: true, permission: true }),
  "POST /api/apps/revoke": app("revoke", { packageName: true, permission: true }),
  "POST /api/apps/reset-permissions": app("reset-permissions", { packageName: true }),

  // A route body can hold many points, so the start entry does not copy it.
  "POST /api/route": { record: "action", action: () => ({ type: "route", action: "start" }) },
  "DELETE /api/route": { record: "action", action: () => ({ type: "route", action: "stop" }) },
  "POST /api/route/control": {
    record: "action",
    payload: true,
    action: ({ payload }) => {
      const action = field(payload, "action");
      return action === "pause" || action === "resume" || action === "stop"
        ? { type: "route", action }
        : null;
    },
  },
  "POST /api/camera/image": camera("set-image"),
  "DELETE /api/camera/image": camera("clear-image"),

  "POST /api/devices/select": { record: "none", reason: FLEET },
  "POST /api/avds/start": { record: "none", reason: FLEET },
  "POST /api/avds/stop": { record: "none", reason: FLEET },
  "PUT /api/stream-mode": { record: "none", reason: VIEWER },
  "PATCH /api/stream-settings": { record: "none", reason: VIEWER },
  "DELETE /api/session": { record: "none", reason: RECORDING },
  // `replayStartedAt` and `replaying` already show a replay.
  "POST /api/session/replay": { record: "none", reason: RECORDING },
  "POST /api/session/replay/stop": { record: "none", reason: RECORDING },
} as const satisfies Record<MutatingContractRoute | MiddlewareOnlyRoute, SessionEventPolicy>;

/** The policy for one request, or null for a read or an unknown route. */
export function sessionEventPolicy(method: string, pathname: string): SessionEventPolicy | null {
  const key = `${method.toUpperCase()} ${pathname}`;
  return Object.hasOwn(SESSION_EVENT_POLICY, key)
    ? (SESSION_EVENT_POLICY as Record<string, SessionEventPolicy>)[key]!
    : null;
}

/** Records an action in the session of the device that the request acted on. */
export type RecordSessionAction = (action: SessionAction, source: string) => void;

/**
 * Run `route`, then record the request's action when the policy names one and the response is
 * a success. Without `record`, as when no device session exists yet, this only runs `route`.
 */
export async function withSessionAction<R extends Response | null | undefined | void>(
  request: Request,
  route: (request: Request) => Promise<R> | R,
  record: RecordSessionAction | null | undefined,
): Promise<R> {
  const url = new URL(request.url);
  const policy = record ? sessionEventPolicy(request.method, url.pathname) : null;
  if (!record || policy?.record !== "action") return await route(request);

  // The route reads the body, so keep a copy for the action's details. Do not read
  // `request.body` first: in Bun 1.3, a clone made after that read leaves the original empty.
  const copy = policy.payload ? request.clone() : null;
  const response = await route(request);
  if (!(response instanceof Response && response.ok)) {
    void copy?.body?.cancel().catch(() => {});
    return response;
  }
  let payload: unknown;
  if (copy) {
    try {
      payload = await copy.json();
    } catch {
      payload = undefined;
    }
  }
  const action = policy.action({ payload, url });
  if (action) record(action, `rest:${url.pathname.replace(/^\/api\//, "")}`);
  return response;
}
