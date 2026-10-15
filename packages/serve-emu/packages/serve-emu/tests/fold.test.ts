import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFoldRequest, getFoldStatus, setFoldPosture, setHingeAngle } from "../src/fold.ts";
import type { ExecResult } from "../src/exec.ts";

function result(stdout: string, status = 0): ExecResult<string> {
  return { status, stdout, stderr: "", signal: null, timedOut: false, error: null };
}

/** pixel_fold's `hw.sensor.hinge_angles_posture_definitions=0-30, 30-150, 150-180`. */
function pixelFoldPosture(angle: number): string {
  return angle < 30 ? "CLOSED" : angle < 150 ? "HALF_OPENED" : "OPENED";
}

/** An angle as Android prints it: in eighths of a degree, as a Java float. */
function androidAngle(angle: number): string {
  const eighths = Math.round(angle * 8) / 8;
  return Number.isInteger(eighths) ? eighths.toFixed(1) : String(eighths);
}

/** The parts of `dumpsys device_state` that Emulator 37.2.12 (API 37) prints for pixel_fold. */
function deviceStateDump(angle: number, pending = false, reported = androidAngle(angle)): string {
  const state = (name: string) =>
    `Optional[DeviceState{identifier=1, name='${name}', app_accessible=true}]`;
  return [
    "DEVICE STATE MANAGER (dumpsys device_state)",
    `  mCommittedState=${state(pixelFoldPosture(angle))}`,
    `  mPendingState=${pending ? state(pixelFoldPosture(angle)) : "Optional.empty"}`,
    `  mBaseState=${state(pixelFoldPosture(angle))}`,
    "DeviceStateProviderImpl",
    "  Sensor values:",
    `   - Goldfish hinge sensor0 (in degrees) : [${reported}]`,
  ].join("\n");
}

const PIXEL_FOLD_RANGE = { min: 0, max: 180 };
let avdDirs: { pixelFold: string; foldOut: string };

beforeAll(async () => {
  // The `hardware-qemu.ini` an emulator writes at launch, for pixel_fold and the SDK's 8" Fold-out.
  const avd = async (ranges: string) => {
    const dir = await mkdtemp(join(tmpdir(), "serve-emu-fold-"));
    await writeFile(
      join(dir, "hardware-qemu.ini"),
      `hw.sensor.hinge = true\nhw.sensor.hinge.ranges = ${ranges}\n`,
    );
    return dir;
  };
  avdDirs = { pixelFold: await avd("0-180"), foldOut: await avd("180-360") };
});

afterAll(async () => {
  for (const dir of Object.values(avdDirs)) await rm(dir, { recursive: true, force: true });
});

/** The console's answer to `emu avd path`. */
function avdPath(dir: string): ExecResult<string> {
  return result(`${dir}\r\nOK`);
}

describe("Android emulator fold controls", () => {
  test("reads physical state and confirms fold and unfold without touching gRPC", async () => {
    let posture = "OPENED";
    let angle = 180;
    const commands: string[] = [];
    const runExec = async (_cmd: string, args: string[]) => {
      expect(args.slice(0, 2)).toEqual(["-s", "emulator-5554"]);
      const command = args.slice(2).join(" ");
      commands.push(command);
      if (command === "emu sensor get hinge-angle0") return result(`hinge-angle0 = ${angle}\r\nOK`);
      if (command === "emu avd path") return avdPath(avdDirs.pixelFold);
      if (command === "shell cmd device_state base-state") {
        return result(`Committed state: DeviceState{identifier=2, name='${posture}'}`);
      }
      if (command === "emu fold" || command === "emu unfold") {
        posture = command === "emu fold" ? "CLOSED" : "OPENED";
        angle = command === "emu fold" ? 0 : 180;
        return result("OK");
      }
      throw new Error(`unexpected command: ${command}`);
    };

    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: true, posture: "opened", hingeAngle: 180, hingeRange: PIXEL_FOLD_RANGE,
    });
    expect(await setFoldPosture("emulator-5554", "closed", runExec)).toEqual({
      supported: true, posture: "closed", hingeAngle: 0, hingeRange: PIXEL_FOLD_RANGE,
    });
    expect(await setFoldPosture("emulator-5554", "opened", runExec)).toEqual({
      supported: true, posture: "opened", hingeAngle: 180, hingeRange: PIXEL_FOLD_RANGE,
    });
    expect(commands).toContain("emu fold");
    expect(commands).toContain("emu unfold");
    // The range comes from the launch config, so a change reads it once, not while confirming.
    expect(commands.filter((command) => command === "emu avd path")).toHaveLength(3);
    expect(commands.every((command) => !command.includes("grpc"))).toBe(true);
  });

  test("does not issue fold commands on unsupported devices", async () => {
    const commands: string[] = [];
    const runExec = async (_cmd: string, args: string[]) => {
      commands.push(args.slice(2).join(" "));
      return result("KO: unknown sensor name: hinge-angle0");
    };
    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: false, posture: null, hingeAngle: null, hingeRange: null,
    });
    await expect(setFoldPosture("emulator-5554", "closed", runExec))
      .rejects.toThrow("does not support folding");
    expect(commands).toEqual(["emu sensor get hinge-angle0", "emu sensor get hinge-angle0"]);
    expect(await getFoldStatus("physical-1", async () => {
      throw new Error("must not run adb");
    })).toEqual({ supported: false, posture: null, hingeAngle: null, hingeRange: null });
  });

  test("reports a disabled hinge sensor as unsupported", async () => {
    const commands: string[] = [];
    const runExec = async (_cmd: string, args: string[]) => {
      commands.push(args.slice(2).join(" "));
      return result("KO: 'hinge-angle0' sensor is disabled.\r\n");
    };
    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: false, posture: null, hingeAngle: null, hingeRange: null,
    });
    await expect(setFoldPosture("emulator-5554", "closed", runExec))
      .rejects.toThrow("does not support folding");
    expect(commands).toEqual(["emu sensor get hinge-angle0", "emu sensor get hinge-angle0"]);
  });

  test("uses the hinge angle when Android does not report a physical state", async () => {
    const runExec = async (_cmd: string, args: string[]) =>
      args.includes("sensor")
        ? result("hinge-angle0 = 0\r\nOK")
        : result("Unknown command: device_state", 1);
    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: true, posture: "closed", hingeAngle: 0, hingeRange: null,
    });
  });

  test("does not confuse a failed sensor read with an unsupported device", async () => {
    const runExec = async () => result("", 1);
    await expect(getFoldStatus("emulator-5554", runExec))
      .rejects.toThrow("hinge sensor read failed");
    await expect(setFoldPosture("emulator-5554", "closed", runExec))
      .rejects.toThrow("hinge sensor read failed");
  });

  test("honors a named tent posture even at an extreme hinge angle", async () => {
    const runExec = async (_cmd: string, args: string[]) =>
      args.includes("sensor")
        ? result("hinge-angle0 = 180\r\nOK")
        : result("Committed state: DeviceState{identifier=4, name='TENT'}");
    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: true, posture: "tent", hingeAngle: 180, hingeRange: null,
    });
  });

  test("reads the physical posture while an app holds an override state", async () => {
    let posture = "OPENED";
    const runExec = async (_cmd: string, args: string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "emu sensor get hinge-angle0") {
        return result(`hinge-angle0 = ${posture === "CLOSED" ? 0 : 180}\r\nOK`);
      }
      if (command === "emu avd path") return avdPath(avdDirs.pixelFold);
      if (command === "shell cmd device_state base-state") {
        return result([
          "Committed state: DeviceState{identifier=3, name='REAR_DISPLAY_MODE', app_accessible=true}",
          "----------------------",
          `Base state: DeviceState{identifier=2, name='${posture}', app_accessible=true}`,
          "Override state: DeviceState{identifier=3, name='REAR_DISPLAY_MODE', app_accessible=true}",
        ].join("\n"));
      }
      posture = command === "emu fold" ? "CLOSED" : "OPENED";
      return result("OK");
    };
    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: true, posture: "opened", hingeAngle: 180, hingeRange: PIXEL_FOLD_RANGE,
    });
    expect(await setFoldPosture("emulator-5554", "opened", runExec)).toEqual({
      supported: true, posture: "opened", hingeAngle: 180, hingeRange: PIXEL_FOLD_RANGE,
    });
  });

  test("uses the hinge angle when Android reports an unknown state name", async () => {
    const runExec = async (_cmd: string, args: string[]) =>
      args.includes("sensor")
        ? result("hinge-angle0 = 180\r\nOK")
        : result("Committed state: DeviceState{identifier=4, name='CONCURRENT_INNER_DEFAULT'}");
    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: true, posture: "opened", hingeAngle: 180, hingeRange: null,
    });
  });

  test("rejects a refused emulator fold command", async () => {
    const runExec = async (_cmd: string, args: string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "emu sensor get hinge-angle0") return result("hinge-angle0 = 180\r\nOK");
      if (command === "shell cmd device_state base-state") {
        return result("Committed state: DeviceState{identifier=2, name='OPENED'}");
      }
      return result("KO: folding unavailable");
    };
    await expect(setFoldPosture("emulator-5554", "closed", runExec))
      .rejects.toThrow("folding unavailable");
  });

  test("reports the hinge range from the emulator's launch config, or null when it is unreadable", async () => {
    const status = (avd: () => ExecResult<string>) =>
      getFoldStatus("emulator-5554", async (_cmd: string, args: string[]) => {
        const command = args.slice(2).join(" ");
        if (command === "emu sensor get hinge-angle0") return result("hinge-angle0 = 180\r\nOK");
        if (command === "emu avd path") return avd();
        return result("Committed state: DeviceState{identifier=3, name='OPENED'}");
      });

    expect((await status(() => avdPath(avdDirs.pixelFold))).hingeRange).toEqual(PIXEL_FOLD_RANGE);
    expect((await status(() => avdPath(avdDirs.foldOut))).hingeRange).toEqual({ min: 180, max: 360 });
    // adb can reach an emulator on another host, whose AVD directory is not here.
    expect((await status(() => avdPath(join(avdDirs.pixelFold, "missing")))).hingeRange).toBeNull();
    expect((await status(() => result("KO: unknown command"))).hingeRange).toBeNull();
  });

  test("moves the hinge to an angle and reports the posture Android derives from it", async () => {
    let angle = "180";
    const commands: string[] = [];
    const runExec = async (_cmd: string, args: string[]) => {
      expect(args.slice(0, 2)).toEqual(["-s", "emulator-5554"]);
      const command = args.slice(2).join(" ");
      commands.push(command);
      if (command === "emu sensor get hinge-angle0") return result(`hinge-angle0 = ${angle}\r\nOK`);
      if (command === "emu avd path") return avdPath(avdDirs.pixelFold);
      if (command.startsWith("emu sensor set hinge-angle0 ")) {
        angle = command.slice("emu sensor set hinge-angle0 ".length);
        return result("OK");
      }
      if (command === "shell dumpsys device_state") return result(deviceStateDump(Number(angle)));
      if (command === "shell cmd device_state base-state") {
        return result(`Committed state: DeviceState{identifier=2, name='${pixelFoldPosture(Number(angle))}'}`);
      }
      throw new Error(`unexpected command: ${command}`);
    };

    expect(await setHingeAngle("emulator-5554", 90, runExec)).toEqual({
      supported: true, posture: "half_opened", hingeAngle: 90, hingeRange: PIXEL_FOLD_RANGE,
    });
    expect(await applyFoldRequest("emulator-5554", { hingeAngle: 12.5 }, runExec)).toEqual({
      supported: true, posture: "closed", hingeAngle: 12.5, hingeRange: PIXEL_FOLD_RANGE,
    });
    expect(commands).toContain("emu sensor set hinge-angle0 90");
    expect(commands).toContain("emu sensor set hinge-angle0 12.5");
    expect(commands.some((command) => command === "emu fold" || command === "emu unfold")).toBe(false);
  });

  test("waits until Android reports the new angle before reading the posture", async () => {
    let consoleAngle = 12.5;
    let androidAngle = 12.5;
    let pending = false;
    let dumps = 0;
    const runExec = async (_cmd: string, args: string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "emu sensor get hinge-angle0") return result(`hinge-angle0 = ${consoleAngle}\r\nOK`);
      if (command === "emu avd path") return avdPath(avdDirs.pixelFold);
      if (command.startsWith("emu sensor set hinge-angle0 ")) {
        consoleAngle = Number(command.slice("emu sensor set hinge-angle0 ".length));
        return result("OK");
      }
      if (command === "shell dumpsys device_state") {
        // The guest delivers the angle on the second read and commits the posture on the third.
        dumps++;
        if (dumps === 2) {
          androidAngle = consoleAngle;
          pending = true;
        } else if (dumps === 3) {
          pending = false;
        }
        return result(deviceStateDump(androidAngle, pending));
      }
      if (command === "shell cmd device_state base-state") {
        return result(`Committed state: DeviceState{identifier=2, name='${pixelFoldPosture(androidAngle)}'}`);
      }
      throw new Error(`unexpected command: ${command}`);
    };

    expect(await setHingeAngle("emulator-5554", 160, runExec)).toEqual({
      supported: true, posture: "opened", hingeAngle: 160, hingeRange: PIXEL_FOLD_RANGE,
    });
    expect(dumps).toBe(3);
  });

  test("accepts the eighth of a degree that Android reports for a finer angle", async () => {
    let consoleAngle = 180;
    let dumps = 0;
    // What pixel_fold's guest reported: 90.123° arrives as 90.125°, and 33.33°
    // set after 33.3° keeps 33.3°'s eighth, 33.25°.
    const reported: Record<string, string> = { "90.123": "90.125", "33.3": "33.25", "33.33": "33.25" };
    const runExec = async (_cmd: string, args: string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "emu sensor get hinge-angle0") return result(`hinge-angle0 = ${consoleAngle}\r\nOK`);
      if (command === "emu avd path") return avdPath(avdDirs.pixelFold);
      if (command.startsWith("emu sensor set hinge-angle0 ")) {
        consoleAngle = Number(command.slice("emu sensor set hinge-angle0 ".length));
        return result("OK");
      }
      if (command === "shell dumpsys device_state") {
        dumps++;
        return result(deviceStateDump(consoleAngle, false, reported[String(consoleAngle)]));
      }
      if (command === "shell cmd device_state base-state") {
        return result(`Committed state: DeviceState{identifier=2, name='${pixelFoldPosture(consoleAngle)}'}`);
      }
      throw new Error(`unexpected command: ${command}`);
    };

    for (const angle of [90.123, 33.3, 33.33]) {
      expect((await setHingeAngle("emulator-5554", angle, runExec)).hingeAngle).toBe(angle);
    }
    // Each change ends at the first read instead of waiting out the deadline.
    expect(dumps).toBe(3);
  });

  test("sends whole thousandths of a degree so the console reads the angle back exactly", async () => {
    const sent: string[] = [];
    let angle = "180";
    const runExec = async (_cmd: string, args: string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "emu sensor get hinge-angle0") return result(`hinge-angle0 = ${angle}\r\nOK`);
      if (command.startsWith("emu sensor set hinge-angle0 ")) {
        angle = command.slice("emu sensor set hinge-angle0 ".length);
        sent.push(angle);
        return result("OK");
      }
      return result("Committed state: DeviceState{identifier=2, name='HALF_OPENED'}");
    };

    expect((await setHingeAngle("emulator-5554", 90.123456, runExec)).hingeAngle).toBe(90.123);
    // 1e-7 would go out, and come back, in exponent notation.
    expect((await setHingeAngle("emulator-5554", 0.0000001, runExec)).hingeAngle).toBe(0);
    expect(sent).toEqual(["90.123", "0"]);
  });

  test("does not move the hinge on devices without one", async () => {
    const commands: string[] = [];
    const runExec = async (_cmd: string, args: string[]) => {
      commands.push(args.slice(2).join(" "));
      return result("KO: 'hinge-angle0' sensor is disabled.\r\n");
    };
    await expect(setHingeAngle("emulator-5554", 90, runExec))
      .rejects.toThrow("does not support folding");
    expect(commands).toEqual(["emu sensor get hinge-angle0"]);
  });

  test("refuses an angle outside the emulator's hinge range without moving the hinge", async () => {
    const commands: string[] = [];
    const runExec = async (_cmd: string, args: string[]) => {
      const command = args.slice(2).join(" ");
      commands.push(command);
      if (command === "emu sensor get hinge-angle0") return result("hinge-angle0 = 180\r\nOK");
      if (command === "emu avd path") return avdPath(avdDirs.foldOut);
      if (command === "shell cmd device_state base-state") {
        return result("Committed state: DeviceState{identifier=3, name='OPENED'}");
      }
      throw new Error(`unexpected command: ${command}`);
    };
    // The 8" Fold-out folds outward, from 180° to 360°.
    await expect(setHingeAngle("emulator-5554", 90, runExec))
      .rejects.toThrow("This emulator's hinge moves only from 180° to 360°");
    expect(commands.some((command) => command.startsWith("emu sensor set"))).toBe(false);
  });

  test("rejects a refused or unconfirmed hinge angle", async () => {
    const respond = (setOutput: string) => async (_cmd: string, args: string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "emu sensor get hinge-angle0") return result("hinge-angle0 = 180\r\nOK");
      if (command.startsWith("emu sensor set ")) return result(setOutput);
      return result("Committed state: DeviceState{identifier=2, name='OPENED'}");
    };
    await expect(setHingeAngle("emulator-5554", 90, respond("KO: sensor unavailable")))
      .rejects.toThrow("hinge angle change failed: KO: sensor unavailable");
    // The console said OK, but the sensor still reads 180°.
    await expect(setHingeAngle("emulator-5554", 90, respond("OK")))
      .rejects.toThrow("did not confirm a 90° hinge angle");
  });
});
