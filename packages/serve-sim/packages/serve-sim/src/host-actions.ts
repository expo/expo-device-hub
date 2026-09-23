import { rm, stat } from "fs/promises";
import { join } from "path";
import { z } from "zod";

import {
  type HostActionResult,
  type Invocation,
  ok,
  runInvocation,
} from "./host-actions-utils";
import { Argument, ConfinedPath, DESKTOP_DIR, SCREENSHOT_DIR } from "./host-paths";
import { ScreenshotName, captureScreenshotAsync } from "./screenshot-store";
import {
  UploadChunk,
  UploadId,
  appendUploadChunkAsync,
  removeUploadAsync,
  stagedUploadPath,
  reserveThumbnailPathAsync,
} from "./upload-store";

export type { HostActionResult } from "./host-actions-utils";

// The preview link is shareable, so this is a fixed set of actions rather than a shell: no value the
// page sends ever reaches one. It bounds what a link holder can run on the host, not what they can
// do to the simulator, so the session token remains the real boundary.

export interface HostActionRequest {
  action?: unknown;
  params?: unknown;
}

export class InvalidHostActionError extends Error {}

const APPEARANCES = ["light", "dark"] as const;
const PERMISSION_ACTIONS = ["grant", "revoke", "reset"] as const;
const MIRROR_VALUES = ["on", "off"] as const;

const Device = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/, "must be a simulator udid or device name");

const BundleId = z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must look like com.example.app");

/** An orientation or button name. Bounded rather than allowlisted, so a new button still works. */
const Token = z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a plain identifier");

const FileName = z.string().regex(/^(?!\.)[^/\\\n]{1,255}$/, "must be a plain file name");

const Coordinate = z.number().finite();

const FileSource = z.union([
  z.object({ uploadId: UploadId }),
  z.object({ path: ConfinedPath }),
]);

const ACTION_SCHEMAS = {
  "appearance.get": z.object({ udid: Device }),
  "appearance.set": z.object({ udid: Device, value: z.enum(APPEARANCES) }),
  "location.set": z.object({ udid: Device, lat: Coordinate, lng: Coordinate }),
  "location.clear": z.object({ udid: Device }),
  "home.springboard": z.object({ udid: Device }),
  "home.watch": z.object({ udid: Device.optional() }),
  rotate: z.object({ udid: Device, value: Token }),
  button: z.object({ value: Token, udid: Device.optional() }),
  "server.detach": z.object({
    udid: Device.optional(),
    port: z.string().regex(/^[0-9]{1,5}$/).optional(),
  }),
  "server.kill": z.object({}),
  "camera.listWebcams": z.object({}),
  "camera.switch": z.discriminatedUnion("source", [
    z.object({ udid: Device, source: z.literal("file"), target: ConfinedPath }),
    z.object({ udid: Device, source: z.literal("webcam"), target: Argument.optional() }),
    z.object({ udid: Device, source: z.literal("placeholder") }),
  ]),
  "camera.inject": z.discriminatedUnion("source", [
    z.object({
      udid: Device,
      bundleId: BundleId,
      mirror: z.enum(MIRROR_VALUES),
      source: z.literal("file"),
      target: ConfinedPath,
    }),
    z.object({
      udid: Device,
      bundleId: BundleId,
      mirror: z.enum(MIRROR_VALUES),
      source: z.literal("webcam"),
      target: Argument.optional(),
    }),
    z.object({
      udid: Device,
      bundleId: BundleId,
      mirror: z.enum(MIRROR_VALUES),
      source: z.literal("placeholder"),
    }),
  ]),
  "camera.mirror": z.object({ udid: Device, value: z.enum(MIRROR_VALUES) }),
  "camera.stopWebcam": z.object({ udid: Device }),
  "permissions.set": z.object({
    udid: Device,
    bundleId: BundleId,
    action: z.enum(PERMISSION_ACTIONS),
    service: Token,
  }),
  "permissions.resetAll": z.object({ udid: Device, bundleId: BundleId }),
  "app.container": z.object({ udid: Device, bundleId: BundleId }),
  "app.infoPlist": z.object({ path: ConfinedPath }),
  "app.install": z.object({ udid: Device }).and(FileSource),
  "app.iconPath": z.object({ appPath: ConfinedPath, candidates: z.array(FileName).min(1).max(32) }),
  "media.add": z.object({ udid: Device }).and(FileSource),
  reveal: z.union([z.object({ path: ConfinedPath }), z.object({ screenshot: ScreenshotName })]),
  "file.readBase64": z.object({ path: ConfinedPath }),
  "screenshot.capture": z.object({ udid: Device, fileName: ScreenshotName }),
  "screenshot.thumbnail": z.object({ fileName: ScreenshotName }),
  "upload.append": z.object({
    uploadId: UploadId,
    // Bounded here rather than trusting the socket's cap: a host may supply its own transport.
    data: UploadChunk,
    first: z.boolean().optional(),
  }),
  "upload.remove": z.object({ uploadId: UploadId }),
} as const;

type HostActionName = keyof typeof ACTION_SCHEMAS;

/**
 * Everything else is one child process, built by buildInvocation. These are file work done in this
 * process, or a sequence of children with cleanup between them. Uploads arrive as base64 chunks,
 * which would blow past ARG_MAX as arguments, so they are decoded and appended here instead.
 */
const PROCEDURE_ACTIONS = [
  "upload.append",
  "upload.remove",
  "app.iconPath",
  "screenshot.capture",
  "screenshot.thumbnail",
] as const satisfies readonly HostActionName[];

type ProcedureAction = (typeof PROCEDURE_ACTIONS)[number];
type InvocationAction = Exclude<HostActionName, ProcedureAction>;

function isProcedureAction(action: HostActionName): action is ProcedureAction {
  return PROCEDURE_ACTIONS.some((procedure) => procedure === action);
}

function isHostActionName(action: string): action is HostActionName {
  return Object.hasOwn(ACTION_SCHEMAS, action);
}

type ParamsFor<A extends HostActionName> = z.infer<(typeof ACTION_SCHEMAS)[A]>;

function parseParams<A extends HostActionName>(action: A, raw: unknown): ParamsFor<A> {
  const result = ACTION_SCHEMAS[action].safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join(".");
    throw new InvalidHostActionError(
      `${action}: ${field ? `${field} ` : ""}${issue?.message ?? "invalid params"}`,
    );
  }
  return result.data as ParamsFor<A>;
}

function serveSimInvocation(binPath: string, args: string[]): Invocation {
  if (/\.ts$/.test(binPath)) return { file: "bun", args: [binPath, ...args] };
  if (/\.js$/.test(binPath)) return { file: "node", args: [binPath, ...args] };
  return { file: binPath, args };
}

function buildInvocation(action: InvocationAction, raw: unknown, binPath: string): Invocation {
  const serveSim = (args: string[]): Invocation => serveSimInvocation(binPath, args);
  const simctl = (args: string[]): Invocation => ({ file: "xcrun", args: ["simctl", ...args] });

  switch (action) {
    case "appearance.get": {
      const p = parseParams(action, raw);
      return simctl(["ui", p.udid, "appearance"]);
    }
    case "appearance.set": {
      const p = parseParams(action, raw);
      return simctl(["ui", p.udid, "appearance", p.value]);
    }
    case "location.set": {
      const p = parseParams(action, raw);
      return simctl(["location", p.udid, "set", `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`]);
    }
    case "location.clear": {
      const p = parseParams(action, raw);
      return simctl(["location", p.udid, "clear"]);
    }
    case "home.springboard": {
      const p = parseParams(action, raw);
      return simctl(["launch", p.udid, "com.apple.springboard"]);
    }
    case "home.watch":
      parseParams(action, raw);
      return {
        file: "osascript",
        args: [
          "-e",
          'tell application "System Events" to tell process "Simulator" to set frontmost to true',
          "-e",
          'tell application "System Events" to tell process "Simulator" to perform action "AXRaise" of (first window whose name contains "watchOS")',
          "-e",
          'tell application "System Events" to tell process "Simulator" to click menu item "Home" of menu "Device" of menu bar item "Device" of menu bar 1',
        ],
      };
    case "rotate": {
      const p = parseParams(action, raw);
      return serveSim(["rotate", p.value, "-d", p.udid]);
    }
    case "button": {
      const p = parseParams(action, raw);
      return serveSim(["button", p.value, ...(p.udid ? ["-d", p.udid] : [])]);
    }
    case "server.detach": {
      const p = parseParams(action, raw);
      return serveSim([
        "--detach",
        ...(p.udid ? [p.udid] : []),
        ...(p.port ? ["--port", p.port] : []),
      ]);
    }
    case "server.kill":
      parseParams(action, raw);
      return serveSim(["--kill"]);
    case "camera.listWebcams":
      parseParams(action, raw);
      return serveSim(["camera", "--list-webcams"]);
    case "camera.switch": {
      const p = parseParams(action, raw);
      const target = "target" in p ? p.target : undefined;
      return serveSim([
        "camera",
        "switch",
        p.source,
        ...(target ? [target] : []),
        "-d",
        p.udid,
        "--quiet",
      ]);
    }
    case "camera.inject": {
      const p = parseParams(action, raw);
      const args = ["camera", p.bundleId, "-d", p.udid, "--quiet"];
      if (p.source === "file") args.push("--file", p.target);
      else if (p.source === "webcam") args.push("--webcam", ...(p.target ? [p.target] : []));
      args.push("--mirror", p.mirror);
      return serveSim(args);
    }
    case "camera.mirror": {
      const p = parseParams(action, raw);
      return serveSim(["camera", "mirror", p.value, "-d", p.udid, "--quiet"]);
    }
    case "camera.stopWebcam": {
      const p = parseParams(action, raw);
      return serveSim(["camera", "--stop-webcam", "-d", p.udid]);
    }
    case "permissions.set": {
      const p = parseParams(action, raw);
      return serveSim(["permissions", p.action, p.service, p.bundleId, "-d", p.udid]);
    }
    case "permissions.resetAll": {
      const p = parseParams(action, raw);
      return serveSim(["permissions", "reset", "all", p.bundleId, "-d", p.udid]);
    }
    case "app.container": {
      const p = parseParams(action, raw);
      return simctl(["get_app_container", p.udid, p.bundleId, "app"]);
    }
    case "app.infoPlist": {
      const p = parseParams(action, raw);
      return { file: "plutil", args: ["-convert", "json", "-o", "-", p.path] };
    }
    case "app.install": {
      const p = parseParams(action, raw);
      return simctl(["install", p.udid, fileSourcePath(p)]);
    }
    case "media.add": {
      const p = parseParams(action, raw);
      return simctl(["addmedia", p.udid, fileSourcePath(p)]);
    }
    case "reveal": {
      const p = parseParams(action, raw);
      const target = "screenshot" in p ? join(DESKTOP_DIR, p.screenshot) : p.path;
      return { file: "open", args: ["-R", target] };
    }
    case "file.readBase64": {
      const p = parseParams(action, raw);
      return { file: "base64", args: ["-i", p.path] };
    }
    default: {
      action satisfies never;
      throw new InvalidHostActionError(`unknown action ${String(action)}`);
    }
  }
}

function fileSourcePath(p: { uploadId: string } | { path: string }): string {
  return "uploadId" in p ? stagedUploadPath(p.uploadId) : p.path;
}

async function runProcedureAsync(action: ProcedureAction, raw: unknown): Promise<HostActionResult> {
  switch (action) {
    case "upload.append": {
      const p = parseParams(action, raw);
      return await appendUploadChunkAsync(p);
    }
    case "upload.remove": {
      const p = parseParams(action, raw);
      return await removeUploadAsync(p.uploadId);
    }
    case "app.iconPath": {
      const p = parseParams(action, raw);
      for (const candidate of p.candidates) {
        const full = join(p.appPath, candidate);
        try {
          if ((await stat(full)).isFile()) return ok(full);
        } catch {}
      }
      return { stdout: "", stderr: "no icon found", exitCode: 1 };
    }
    case "screenshot.capture": {
      const p = parseParams(action, raw);
      return await captureScreenshotAsync(p);
    }
    case "screenshot.thumbnail": {
      const p = parseParams(action, raw);
      const thumb = await reserveThumbnailPathAsync();
      try {
        const sips = await runInvocation({
          file: "sips",
          args: ["-Z", "320", join(SCREENSHOT_DIR, p.fileName), "--out", thumb],
        });
        if (sips.exitCode !== 0) return sips;
        return await runInvocation({ file: "base64", args: ["-i", thumb] });
      } finally {
        await rm(thumb, { force: true });
      }
    }
    default: {
      action satisfies never;
      throw new InvalidHostActionError(`unknown action ${String(action)}`);
    }
  }
}

export async function runHostActionAsync(
  msg: HostActionRequest,
  binPath: string,
): Promise<HostActionResult> {
  const { action, params } = msg;
  if (typeof action !== "string" || !isHostActionName(action)) {
    throw new InvalidHostActionError(`unknown action ${String(action)}`);
  }
  const result = isProcedureAction(action)
    ? await runProcedureAsync(action, params)
    : await runInvocation(buildInvocation(action, params, binPath));
  // exec-ws spreads this straight into the reply, so only the three fields the page reads leave
  // the process. `timedOut` steers the message a handler composes; the page has no use for it.
  const { stdout, stderr, exitCode } = result;
  return { stdout, stderr, exitCode };
}
