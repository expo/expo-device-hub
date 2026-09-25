import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { findBootedDevice, resolveDevice } from "./device";
import { setCapabilityEnabled } from "./launch-manager";
import { locateCameraHelper, buildCameraHelper, shmNameForUdid } from "./camera-runtime";
import { detectMediaKind, resolveSourceArg, type ResolvedSource } from "./camera-media";
import {
  isCameraHelperAlive as isHelperAlive,
  readCameraStatus,
  readCameraHelperPid,
  sendCameraHelperCommand as sendHelperCommand,
} from "./camera-helper";

export async function camera(args: string[]) {
  let deviceArg: string | undefined;
  let filePath: string | undefined;
  let webcam: string | true | undefined;
  let stopWebcam = false;
  let listWebcams = false;
  let forceBuild = false;
  let quiet = false;
  let mirror: "auto" | "on" | "off" = "auto";
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--device" || a === "-d") { deviceArg = args[++i]; continue; }
    if (a === "--file" || a === "-f" || a === "--image" || a === "-i" || a === "--video") {
      // --image / --video are kept as silent aliases so existing scripts
      // and the in-page client can land on `--file` without a flag day.
      filePath = args[++i];
      continue;
    }
    if (a === "--webcam") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) { webcam = next; i++; }
      else { webcam = true; }
      continue;
    }
    if (a === "--list-webcams") { listWebcams = true; continue; }
    if (a === "--stop-webcam") { stopWebcam = true; continue; }
    if (a === "--build") { forceBuild = true; continue; }
    if (a === "--restart") {
      console.error("Camera controls no longer restart apps. Open the app normally after starting the serve-sim session.");
      process.exit(1);
    }
    if (a === "--quiet" || a === "-q") { quiet = true; continue; }
    if (a === "--mirror") {
      const next = args[i + 1];
      if (next === "on" || next === "off" || next === "auto") {
        mirror = next; i++;
      } else {
        mirror = "on";
      }
      continue;
    }
    if (a === "--no-mirror") { mirror = "off"; continue; }
    if (a === "--help" || a === "-h") {
      console.log(`Usage: serve-sim camera enable [-d udid] [source-options] [--build]
       serve-sim camera switch <placeholder|webcam|file> [arg] [-d udid]
       serve-sim camera mirror <auto|on|off> [-d udid]
       serve-sim camera --list-webcams
       serve-sim camera disable [-d udid]

Enables one synthetic camera feed for all apps on the simulator. Start a
serve-sim session before opening apps so they carry the capability loader.
Enable, disable, source changes, and mirroring never restart apps or change
camera permissions. Disable disconnects the camera in running apps.

Source options (pick one; default is placeholder):
  -f, --file <path>          Image or video file (kind auto-detected)
      --webcam [name]        Live host webcam (default: built-in front camera)

Other:
  -d, --device <udid|name>   Target a specific simulator (default: booted)
      --mirror [on|off|auto] Override preview mirroring (default: auto =
                             front mirrored, back not). Data-output buffers
                             are never auto-mirrored, matching AVF defaults.
      --no-mirror            Shortcut for --mirror off
      --build                Rebuild dylib + helper from source
      --list-webcams         List host camera devices (with --webcam values)
      --stop-webcam          Stop the running camera helper for the device
  -q, --quiet                JSON-only output

Examples:
  serve-sim camera enable                            # placeholder feed
  serve-sim camera enable --webcam                   # default webcam
  serve-sim camera enable --webcam "MacBook Pro Camera"
  serve-sim camera enable --file ~/Pictures/face.png # static image
  serve-sim camera enable --file ~/Movies/loop.mp4   # looping video
  serve-sim camera switch webcam                             # hot-swap to webcam
  serve-sim camera switch placeholder                        # back to placeholder
  serve-sim camera switch ~/Movies/loop.mp4                  # hot-swap to file
  serve-sim camera --list-webcams
  serve-sim camera --stop-webcam`);
      return;
    }
    filtered.push(a!);
  }

  if (listWebcams) {
    const helper = locateCameraHelper() ?? buildCameraHelper();
    execFileSync(helper, ["--list"], { stdio: "inherit" });
    return;
  }

  if (stopWebcam || filtered[0] === "disable") {
    const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
    if (!udid) { console.error("No booted simulator."); process.exit(1); }
    await setCapabilityEnabled(udid, "camera", { enabled: false, relaunch: false });
    if (quiet) console.log(JSON.stringify({ udid, stopped: true, enabled: false }));
    else console.log(`Camera disconnected on ${udid}`);
    return;
  }

  // `serve-sim camera mirror <auto|on|off> [-d udid]`
  // Hot-swap the preview-layer mirror mode without touching the app.
  if (filtered[0] === "mirror") {
    const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
    if (!udid) { console.error("No booted simulator."); process.exit(1); }
    const mode = filtered[1];
    if (mode !== "auto" && mode !== "on" && mode !== "off") {
      console.error("Usage: serve-sim camera mirror <auto|on|off> [-d udid]");
      process.exit(1);
    }
    if (!isHelperAlive(udid)) {
      console.error("camera helper not running for this device — run `serve-sim camera enable` first.");
      process.exit(1);
    }
    try {
      const reply = await sendHelperCommand(udid, { action: "setMirror", mode });
      if (!reply.ok) {
        console.error(`mirror failed: ${reply.error ?? "?"}`);
        process.exit(1);
      }
      if (quiet) console.log(JSON.stringify({ udid, mirror: mode, ok: true }));
      else console.log(`📷 Mirror → ${mode} on ${udid}`);
    } catch (e: any) {
      console.error(`mirror failed: ${e?.message ?? e}`);
      process.exit(1);
    }
    return;
  }

  // `serve-sim camera switch <source> [arg] [-d udid]`
  // Hot-swap the helper's source without touching the simulator app.
  if (filtered[0] === "switch") {
    const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
    if (!udid) { console.error("No booted simulator."); process.exit(1); }
    let wanted = filtered[1];
    let arg: string | undefined = filtered[2];
    // `camera switch /path/to/clip.mov` — sniff the file and pick the kind.
    if (wanted && wanted !== "placeholder" && wanted !== "webcam"
        && wanted !== "image" && wanted !== "video"
        && wanted !== "file") {
      const candidate = resolve(wanted);
      if (existsSync(candidate)) { arg = candidate; wanted = "file"; }
    }
    if (wanted === "file") {
      if (!arg) {
        console.error("camera switch file <path>");
        process.exit(1);
      }
      arg = resolve(arg);
      const detected = detectMediaKind(arg);
      if (!detected) {
        console.error(`Could not detect image/video type for: ${arg}`);
        process.exit(1);
      }
      wanted = detected;
    }
    if (!wanted || (wanted !== "placeholder" && wanted !== "webcam" && wanted !== "image" && wanted !== "video")) {
      console.error("Usage: serve-sim camera switch <placeholder|webcam|file> [arg] [-d udid]");
      process.exit(1);
    }
    if ((wanted === "image" || wanted === "video") && arg) arg = resolve(arg);
    if (!isHelperAlive(udid)) {
      console.error("camera helper not running for this device — run `serve-sim camera enable` first.");
      process.exit(1);
    }
    try {
      const reply = await sendHelperCommand(udid, { action: "switch", source: wanted, arg });
      if (!reply.ok) {
        console.error(`switch failed: ${reply.error ?? "?"}`);
        process.exit(1);
      }
      if (quiet) console.log(JSON.stringify({ udid, ...reply }));
      else console.log(`📷 Switched ${udid} → ${reply.source}${reply.arg ? ` (${reply.arg})` : ""}`);
    } catch (e: any) {
      console.error(`switch failed: ${e?.message ?? e}`);
      process.exit(1);
    }
    return;
  }

  // `serve-sim camera status [-d udid]` — JSON probe for scripts and humans.
  // The preview UI reads the same shared implementation through middleware.
  if (filtered[0] === "status") {
    const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
    if (!udid) {
      console.log(JSON.stringify({ alive: false, error: "no booted simulator" }));
      return;
    }
    console.log(JSON.stringify(await readCameraStatus(udid)));
    return;
  }

  // Everything else already returned, so a leftover word is a typo, not a request to enable.
  // `camera <bundle-id>` was the old way to enable; the camera is device-wide now.
  const legacyBundleId = filtered.length === 1 && /^[\w-]+(\.[\w-]+){2,}$/.test(filtered[0]!);
  if (filtered.length > 1 || (filtered.length === 1 && filtered[0] !== "enable" && !legacyBundleId)) {
    const what = filtered.length === 1 ? ` '${filtered[0]}'` : "";
    console.error(
      `Unknown camera command${what}. Use enable, disable, switch, mirror, status, ` +
        "--list-webcams, or --stop-webcam. `camera enable [-d udid] [--file path]` enables the device-wide camera.",
    );
    process.exit(1);
  }

  const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
  if (!udid) {
    console.error("No booted simulator. Boot one or pass -d <udid|name>.");
    process.exit(1);
  }

  if (filePath && webcam) {
    console.error("Pick one source: --file or --webcam, not both.");
    process.exit(1);
  }

  if (filePath) {
    filePath = resolve(filePath);
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
  }

  // Default source is the animated placeholder. The helper always runs so
  // the dylib reads from a single shm wire format regardless of source.
  let source: ResolvedSource;
  try {
    source = resolveSourceArg({ file: filePath, webcam });
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  const wasStreaming = isHelperAlive(udid);
  try {
    await setCapabilityEnabled(udid, "camera", {
      bundleId: null,
      ownerPid: null,
      relaunch: false,
      options: {
        kind: source.kind,
        ...(source.arg ? { arg: source.arg } : {}),
        mirror,
        ...(forceBuild ? { forceBuild: "1" } : {}),
      },
      enabled: true,
    });
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  const shmName = shmNameForUdid(udid);
  const helperPid = readCameraHelperPid(udid);

  // Mirror lives in the shm header so it can hot-swap. Push every time: a fresh helper
  // starts at UNSET, which keeps whatever mode the injector had before.
  try {
    await sendHelperCommand(udid, { action: "setMirror", mode: mirror });
  } catch {} // non-fatal; dylib falls back to env or default

  const result = {
    udid,
    enabled: true,
    source: source.kind,
    arg: source.arg ?? null,
    shm: shmName,
    helperPid,
    mirror,
    hotSwapped: false,
    helperRelaunched: !wasStreaming,
  };
  if (quiet) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`Camera enabled for all apps on ${udid}`);
    console.log(`   source: ${source.kind}${source.arg ? ` (${source.arg})` : ""}`);
    if (helperPid) console.log(`   helper pid: ${helperPid}  (shm ${shmName})`);
  }
}
