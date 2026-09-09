import { describe, expect, test } from "bun:test";
import {
  isAbnormalExit,
  procExitDetail,
  terminalTransitionAllowed,
} from "../src/session-status.ts";

describe("terminalTransitionAllowed", () => {
  test("first transition out of streaming is allowed", () => {
    expect(terminalTransitionAllowed("streaming", "stopped")).toBe(true);
    expect(terminalTransitionAllowed("streaming", "error")).toBe(true);
  });

  test("a clean-eof 'stopped' escalates to 'error' (crash wins the race)", () => {
    expect(terminalTransitionAllowed("stopped", "error")).toBe(true);
  });

  test("'stopped' does not re-transition to 'stopped'", () => {
    expect(terminalTransitionAllowed("stopped", "stopped")).toBe(false);
  });

  test("nothing downgrades a terminal 'error'", () => {
    expect(terminalTransitionAllowed("error", "error")).toBe(false);
    expect(terminalTransitionAllowed("error", "stopped")).toBe(false);
  });
});

describe("isAbnormalExit", () => {
  test("killed by signal is abnormal", () => {
    expect(isAbnormalExit(null, "SIGKILL")).toBe(true);
    expect(isAbnormalExit(null, "SIGSEGV")).toBe(true);
    expect(isAbnormalExit(0, "SIGTERM")).toBe(true);
  });

  test("non-zero exit code is abnormal", () => {
    expect(isAbnormalExit(1, null)).toBe(true);
    expect(isAbnormalExit(139, null)).toBe(true);
  });

  test("clean code-0 exit is normal", () => {
    expect(isAbnormalExit(0, null)).toBe(false);
    expect(isAbnormalExit(null, null)).toBe(false);
  });
});

describe("procExitDetail", () => {
  test("reports the signal in reason, code, and meta", () => {
    const d = procExitDetail(null, "SIGKILL");
    expect(d.code).toBe("process-exit");
    expect(d.reason).toBe("scrcpy exited with code null signal SIGKILL");
    expect(d.meta).toEqual({ signal: "SIGKILL" });
  });

  test("reports a non-zero exit code in meta", () => {
    const d = procExitDetail(139, null);
    expect(d.meta).toEqual({ exitCode: 139 });
    expect(d.reason).toBe("scrcpy exited with code 139 signal null");
  });

  test("includes both exit code and signal when present", () => {
    const d = procExitDetail(137, "SIGKILL");
    expect(d.meta).toEqual({ exitCode: 137, signal: "SIGKILL" });
  });
});
