import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-ignore vendored module, absent until `bun run build:vendor`
import { simMiddleware } from "../../vendor/serve-sim/dist/middleware.js";

import { MOUNT_PATH } from "./mount";
import {
  readStandaloneServeSimOptions,
  SERVE_SIM_OPTIONS_ENV,
  serveSimAllowsOrigin,
} from "./serve-sim-options";
import { FRAME_ANCESTORS, SESSION_TOKEN } from "./session-token";
import {
  SERVER_SINGLE_DEVICE,
  singleDeviceRefusal,
  refuseSingleDeviceSocket,
} from "./single-device";

export const SIM_PREFIX = "/vendor/serve-sim";
/**
 * The subprotocol prefix a browser names serve-sim's session token under. serve-sim's middleware
 * entry does not export its `TOKEN_SUBPROTOCOL_PREFIX`, so this copies it.
 */
export const SIM_TOKEN_SUBPROTOCOL_PREFIX = "serve-sim.token.";
// Must be the full mount path: serve-sim bakes basePath into the client-facing URLs it returns
// (grid / exec-ws / stream), so a shorter value silently breaks the iOS client.
const SIM_BASE_PATH = `${MOUNT_PATH}${SIM_PREFIX}`;

const standaloneOptions = readStandaloneServeSimOptions(process.env[SERVE_SIM_OPTIONS_ENV]);
const middleware = simMiddleware({
  basePath: SIM_BASE_PATH,
  proxyHelpers: true,
  ...standaloneOptions,
  ...(SERVER_SINGLE_DEVICE?.platform === "ios"
    ? { device: SERVER_SINGLE_DEVICE.id, singleDevice: SERVER_SINGLE_DEVICE.id }
    : {}),
  // The Hub's gate runs first and passes an authorized request on with the token as a bearer.
  ...(SESSION_TOKEN
    ? { execToken: SESSION_TOKEN, requirePreviewToken: true, frameAncestors: FRAME_ANCESTORS }
    : {}),
});

/** Whether serve-sim lets a page on `origin` read its responses. */
export const simAllowsOrigin = (origin: URL): boolean =>
  serveSimAllowsOrigin(standaloneOptions.corsOrigins ?? [], origin);
/**
 * Waits for a clipboard setup that serve-sim's preview may still be running, then releases what it
 * set up on the devices it opened.
 * @ref LLP 0013#hub-shutdown
 */
export function shutdownServeSim(): Promise<void> {
  return middleware.dispose();
}

const SERVE_SIM_STATE_DIR = join(tmpdir(), "serve-sim");
const SPAWN_RETRY_COOLDOWN_MS = 30_000;

let spawnInFlight = false;
let lastSpawnFailureAt = 0;

export async function handleSimRequest(request: Request): Promise<Response | null> {
  if (SERVER_SINGLE_DEVICE?.platform === "android") return singleDeviceRefusal();
  const url = new URL(request.url);
  const isPreviewRoot =
    request.method === "GET" && (url.pathname === SIM_PREFIX || url.pathname === `${SIM_PREFIX}/`);
  if (isPreviewRoot && !SERVER_SINGLE_DEVICE) ensureHelperSpawned();

  const response = await middleware(
    new Request(`${url.origin}${MOUNT_PATH}${url.pathname}${url.search}`, request),
  );
  return response ?? null;
}

// Same-origin WebSockets: the exec/control channel (/exec-ws) and the HID input
// socket (/helper/ws?device=<udid>). Expo CLI accepts the upgrade for each
// registered route and hands us the socket; simMiddleware dispatches by path.
export const simWebSocketHandler = (
  socket: { close(): void; on(event: "error", listener: () => void): unknown },
  request: Request,
): void => {
  if (SERVER_SINGLE_DEVICE?.platform === "android") {
    refuseSingleDeviceSocket(socket);
    return;
  }
  const url = new URL(request.url);
  const rewritten = new Request(`${url.origin}${MOUNT_PATH}${url.pathname}${url.search}`, request);
  const handled = middleware.handleWebSocket?.(rewritten, socket);
  if (!handled) socket.close();
};

function ensureHelperSpawned(): void {
  if (spawnInFlight || helperStateExists()) return;
  if (Date.now() - lastSpawnFailureAt < SPAWN_RETRY_COOLDOWN_MS) return;
  spawnInFlight = true;
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [serveSimCliPath(), "--detach", "--quiet"], {
      stdio: "ignore",
      detached: true,
    });
  } catch {
    spawnInFlight = false;
    lastSpawnFailureAt = Date.now();
    return;
  }
  child.unref();
  child.on("error", () => {
    spawnInFlight = false;
    lastSpawnFailureAt = Date.now();
  });
  child.on("exit", (code) => {
    spawnInFlight = false;
    if (code !== 0) lastSpawnFailureAt = Date.now();
  });
}

function helperStateExists(): boolean {
  try {
    return readdirSync(SERVE_SIM_STATE_DIR).some(
      (file) => file.startsWith("server-") && file.endsWith(".json"),
    );
  } catch {
    return false;
  }
}

function serveSimCliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../vendor/serve-sim/dist/serve-sim.js");
}
