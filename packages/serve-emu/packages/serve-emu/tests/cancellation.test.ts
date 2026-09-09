import { describe, expect, test } from "bun:test";
import { getAccessibilitySnapshot } from "../src/accessibility.ts";
import { execText } from "../src/exec.ts";
import { setEmulatorLocationAsync } from "../src/location.ts";
import { startScrcpy } from "../src/scrcpy.ts";

describe("generation cancellation", () => {
  test("kills an active command and releases the executor slot", async () => {
    const controller = new AbortController();
    const reason = new Error("generation changed");
    const startedMs = Date.now();
    const running = execText(
      process.execPath,
      ["-e", "await Bun.sleep(5000)"],
      { signal: controller.signal, timeout: 10_000 },
    );
    setTimeout(() => controller.abort(reason), 20);

    const result = await running;
    expect(result.error?.cause).toBe(reason);
    expect(Date.now() - startedMs).toBeLessThan(1_500);
    const probe = await execText(
      process.execPath,
      ["-e", "console.log('released')"],
      { timeout: 2_000 },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe("released");
  });

  test("does not start scrcpy or location work for an aborted generation", async () => {
    const controller = new AbortController();
    const reason = new Error("server stopping");
    controller.abort(reason);

    await expect(
      startScrcpy({ serial: "not-a-device", signal: controller.signal }),
    ).rejects.toBe(reason);
    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 51.5, longitude: -0.1 },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    await expect(
      getAccessibilitySnapshot("not-a-device", controller.signal),
    ).rejects.toBe(reason);
  });
});
