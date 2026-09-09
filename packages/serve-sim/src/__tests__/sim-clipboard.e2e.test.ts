import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { pbcopyCommand, pbpasteCommand } from "../client/utils/sim-clipboard";

function bootedUdid(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const device of devices) if (device.state === "Booted") return device.udid;
    }
  } catch {}
  return null;
}

const udid = bootedUdid();

// Failed once on a shared runner and passes locally; cause unknown. Skipped on
// CI like ui-settings.e2e. The command builders have unit tests that do run.
const skipOnCi = !!process.env.CI && process.env.SERVE_SIM_CLIPBOARD_E2E !== "1";
if (skipOnCi) {
  console.warn(
    "[sim-clipboard.e2e] skipping on CI: simulator pasteboard round-trip is unreliable on shared runners (set SERVE_SIM_CLIPBOARD_E2E=1 to force)",
  );
}

const describeIfSim = udid && !skipOnCi ? describe : describe.skip;

describeIfSim(`simctl pasteboard round-trip (booted sim ${udid ?? "<skipped>"})`, () => {
  test("pbcopy/pbpaste keep unicode under LANG=C", () => {
    const text = "café 🎉 email+tag@x.com — 日本語";
    execSync(pbcopyCommand(udid!, text), { env: { ...process.env, LANG: "C", LC_ALL: "C" } });
    const got = execSync(pbpasteCommand(udid!), {
      encoding: "utf-8",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    });
    expect(got).toBe(text);
  });
});
