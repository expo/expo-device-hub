#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { pickDevice } from "./adb.ts";
import { listAvds, listRunningAvds, startEmulator } from "./emulator.ts";
import { startServer } from "./server.ts";

const argv = Bun.argv.slice(2);
const { values } = parseArgs({
  args: argv,
  options: {
    port: { type: "string", short: "p", default: "3300" },
    serial: { type: "string", short: "s" },
    "max-fps": { type: "string", default: "30" },
    "bit-rate": { type: "string", default: "8000000" },
    // 1280 caps the long edge while staying a clean multiple for common
    // 1080-wide devices (1080→576), so scrcpy doesn't pad the encode width and
    // bake in black letterbox columns the way 1024 (→460.8, rounded to 464) did.
    "max-size": { type: "string", default: "1280" },
    "key-frame-interval": { type: "string", default: "1" },
    avd: { type: "string" },
    "avd-list": { type: "boolean" },
    "running-avds": { type: "boolean" },
    "restart-avd": { type: "boolean" },
    emulator: { type: "string" },
    "emulator-port": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

function numberOption(name: string, fallback: number): number {
  const value = values[name as keyof typeof values];
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number.`);
  return n;
}

if (values.help) {
  console.log(`serve-emu — host an Android device over scrcpy + WebSocket

Usage:
  serve-emu [-p <port>] [-s <serial>] [--max-fps N] [--bit-rate N] [--max-size N] [--key-frame-interval sec]
  serve-emu --avd <name> [--restart-avd]
  serve-emu --avd-list
  serve-emu --running-avds

Options:
  -p, --port <port>      Port to listen on (default: 3300)
  -s, --serial <serial>  adb device serial (defaults to the only booted device)
      --max-fps <n>      Cap source frame rate (default: 30)
      --bit-rate <bps>   H.264 bit rate (default: 8000000)
      --max-size <px>    Cap longest screen edge in pixels; 0 = native, but many
                         emulators reject native resolutions above ~2560 so this
                         defaults to 1280.
      --key-frame-interval <sec>
                         Ask the encoder for regular keyframes; 0 disables this
                         codec option (default: 1)
      --avd <name>       Launch this Android Virtual Device before streaming
      --restart-avd      Stop a running matching AVD before launching it
      --avd-list         Print available Android Virtual Device names
      --running-avds     Print currently running emulator AVDs
      --emulator <path>  Android Emulator binary (default: PATH or Android SDK)
      --emulator-port <n>
                         Emulator console port for --avd (even 5554-5682)
  -h, --help             Show this help
`);
  process.exit(0);
}

async function main() {
  if (values["avd-list"]) {
    console.log(listAvds(values.emulator).join("\n"));
    return;
  }

  if (values["running-avds"]) {
    const running = listRunningAvds();
    console.log(running.length ? running.map((avd) => `${avd.serial}\t${avd.avd}\t${avd.state}`).join("\n") : "");
    return;
  }

  if ((values["emulator-port"] || values["restart-avd"]) && !values.avd) {
    throw new Error("--emulator-port and --restart-avd require --avd.");
  }

  if (values.avd && values.serial) {
    throw new Error("Use either --avd to launch an emulator or --serial to attach to an existing device, not both.");
  }

  let emulatorLaunch: Awaited<ReturnType<typeof startEmulator>> | null = null;
  const serial = values.avd
    ? (emulatorLaunch = await startEmulator({
        avd: values.avd,
        emulatorPath: values.emulator,
        port: values["emulator-port"] ? Number(values["emulator-port"]) : undefined,
        restartAvd: values["restart-avd"],
      })).serial
    : pickDevice(values.serial);
  const port = Number(values.port);
  const maxFps = numberOption("max-fps", 30);
  const bitRate = numberOption("bit-rate", 8_000_000);
  const maxSize = numberOption("max-size", 1280);
  const keyFrameInterval = numberOption("key-frame-interval", 1);

  const { server, stop: stopServer } = await startServer({
    serial,
    port,
    maxFps,
    bitRate,
    maxSize,
    keyFrameInterval,
  }).catch((err) => {
    emulatorLaunch?.stop();
    throw err;
  });

  const stop = () => {
    stopServer();
    emulatorLaunch?.stop();
  };
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  console.log(`serve-emu → http://localhost:${server.port}  (device: ${serial})`);
}

await main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
