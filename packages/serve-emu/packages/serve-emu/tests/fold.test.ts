import { describe, expect, test } from "bun:test";
import { getFoldStatus, setFoldPosture } from "../src/fold.ts";
import type { ExecResult } from "../src/exec.ts";

function result(stdout: string, status = 0): ExecResult<string> {
  return { status, stdout, stderr: "", signal: null, timedOut: false, error: null };
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
      supported: true, posture: "opened", hingeAngle: 180,
    });
    expect(await setFoldPosture("emulator-5554", "closed", runExec)).toEqual({
      supported: true, posture: "closed", hingeAngle: 0,
    });
    expect(await setFoldPosture("emulator-5554", "opened", runExec)).toEqual({
      supported: true, posture: "opened", hingeAngle: 180,
    });
    expect(commands).toContain("emu fold");
    expect(commands).toContain("emu unfold");
    expect(commands.every((command) => !command.includes("grpc"))).toBe(true);
  });

  test("does not issue fold commands on unsupported devices", async () => {
    const commands: string[] = [];
    const runExec = async (_cmd: string, args: string[]) => {
      commands.push(args.slice(2).join(" "));
      return result("KO: unknown sensor name: hinge-angle0");
    };
    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: false, posture: null, hingeAngle: null,
    });
    await expect(setFoldPosture("emulator-5554", "closed", runExec))
      .rejects.toThrow("does not support folding");
    expect(commands).toEqual(["emu sensor get hinge-angle0", "emu sensor get hinge-angle0"]);
    expect(await getFoldStatus("physical-1", async () => {
      throw new Error("must not run adb");
    })).toEqual({ supported: false, posture: null, hingeAngle: null });
  });

  test("uses the hinge angle when Android does not report a physical state", async () => {
    const runExec = async (_cmd: string, args: string[]) =>
      args.includes("sensor")
        ? result("hinge-angle0 = 0\r\nOK")
        : result("Unknown command: device_state", 1);
    expect(await getFoldStatus("emulator-5554", runExec)).toEqual({
      supported: true, posture: "closed", hingeAngle: 0,
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
});
