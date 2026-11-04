#!/usr/bin/env node
// expo-emulator-capture: launch an Android Emulator with the capture agent
// preloaded, or record its capture socket to an H.264 file.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FLAGS, KEY_FRAME_COMMAND, RecordReader, settingsCommand } from "./protocol.mjs";
import { agentLibraryPath, defaultSocketPath } from "./paths.mjs";

const USAGE = `Usage:
  expo-emulator-capture launch [--socket <path>] [--log <path>] [--emulator <path>] -- <emulator args>
  expo-emulator-capture record --socket <path> --output <file.h264> [--seconds 10]
                               [--fps 60] [--max-size 0] [--bit-rate 12000000]
  expo-emulator-capture socket-path --port <console port>

launch starts the emulator with the capture agent preloaded. Pass -port to the
emulator, or --socket, so the socket path is known. Use -gpu host for the GPU
frame path; software renderers use CPU readback.`;

function fail(message) {
  console.error(`[expo-emulator-capture] ${message}`);
  process.exit(1);
}

function requireSupportedHost() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    fail("capture requires macOS on Apple silicon (darwin-arm64).");
}

function emulatorBinary(explicit) {
  if (explicit) return explicit;
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
  ];
  for (const root of roots) {
    const candidate = root && join(root, "emulator", "emulator");
    if (candidate && existsSync(candidate)) return candidate;
  }
  fail("cannot find the Android Emulator; set ANDROID_HOME or pass --emulator.");
}

function launch(argv) {
  requireSupportedHost();
  const separator = argv.indexOf("--");
  const own = separator < 0 ? argv : argv.slice(0, separator);
  const emulatorArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const { values } = parseArgs({
    args: own,
    options: { socket: { type: "string" }, log: { type: "string" }, emulator: { type: "string" } },
  });
  const portIndex = emulatorArgs.indexOf("-port");
  const port = portIndex >= 0 ? Number(emulatorArgs[portIndex + 1]) : null;
  const socket = values.socket ?? (port ? defaultSocketPath(`emulator-${port}`) : null);
  if (!socket) fail("pass -port to the emulator or --socket so the capture socket path is known.");
  const library = agentLibraryPath();
  if (!existsSync(library))
    fail(`agent library missing at ${library}; run the package build first.`);
  // Spawn the emulator directly: a shell or another SIP-protected binary in
  // between strips DYLD_* variables, and the agent would not load.
  const child = spawn(emulatorBinary(values.emulator), emulatorArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      DYLD_INSERT_LIBRARIES: library,
      EXPO_EMULATOR_CAPTURE_SOCKET: socket,
      ...(values.log ? { EXPO_EMULATOR_CAPTURE_LOG: values.log } : {}),
    },
  });
  console.error(`[expo-emulator-capture] capture socket: ${socket}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (child.exitCode === null) child.kill(signal);
    });
  child.on("error", (error) => fail(error.message));
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}

function integer(name, text, fallback) {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value)) fail(`--${name} must be an integer`);
  return value;
}

function record(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      socket: { type: "string" },
      output: { type: "string" },
      seconds: { type: "string" },
      fps: { type: "string" },
      "max-size": { type: "string" },
      "bit-rate": { type: "string" },
    },
  });
  if (!values.socket || !values.output) fail("record needs --socket and --output");
  const seconds = Number(values.seconds ?? 10);
  const settings = {
    fps: integer("fps", values.fps, 60),
    maxSize: integer("max-size", values["max-size"], 0),
    bitRate: integer("bit-rate", values["bit-rate"], 12_000_000),
  };
  const output = createWriteStream(values.output);
  const stats = { frames: 0, keyFrames: 0, bytes: 0, resizes: 0, firstPts: null, lastPts: null };
  const socket = createConnection(values.socket);
  const reader = new RecordReader((entry) => {
    if (entry.flags === FLAGS.hello) {
      console.log(`hello: native ${entry.width}x${entry.height}@${entry.fps} ${entry.payload}`);
      socket.write(settingsCommand(settings));
    } else if (entry.flags === FLAGS.resized) {
      stats.resizes++;
      console.log(`resized: native ${entry.width}x${entry.height}`);
    } else if (entry.flags === FLAGS.configured) {
      console.log(
        `configured: stream ${entry.width}x${entry.height}@${entry.fps} ${entry.payload}`,
      );
    } else if (entry.flags === FLAGS.frame || entry.flags === FLAGS.keyFrame) {
      stats.frames++;
      if (entry.flags === FLAGS.keyFrame) stats.keyFrames++;
      stats.bytes += entry.payload.length;
      stats.firstPts ??= entry.pts;
      stats.lastPts = entry.pts;
      output.write(entry.payload);
    } else {
      throw new Error(`unknown record flags ${entry.flags}`);
    }
  });
  socket.on("data", (chunk) => {
    try {
      reader.push(chunk);
    } catch (error) {
      fail(error.message);
    }
  });
  socket.on("error", (error) => fail(`capture socket: ${error.message}`));
  const keyTimer = setInterval(() => socket.write(KEY_FRAME_COMMAND), 5000);
  setTimeout(() => {
    clearInterval(keyTimer);
    socket.end();
    output.end(() => {
      const spanUs = stats.lastPts !== null ? Number(stats.lastPts - stats.firstPts) : 0;
      const fps = spanUs > 0 ? ((stats.frames - 1) * 1e6) / spanUs : 0;
      console.log(
        JSON.stringify({
          ...stats,
          firstPts: undefined,
          lastPts: undefined,
          measuredFps: +fps.toFixed(2),
        }),
      );
    });
  }, seconds * 1000);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "launch") launch(rest);
else if (command === "record") record(rest);
else if (command === "socket-path") {
  const { values } = parseArgs({ args: rest, options: { port: { type: "string" } } });
  if (!values.port) fail("socket-path needs --port");
  console.log(defaultSocketPath(`emulator-${values.port}`));
} else {
  console.log(USAGE);
  process.exitCode = command === undefined || command === "--help" ? 0 : 1;
}
