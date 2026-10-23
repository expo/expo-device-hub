import { rm, stat } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { installAppAsync } from "./app-install";
import { AppRelativePath, runAppFileAction } from "./app-files";

import { CAPTURE_FIELDS } from "./capture/fields";

import {
  type HostActionResult,
  HostActionTimeoutError,
  type Invocation,
  ok,
  runInvocation,
  serveSimInvocation,
  redactHostPaths,
  actionTimeoutMs,
} from "./host-actions-utils";
import { Argument, ConfinedPath, DESKTOP_DIR, SCREENSHOT_DIR } from "./host-paths";
import {
  ScreenshotDisplay,
  ScreenshotName,
  captureScreenshotAsync,
  newScreenshotName,
} from "./screenshot-store";
import { approveUrlScheme, launchApp, openUrlInApp, stopApp } from "./launch-manager";
import { CA_DEBUG_FLAGS } from "./ca-debug";
import { HINGE_POSITIONS, isHingeAngle } from "./hinge-angle";
import { UI_OPTIONS } from "./ui-settings";
import { TouchCoordinate, TouchGesture } from "./touch-gesture";
import { MAX_PASTEBOARD_TEXT_BYTES, writeSimPasteboard } from "./sim-pasteboard";
import { cleanupWarningOf } from "./sim-pasteboard-copy";
import type { StreamSettings } from "./stream-settings";
import {
  UploadChunk,
  UploadId,
  appendUploadChunkAsync,
  removeUploadAsync,
  withStagedUploadSnapshotAsync,
  getStagedUploadId,
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
const TOGGLE_VALUES = ["on", "off"] as const;

const Device = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/, "must be a simulator udid or device name");

// simctl reads "all" and "booted" as every device, and capture reboots what it is given.
const DeviceUdid = z
  .string()
  .regex(
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
    "must be a simulator udid",
  );
const CaptureRequestId = z
  .string()
  .max(64)
  .regex(/^r[1-9]\d*$/, "must be a capture request id");

const BundleId = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must look like com.example.app");

const UrlScheme = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9+.-]*$/, "must be a URL scheme such as myapp")
  .refine(
    (scheme) => !["http", "https"].includes(scheme.toLowerCase()),
    "http and https links open without asking",
  )
  // URL parsing lowercases the scheme, and the simulator only honors an approval whose key matches.
  .transform((scheme) => scheme.toLowerCase());

/** An orientation or button name. Bounded rather than allowlisted, so a new button still works. */
const Token = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a plain identifier");

const FileName = z.string().regex(/^(?!\.)[^/\\\n]{1,255}$/, "must be a plain file name");

const Coordinate = z.number().finite();
const ClipboardDevice = DeviceUdid.toUpperCase();
const ClipboardText = z
  .string()
  .max(MAX_PASTEBOARD_TEXT_BYTES)
  .refine(
    (text) => Buffer.byteLength(text, "utf8") <= MAX_PASTEBOARD_TEXT_BYTES,
    "must be at most 4 MiB of UTF-8 text",
  );

function UiSetting(option: string) {
  const spec = UI_OPTIONS[option];
  if (!spec) throw new Error(`Unknown simulator setting ${option}.`);
  return z.object({ udid: Device, value: z.enum([...spec.values, ...(spec.extraValues ?? [])]) });
}

const FileSource = z.union([z.object({ uploadId: UploadId }), z.object({ path: ConfinedPath })]);

/** Each capture field once; the four the capture proxy knows. */
const CaptureFieldList = z
  .array(z.enum(CAPTURE_FIELDS))
  .max(CAPTURE_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length, "list each capture field once");

const ACTION_SCHEMAS = {
  "clipboard.read": z
    .object({ udid: ClipboardDevice })
    .meta({ description: "Read simulator clipboard text." }),
  "clipboard.write": z
    .object({ udid: ClipboardDevice, text: ClipboardText })
    .meta({ description: "Write simulator clipboard text without pasting." }),
  "clipboard.copy": z
    .object({ udid: ClipboardDevice })
    .meta({ description: "Copy the current selection and read its text." }),
  "clipboard.paste": z.object({ udid: ClipboardDevice, text: ClipboardText.optional() }).meta({
    description:
      "Paste text into the focused field, or paste the current simulator clipboard if omitted.",
  }),
  "appearance.get": z.object({ udid: Device }).meta({ description: "Read light or dark mode." }),
  "appearance.set": z
    .object({ udid: Device, value: z.enum(APPEARANCES) })
    .meta({ description: "Set light or dark mode." }),
  "hardwareKeyboard.get": z
    .object({ udid: Device })
    .meta({ description: "Read whether the hardware keyboard is connected." }),
  "hardwareKeyboard.set": UiSetting("hardware-keyboard").meta({
    description: "Connect or disconnect the hardware keyboard.",
  }),
  "reduceMotion.get": z.object({ udid: Device }).meta({ description: "Read Reduce Motion." }),
  "reduceMotion.set": UiSetting("reduce-motion").meta({
    description: "Turn Reduce Motion on or off.",
  }),
  "increaseContrast.get": z
    .object({ udid: Device })
    .meta({ description: "Read Increase Contrast." }),
  "increaseContrast.set": UiSetting("increase-contrast").meta({
    description: "Turn Increase Contrast on or off.",
  }),
  "reduceTransparency.get": z
    .object({ udid: Device })
    .meta({ description: "Read Reduce Transparency." }),
  "reduceTransparency.set": UiSetting("reduce-transparency").meta({
    description: "Turn Reduce Transparency on or off.",
  }),
  "voiceover.get": z
    .object({ udid: Device })
    .meta({ description: "Read whether VoiceOver is on." }),
  "voiceover.set": UiSetting("voiceover").meta({ description: "Turn VoiceOver on or off." }),
  "liquidGlass.get": z
    .object({ udid: Device })
    .meta({ description: "Read the Liquid Glass style." }),
  "liquidGlass.set": UiSetting("liquid-glass").meta({ description: "Set the Liquid Glass style." }),
  "colorFilter.get": z.object({ udid: Device }).meta({ description: "Read the color filter." }),
  "colorFilter.set": UiSetting("color-filter").meta({ description: "Set the color filter." }),
  "textSize.get": z.object({ udid: Device }).meta({ description: "Read the text size." }),
  "textSize.set": UiSetting("text-size").meta({ description: "Set the text size." }),
  "showBorders.get": z
    .object({ udid: Device })
    .meta({ description: "Read whether button borders show." }),
  "showBorders.set": UiSetting("show-borders").meta({
    description: "Show or hide button borders.",
  }),
  "settings.status": z
    .object({ udid: Device })
    .meta({ description: "Read every simulator setting." }),
  "softwareKeyboard.toggle": z
    .object({ udid: Device })
    .meta({ description: "Show or hide the on-screen keyboard." }),
  tap: z
    .object({ udid: Device, x: TouchCoordinate, y: TouchCoordinate })
    .meta({ description: "Tap at normalized screen coordinates." }),
  gesture: z
    .object({ udid: Device, events: TouchGesture })
    .meta({ description: "Send a complete touch gesture and wait for input completion." }),
  type: z
    .object({
      udid: Device,
      text: z
        .string()
        .max(4096)
        .regex(/^[\t\n\r\x20-\x7e]*$/, "must use US-keyboard ASCII characters, newline or tab"),
    })
    .meta({ description: "Type US-keyboard ASCII text into the focused field." }),
  memoryWarning: z
    .object({ udid: Device })
    .meta({ description: "Send a memory warning to the device." }),
  "caDebug.set": z
    .object({
      udid: Device,
      option: z.enum(Object.keys(CA_DEBUG_FLAGS)),
      value: z.enum(TOGGLE_VALUES),
    })
    .meta({ description: "Turn a Core Animation debug option on or off." }),
  "hinge.get": z.object({ udid: Device }).meta({ description: "Read the hinge state." }),
  "hinge.set": z
    .object({
      udid: Device,
      value: z.union([
        z.enum(HINGE_POSITIONS.map((position) => position.name)),
        z.number().refine(isHingeAngle, "must be from 0 to 180"),
      ]),
    })
    .meta({ description: "Fold or unfold a foldable simulator." }),
  "permissions.list": z
    .object({ udid: Device, bundleId: BundleId.optional() })
    .meta({ description: "List permissions for one app or for every app." }),
  "location.set": z
    .object({ udid: Device, lat: Coordinate, lng: Coordinate })
    .meta({ description: "Set the simulated location." }),
  "location.clear": z.object({ udid: Device }).meta({ description: "Stop simulating a location." }),
  "home.springboard": z.object({ udid: Device }).meta({ description: "Go to the Home screen." }),
  "springboard.restart": z
    .object({ udid: DeviceUdid.transform((udid) => udid.toUpperCase()) })
    .meta({ description: "Restart SpringBoard. The foreground app goes to the background." }),
  "home.watch": z.object({ udid: Device.optional() }).meta({ hidden: true }),
  rotate: z.object({ udid: Device, value: Token }).meta({ description: "Rotate the device." }),
  button: z
    .object({ value: Token, udid: Device.optional() })
    .meta({ description: "Press a hardware button." }),
  "server.detach": z
    .object({
      udid: Device.optional(),
      port: z
        .string()
        .regex(/^[0-9]{1,5}$/)
        .optional(),
    })
    .meta({ hidden: true }),
  "server.kill": z.object({}).meta({ hidden: true }),
  "camera.listWebcams": z.object({}).meta({ hidden: true }),
  "camera.switch": z
    .discriminatedUnion("source", [
      z.object({ udid: Device, source: z.literal("file"), target: ConfinedPath }),
      z.object({ udid: Device, source: z.literal("webcam"), target: Argument.optional() }),
      z.object({ udid: Device, source: z.literal("placeholder") }),
    ])
    .meta({
      description: "Change the camera feed of an app with a simulated camera.",
      args: ["source", "target"],
      upload: "target",
      uploadWhen: { source: "file" },
      keepUpload: true,
    }),
  "camera.inject": z
    .discriminatedUnion("source", [
      z.object({
        udid: Device,
        bundleId: BundleId,
        mirror: z.enum(TOGGLE_VALUES),
        source: z.literal("file"),
        target: ConfinedPath,
      }),
      z.object({
        udid: Device,
        bundleId: BundleId,
        mirror: z.enum(TOGGLE_VALUES),
        source: z.literal("webcam"),
        target: Argument.optional(),
      }),
      z.object({
        udid: Device,
        bundleId: BundleId,
        mirror: z.enum(TOGGLE_VALUES),
        source: z.literal("placeholder"),
      }),
    ])
    .meta({
      description: "Relaunch an app with a simulated camera feed.",
      args: ["bundleId", "mirror", "source", "target"],
      upload: "target",
      uploadWhen: { source: "file" },
      keepUpload: true,
    }),
  "camera.mirror": z
    .object({ udid: Device, value: z.enum(TOGGLE_VALUES) })
    .meta({ description: "Mirror the simulated camera feed." }),
  "camera.stopWebcam": z.object({ udid: Device }).meta({ hidden: true }),
  "permissions.set": z
    .object({
      udid: Device,
      action: z.enum(PERMISSION_ACTIONS),
      service: Token,
      bundleId: BundleId,
    })
    .meta({ description: "Grant, revoke or reset one permission for an app." }),
  "permissions.resetAll": z
    .object({ udid: Device, bundleId: BundleId })
    .meta({ description: "Reset every permission for an app." }),
  "app.container": z
    .object({ udid: Device, bundleId: BundleId, type: z.enum(["app", "data"]).default("app") })
    .meta({ description: "Print the path of an app's bundle or data container." }),
  "app.file.upload": z
    .object({
      udid: DeviceUdid.transform((udid) => udid.toUpperCase()),
      bundleId: BundleId,
      relativePath: AppRelativePath,
      uploadId: UploadId,
      overwrite: z.boolean().default(false),
    })
    .meta({
      description: "Copy a file into an app's data container.",
      upload: "uploadId",
      uploadAs: "id",
    }),
  "app.file.read": z
    .object({
      udid: DeviceUdid.transform((udid) => udid.toUpperCase()),
      bundleId: BundleId,
      relativePath: AppRelativePath,
    })
    .meta({ description: "Download a file from an app's data container.", output: "base64" }),
  "app.file.list": z
    .object({
      udid: DeviceUdid.transform((udid) => udid.toUpperCase()),
      bundleId: BundleId,
      relativePath: AppRelativePath.optional(),
    })
    .meta({ description: "List the files in a folder of an app's data container." }),
  "app.file.remove": z
    .object({
      udid: DeviceUdid.transform((udid) => udid.toUpperCase()),
      bundleId: BundleId,
      relativePath: AppRelativePath,
    })
    .meta({ description: "Delete a file from an app's data container." }),
  "app.stop": z
    .object({ udid: DeviceUdid.transform((udid) => udid.toUpperCase()), bundleId: BundleId })
    .meta({ description: "Stop an app." }),
  "app.openUrl": z
    .object({
      udid: DeviceUdid.transform((udid) => udid.toUpperCase()),
      bundleId: BundleId,
      url: z
        .string()
        .max(8192)
        .url()
        .refine((value) => !value.includes("\0"), "must not contain NUL"),
    })
    .meta({ description: "Open a URL in an app." }),
  "app.approveUrlScheme": z
    .object({
      udid: DeviceUdid.transform((udid) => udid.toUpperCase()),
      bundleId: BundleId,
      scheme: UrlScheme,
    })
    .meta({ description: "Let links with a URL scheme open an app without asking first." }),
  "app.infoPlist": z
    .object({ path: ConfinedPath })
    .meta({ description: "Read an Info.plist as JSON." }),
  "app.install": z
    .object({ udid: Device })
    .and(FileSource)
    .meta({
      description: "Install a simulator .app bundle or a .tar.gz/.tgz app archive.",
      args: ["path"],
      upload: "path",
      uploadArchive: "tar.gz",
    }),
  "app.launch": z
    .object({
      // Launch state and locks use simctl's canonical uppercase UDID.
      udid: DeviceUdid.transform((udid) => udid.toUpperCase()),
      bundleId: BundleId,
      launchArgs: z
        .array(
          z
            .string()
            .max(8192)
            .refine((value) => !value.includes("\0"), "must not contain NUL"),
        )
        .max(256)
        .refine(
          (args) =>
            args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) <= 128 * 1024,
          "must total at most 128 KiB",
        )
        .default([]),
      openUrl: z
        .string()
        .max(8192)
        .url()
        .refine((value) => !value.includes("\0"), "must not contain NUL")
        .optional(),
    })
    .meta({ description: "Restart an app with launch arguments and an optional URL to open." }),
  "app.iconPath": z
    .object({ appPath: ConfinedPath, candidates: z.array(FileName).min(1).max(32) })
    .meta({ hidden: true }),
  "media.add": z
    .object({ udid: Device })
    .and(FileSource)
    .meta({
      description: "Add a photo or video to the Photos library.",
      args: ["path"],
      upload: "path",
    }),
  reveal: z
    .union([z.object({ path: ConfinedPath }), z.object({ screenshot: ScreenshotName })])
    .meta({ hidden: true }),
  "file.readBase64": z
    .object({ path: ConfinedPath })
    .meta({ description: "Download a file from the simulator host.", output: "base64" }),
  "screenshot.capture": z
    .object({
      udid: Device,
      fileName: ScreenshotName.optional(),
      display: ScreenshotDisplay.optional(),
    })
    .meta({
      description: "Take a screenshot of the active display, or the specified simctl display ID.",
      output: "path",
    }),
  "screenshot.thumbnail": z.object({ fileName: ScreenshotName }).meta({ hidden: true }),
  "upload.append": z
    .object({
      uploadId: UploadId,
      // Bounded here rather than trusting the socket's cap: a host may supply its own transport.
      data: UploadChunk,
      first: z.boolean().optional(),
    })
    .meta({ hidden: true }),
  "upload.remove": z.object({ uploadId: UploadId }).meta({ hidden: true }),
  "capture.reboot": z
    .object({ udid: DeviceUdid, enabled: z.boolean(), fields: CaptureFieldList.optional() })
    .meta({ description: "Reboot the simulator with network capture on or off." }),
  "capture.enable": z
    .object({ udid: DeviceUdid, fields: CaptureFieldList.optional() })
    .meta({ description: "Start network capture." }),
  "capture.fields": z
    .object({ udid: DeviceUdid, fields: CaptureFieldList })
    .meta({ description: "Choose the fields that network capture records." }),
  "capture.clear": z
    .object({ udid: DeviceUdid })
    .meta({ description: "Clear the captured network requests." }),
  "capture.body": z
    .object({ udid: DeviceUdid, id: CaptureRequestId })
    .meta({ description: "Read the body of a captured network request." }),
  "actions.describe": z.object({}).meta({ hidden: true }),
} as const;

type HostActionName = keyof typeof ACTION_SCHEMAS;

/**
 * Everything else is one child process, built by buildInvocation. These are file work done in this
 * process, a sequence of children with cleanup between them, or the action catalog. Uploads arrive
 * as base64 chunks, which would blow past ARG_MAX as arguments, so they are decoded and appended
 * here instead.
 */
const PROCEDURE_ACTIONS = [
  "actions.describe",
  "clipboard.read",
  "clipboard.write",
  "clipboard.copy",
  "clipboard.paste",
  "app.file.upload",
  "app.file.read",
  "app.file.list",
  "app.file.remove",
  "app.stop",
  "app.openUrl",
  "app.approveUrlScheme",
  "app.launch",
  "app.install",
  "upload.append",
  "upload.remove",
  "app.iconPath",
  "screenshot.capture",
  "screenshot.thumbnail",
  "capture.reboot",
  "capture.enable",
  "capture.fields",
  "capture.clear",
  "capture.body",
] as const satisfies readonly HostActionName[];

type ProcedureAction = (typeof PROCEDURE_ACTIONS)[number];
type InvocationAction = Exclude<HostActionName, ProcedureAction>;

function isProcedureAction(action: HostActionName): action is ProcedureAction {
  return PROCEDURE_ACTIONS.some((procedure) => procedure === action);
}

export function describeHostActions(): Record<string, z.core.JSONSchema.BaseSchema> {
  const catalog: Record<string, z.core.JSONSchema.BaseSchema> = {};
  for (const [name, schema] of Object.entries(ACTION_SCHEMAS)) {
    const { $schema: _$schema, ...jsonSchema } = z.toJSONSchema(schema, { io: "input" });
    if (jsonSchema.hidden !== true) catalog[name] = jsonSchema;
  }
  return catalog;
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

function buildInvocation(action: InvocationAction, raw: unknown, binPath: string): Invocation {
  const serveSim = (args: string[]): Invocation => serveSimInvocation(binPath, args);
  const simctl = (args: string[]): Invocation => ({ file: "xcrun", args: ["simctl", ...args] });
  const uiGet = (option: string, p: { udid: string }): Invocation =>
    serveSim(["ui", option, "-d", p.udid]);
  const uiSet = (option: string, p: { udid: string; value: string }): Invocation =>
    serveSim(["ui", option, p.value, "-d", p.udid]);

  switch (action) {
    case "appearance.get": {
      const p = parseParams(action, raw);
      return simctl(["ui", p.udid, "appearance"]);
    }
    case "appearance.set": {
      const p = parseParams(action, raw);
      return simctl(["ui", p.udid, "appearance", p.value]);
    }
    case "hardwareKeyboard.get":
      return uiGet("hardware-keyboard", parseParams(action, raw));
    case "hardwareKeyboard.set":
      return uiSet("hardware-keyboard", parseParams(action, raw));
    case "reduceMotion.get":
      return uiGet("reduce-motion", parseParams(action, raw));
    case "reduceMotion.set":
      return uiSet("reduce-motion", parseParams(action, raw));
    case "increaseContrast.get":
      return uiGet("increase-contrast", parseParams(action, raw));
    case "increaseContrast.set":
      return uiSet("increase-contrast", parseParams(action, raw));
    case "reduceTransparency.get":
      return uiGet("reduce-transparency", parseParams(action, raw));
    case "reduceTransparency.set":
      return uiSet("reduce-transparency", parseParams(action, raw));
    case "voiceover.get":
      return uiGet("voiceover", parseParams(action, raw));
    case "voiceover.set":
      return uiSet("voiceover", parseParams(action, raw));
    case "liquidGlass.get":
      return uiGet("liquid-glass", parseParams(action, raw));
    case "liquidGlass.set":
      return uiSet("liquid-glass", parseParams(action, raw));
    case "colorFilter.get":
      return uiGet("color-filter", parseParams(action, raw));
    case "colorFilter.set":
      return uiSet("color-filter", parseParams(action, raw));
    case "textSize.get":
      return uiGet("text-size", parseParams(action, raw));
    case "textSize.set":
      return uiSet("text-size", parseParams(action, raw));
    case "showBorders.get":
      return uiGet("show-borders", parseParams(action, raw));
    case "showBorders.set":
      return uiSet("show-borders", parseParams(action, raw));
    case "settings.status": {
      const p = parseParams(action, raw);
      return serveSim(["ui", "status", "--json", "-d", p.udid]);
    }
    case "softwareKeyboard.toggle": {
      const p = parseParams(action, raw);
      return serveSim(["software-keyboard", "-d", p.udid]);
    }
    case "tap": {
      const p = parseParams(action, raw);
      return serveSim(["tap", String(p.x), String(p.y), "-d", p.udid]);
    }
    case "gesture": {
      const p = parseParams(action, raw);
      return serveSim(["gesture", JSON.stringify(p.events), "-d", p.udid]);
    }
    case "type": {
      const p = parseParams(action, raw);
      return serveSim(["type", "-d", p.udid, "--", p.text.replace(/\r\n?/g, "\n")]);
    }
    case "memoryWarning": {
      const p = parseParams(action, raw);
      return serveSim(["memory-warning", "-d", p.udid]);
    }
    case "caDebug.set": {
      const p = parseParams(action, raw);
      return serveSim(["ca-debug", p.option, p.value, "-d", p.udid]);
    }
    case "hinge.get": {
      const p = parseParams(action, raw);
      return serveSim(["hinge", "-d", p.udid]);
    }
    case "hinge.set": {
      const p = parseParams(action, raw);
      return serveSim(["hinge", String(p.value), "-d", p.udid]);
    }
    case "permissions.list": {
      const p = parseParams(action, raw);
      return serveSim(["permissions", "list", ...(p.bundleId ? [p.bundleId] : []), "-d", p.udid]);
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
    case "springboard.restart": {
      const p = parseParams(action, raw);
      return simctl([
        "spawn",
        p.udid,
        "launchctl",
        "kickstart",
        "-k",
        "system/com.apple.SpringBoard",
      ]);
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
      return simctl(["get_app_container", p.udid, p.bundleId, p.type]);
    }
    case "app.infoPlist": {
      const p = parseParams(action, raw);
      return { file: "plutil", args: ["-convert", "json", "-o", "-", p.path] };
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

async function runProcedureAsync(
  action: ProcedureAction,
  raw: unknown,
  streamSettings: StreamSettings | undefined,
  serveSimBinPath: string,
): Promise<HostActionResult> {
  switch (action) {
    case "clipboard.read":
    case "clipboard.write":
    case "clipboard.copy":
    case "clipboard.paste": {
      const p = parseParams(action, raw);
      try {
        if (action === "clipboard.read") {
          const { readSimPasteboardResult } = await import("./sim-pasteboard-reader");
          return ok(JSON.stringify(await readSimPasteboardResult(p.udid)));
        }
        if (action === "clipboard.write") {
          await writeSimPasteboard(p.udid, parseParams(action, raw).text);
          return ok(JSON.stringify({ ok: true }));
        }
        const { getDeviceSession } = await import("./device-session");
        // @ref LLP 0010#clipboard-host-actions — Copy/Paste may create the viewer's capture session first.
        const session = getDeviceSession(p.udid, streamSettings);
        if (action === "clipboard.copy") return ok(JSON.stringify(await session.copyPasteboard()));
        const cleanupWarning = await session.pastePasteboard("text" in p ? p.text : undefined);
        return ok(JSON.stringify({ ok: true, ...(cleanupWarning ? { cleanupWarning } : {}) }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { cleanupWarning } = cleanupWarningOf(error);
        return {
          stdout: "",
          stderr: redactHostPaths([message, cleanupWarning].filter(Boolean).join("\n")),
          exitCode: 1,
        };
      }
    }
    case "app.file.upload":
      return runAppFileAction("upload", parseParams(action, raw));
    case "app.file.read":
      return runAppFileAction("read", parseParams(action, raw));
    case "app.file.list":
      return runAppFileAction("list", parseParams(action, raw));
    case "app.file.remove":
      return runAppFileAction("remove", parseParams(action, raw));
    case "app.stop":
    case "app.openUrl":
    case "app.approveUrlScheme": {
      const p = parseParams(action, raw);
      try {
        if ("url" in p) await openUrlInApp(p.udid, p.bundleId, p.url);
        else if ("scheme" in p) await approveUrlScheme(p.udid, p.bundleId, p.scheme);
        else await stopApp(p.udid, p.bundleId);
        return ok();
      } catch (error) {
        return {
          stdout: "",
          stderr: redactHostPaths(error instanceof Error ? error.message : String(error)),
          exitCode: 1,
        };
      }
    }
    case "app.install": {
      const p = parseParams(action, raw);
      const path = fileSourcePath(p);
      const uploadId = "uploadId" in p ? p.uploadId : getStagedUploadId(path);
      const deadline = Date.now() + actionTimeoutMs();
      try {
        return uploadId === undefined
          ? await installAppAsync(p.udid, path, deadline, serveSimBinPath)
          : await withStagedUploadSnapshotAsync(
              uploadId,
              (source) => installAppAsync(p.udid, source, deadline, serveSimBinPath),
              deadline,
            );
      } catch (error) {
        return {
          stdout: "",
          stderr: redactHostPaths(error instanceof Error ? error.message : String(error)),
          exitCode: 1,
        };
      }
    }
    case "app.launch": {
      const { udid, bundleId, launchArgs, openUrl } = parseParams(action, raw);
      try {
        await launchApp(udid, { bundleId, launchArgs, restart: true, openUrl });
        return ok();
      } catch (error) {
        return {
          stdout: "",
          stderr: redactHostPaths(error instanceof Error ? error.message : String(error)),
          exitCode: 1,
        };
      }
    }
    case "upload.append": {
      const p = parseParams(action, raw);
      return await appendUploadChunkAsync(p);
    }
    case "upload.remove": {
      const p = parseParams(action, raw);
      return await removeUploadAsync(p.uploadId);
    }
    case "capture.reboot": {
      const p = parseParams(action, raw);
      const { rebootWithCapture } = await import("./capture");
      try {
        const meta = p.fields
          ? await rebootWithCapture(p.udid, p.enabled, {}, p.fields)
          : await rebootWithCapture(p.udid, p.enabled);
        // The device rebooted, but capture did not start: report a failed action, not a toggle.
        if (p.enabled && meta.attachment === "failed") {
          return {
            stdout: JSON.stringify(meta),
            stderr: meta.attachError ?? "Capture could not start after the reboot.",
            exitCode: 1,
          };
        }
        return ok(JSON.stringify(meta));
      } catch (error) {
        return {
          stdout: "",
          stderr:
            `Could not reboot the device: ${error instanceof Error ? error.message : String(error)}. ` +
            "The device may now be shut down, so boot it from the sidebar and try again.",
          exitCode: 1,
        };
      }
    }
    case "capture.enable": {
      const p = parseParams(action, raw);
      const { captureRuntime } = await import("./capture");
      try {
        const meta = await captureRuntime.enableForDevice(p.udid, p.fields);
        captureRuntime.setDeviceCaptureEnabled(p.udid, true);
        return ok(JSON.stringify(meta));
      } catch (error) {
        return {
          stdout: "",
          stderr: `Could not enable network capture: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: 1,
        };
      }
    }
    case "capture.fields": {
      const p = parseParams(action, raw);
      const { captureRuntime } = await import("./capture");
      const meta = captureRuntime.setFieldsForDevice(p.udid, p.fields);
      if (!meta) {
        // The device's meta tells a caller that capture is off, not that the change failed.
        return {
          stdout: JSON.stringify(captureRuntime.metaFor(p.udid)),
          stderr: "Network capture is not on for this device. Enable it first.",
          exitCode: 1,
        };
      }
      return ok(JSON.stringify(meta));
    }
    case "capture.clear": {
      const p = parseParams(action, raw);
      const { captureRuntime } = await import("./capture");
      if (!captureRuntime.clearForDevice(p.udid)) {
        return { stdout: "", stderr: "No capture session for this device.", exitCode: 1 };
      }
      return ok();
    }
    case "capture.body": {
      const p = parseParams(action, raw);
      const { captureRuntime } = await import("./capture");
      const store = captureRuntime.storeFor(p.udid);
      const body = store?.body(p.id);
      if (body) return ok(JSON.stringify(body));
      // Tell a body dropped for the memory budget apart from one that was never kept.
      return ok(store?.bodyDropped(p.id) ? JSON.stringify({ dropped: true }) : "");
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
      let failure = "Could not resolve that simulator. Specify a booted simulator UDID.";
      try {
        const { resolveBootedDeviceAsync } = await import("./device");
        const { getScreenshotDisplayIdsAsync } = await import("./screenshot-display");
        p.udid = await resolveBootedDeviceAsync(p.udid);
        const capture = (display: number, read?: () => Promise<number>) =>
          captureScreenshotAsync(
            { udid: p.udid, fileName: p.fileName ?? newScreenshotName(), display },
            read,
          );
        failure = "Could not capture the screenshot. Check the host logs for details.";
        if (p.display !== undefined) {
          const ids = await getScreenshotDisplayIdsAsync(p.udid);
          if (ids && !ids.includes(p.display))
            return {
              stdout: "",
              exitCode: 1,
              stderr: `Display ${p.display} is not a device screen on this simulator. Choose ${ids.join(" or ")}.`,
            };
          return await capture(p.display);
        }
        const { withScreenshotDeviceSession } = await import("./device-session");
        failure =
          "Could not start screenshot capture. Check that the simulator is booted and check the host logs.";
        let selected = false;
        try {
          return await withScreenshotDeviceSession(p.udid, streamSettings, async (session) => {
            const read = async () => {
              failure =
                "Could not determine the active display. Check that the simulator is booted, then retry or specify a display ID.";
              const display = await session.activeScreenId();
              failure = "Could not capture the screenshot. Check the host logs for details.";
              return display;
            };
            const display = await read();
            selected = true;
            return await capture(display, read);
          });
        } catch (error) {
          // @ref LLP 0003#action-catalog — only a proven sole screen can bypass native election
          const ids = !selected ? await getScreenshotDisplayIdsAsync(p.udid) : null;
          if (ids?.length !== 1) throw error;
          console.error(
            "Native screenshot selection unavailable; using the sole device screen:",
            error,
          );
          failure = "Could not capture the screenshot. Check the host logs for details.";
          return await capture(ids[0]!);
        }
      } catch (error) {
        console.error("Screenshot capture failed:", error);
        return {
          stdout: "",
          stderr: error instanceof HostActionTimeoutError ? error.message : failure,
          exitCode: 1,
        };
      }
    }
    case "actions.describe":
      parseParams(action, raw);
      return ok(JSON.stringify(describeHostActions()));
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
  streamSettings?: StreamSettings,
): Promise<HostActionResult> {
  const { action, params } = msg;
  if (typeof action !== "string" || !isHostActionName(action)) {
    throw new InvalidHostActionError(`unknown action ${String(action)}`);
  }
  const result = isProcedureAction(action)
    ? await runProcedureAsync(action, params, streamSettings, binPath)
    : await runInvocation(buildInvocation(action, params, binPath));
  // exec-ws spreads this straight into the reply, so only the three fields the page reads leave
  // the process. `timedOut` steers the message a handler composes; the page has no use for it.
  const { stdout, stderr, exitCode } = result;
  return { stdout, stderr, exitCode };
}
