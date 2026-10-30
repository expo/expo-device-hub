import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openUrlInApp } from "../launch-manager";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { useTempStateDir } from "./helpers";

const PKG_DIR = join(import.meta.dir, "../..");
const CLI = join(PKG_DIR, "dist/serve-sim.js");
const FIXTURE = join(PKG_DIR, "dist/capability-loader/ServeSimLaunchFixture.app");
const APP = "dev.expo.serve-sim.launch-fixture";
const udid = e2eDevice();
const ready = udid !== null && existsSync(CLI) && existsSync(FIXTURE);
requireE2E("camera scanner", ready);

const scratch = mkdtempSync(join(tmpdir(), "serve-sim-camera-scanner-"));
// The camera helper keeps its pid and socket in the state folder.
const stateDir = useTempStateDir();

function simctl(args: string[]): string {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function camera(args: string[]): string {
  // Bun's execFileSync ignores later process.env changes, so pass the private state folder.
  return execFileSync("node", [CLI, "camera", ...args, "-d", udid!, "--quiet"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: process.env,
  });
}

// What the fixture recorded about its camera, as [kind, pid, detail].
// get_app_container takes about half a second, so look the container up once.
let container: string | undefined;
function cameraRecords(): string[][] {
  try {
    container ??= simctl(["get_app_container", udid!, APP, "data"]).trim();
    return readFileSync(join(container, "Documents/launches.tsv"), "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("camera-"))
      .map((line) => line.split("\t"));
  } catch {
    return [];
  }
}

// The detail of the first record of `kind` from the app process `pid`.
async function waitForRecord(kind: string, pid: number): Promise<string | undefined> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const record = cameraRecords().find(([k, p]) => k === kind && p === String(pid));
    if (record) return record[2];
    await Bun.sleep(250);
  }
  return undefined;
}

// A 24-bit BMP whose columns have the given grey levels, the same in every row.
function writeBmp(name: string, columns: number[], height: number): string {
  const rowBytes = Math.ceil((columns.length * 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + rowBytes * height);
  bmp.write("BM");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(columns.length, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(rowBytes * height, 34);
  for (let y = 0; y < height; y++) {
    columns.forEach((grey, x) =>
      bmp.fill(grey, 54 + y * rowBytes + x * 3, 57 + y * rowBytes + x * 3),
    );
  }
  const path = join(scratch, name);
  writeFileSync(path, bmp);
  return path;
}

// EAN-13 digit codes: the left-hand odd-parity (L) codes for 0-9, and which
// left-hand digits use the even-parity (G) codes, chosen by the first digit.
const EAN_L = "0001101 0011001 0010011 0111101 0100011 0110001 0101111 0111011 0110111 0001011";
const EAN_PARITY = "LLLLLL LLGLGG LLGGLG LLGGGL LGLLGG LGGLLG LGGGLL LGLGLG LGLGGL LGGLGL";

// EAN-13 5901234123457 as bars, 4 px per module, with a 12-module quiet zone.
function ean13Bars(): number[] {
  const digits = [..."5901234123457"].map(Number);
  const L = EAN_L.split(" ");
  const R = L.map((code) => code.replace(/./g, (bit) => (bit === "0" ? "1" : "0")));
  const G = R.map((code) => [...code].reverse().join(""));
  const parity = EAN_PARITY.split(" ")[digits[0]!]!;
  let modules = "101";
  for (let i = 1; i <= 6; i++) modules += (parity[i - 1] === "L" ? L : G)[digits[i]!];
  modules += "01010";
  for (let i = 7; i <= 12; i++) modules += R[digits[i]!];
  modules = `${"0".repeat(12)}${modules}101${"0".repeat(12)}`;
  return [...modules].flatMap((bit) => Array<number>(4).fill(bit === "1" ? 0 : 0xff));
}

beforeAll(() => {
  if (!ready) return;
  try {
    simctl(["uninstall", udid!, APP]);
  } catch {}
  simctl(["install", udid!, FIXTURE]);
}, 60_000);

afterAll(() => {
  try {
    if (!ready) return;
    try {
      camera(["--stop-webcam"]);
    } catch {}
    try {
      simctl(["uninstall", udid!, APP]);
    } catch {}
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    stateDir.restore();
  }
}, 60_000);

test.skipIf(!ready)(
  "an app survives closing a barcode scanner that reads the injected camera",
  async () => {
    const grey = writeBmp("grey.bmp", [0x80, 0x80, 0x80, 0x80], 4);
    const { pid } = JSON.parse(camera([APP, "--file", grey])) as { pid: number };
    await openUrlInApp(udid!, APP, "serve-sim-fixture://camera/open");
    expect(await waitForRecord("camera-open", pid)).toStartWith(
      "Simulated Camera Back (serve-sim)",
    );

    await openUrlInApp(udid!, APP, "serve-sim-fixture://camera/close");
    // Releasing the metadata output used to release a fake AVCaptureConnection
    // into AVFoundation's -dealloc, which crashed the app (SIGSEGV). A crashed
    // app records nothing more.
    expect(await waitForRecord("camera-alive", pid)).toBe("output-released");
  },
  60_000,
);

test.skipIf(!ready)(
  "delivers a barcode in the injected feed to the scanner",
  async () => {
    const barcode = writeBmp("ean13.bmp", ean13Bars(), 240);
    const { pid } = JSON.parse(camera([APP, "--file", barcode, "--mirror", "off"])) as {
      pid: number;
    };
    await openUrlInApp(udid!, APP, "serve-sim-fixture://camera/open");
    // The fixture reads the code through the preview layer, as expo-camera
    // does. The frame fills the layer aspect-fill, so a centred code stays centred.
    const code = await waitForRecord("camera-code", pid);
    expect(code).toStartWith("org.gs1.EAN-13 5901234123457 center=");
    const [x, y] = code!.split("center=")[1]!.split(",").map(Number);
    expect(Math.abs(x! - 0.5)).toBeLessThan(0.05);
    expect(Math.abs(y! - 0.5)).toBeLessThan(0.05);

    await openUrlInApp(udid!, APP, "serve-sim-fixture://camera/close");
    expect(await waitForRecord("camera-alive", pid)).toBe("output-released");
  },
  60_000,
);
