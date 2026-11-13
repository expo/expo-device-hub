import { describe, expect, test } from "bun:test";
import { defaultEmulatorGpu, isBareMetalAppleSilicon } from "../host-gpu";

// `sysctl hw.optional.arm64 sysctl.proc_translated kern.hv_vmm_present` on a
// Mac mini M2 (macOS, not a virtual machine).
const APPLE_SILICON = "hw.optional.arm64: 1\nsysctl.proc_translated: 0\nkern.hv_vmm_present: 0\n";
// An EAS macOS VM ("Apple M4 Pro (Virtual)") printed `kern.hv_vmm_present: 1`.
const APPLE_SILICON_VM =
  "hw.optional.arm64: 1\nsysctl.proc_translated: 0\nkern.hv_vmm_present: 1\n";

describe("isBareMetalAppleSilicon", () => {
  test("accepts an Apple silicon Mac that is not a virtual machine", () => {
    expect(isBareMetalAppleSilicon("darwin", APPLE_SILICON)).toBe(true);
  });

  test("rejects a macOS virtual machine", () => {
    expect(isBareMetalAppleSilicon("darwin", APPLE_SILICON_VM)).toBe(false);
  });

  test.each([
    ["is missing", "hw.optional.arm64: 1\n"],
    ["is empty", "hw.optional.arm64: 1\nkern.hv_vmm_present:\n"],
    ["is not 0 or 1", "hw.optional.arm64: 1\nkern.hv_vmm_present: unknown\n"],
  ])("counts a host as virtual when kern.hv_vmm_present %s", (_case, output) => {
    expect(isBareMetalAppleSilicon("darwin", output)).toBe(false);
  });

  test("rejects an Intel Mac, which does not know the arm64 names", () => {
    expect(isBareMetalAppleSilicon("darwin", "kern.hv_vmm_present: 0\n")).toBe(false);
    expect(
      isBareMetalAppleSilicon("darwin", "hw.optional.arm64: 0\nkern.hv_vmm_present: 0\n"),
    ).toBe(false);
  });

  test("accepts a sysctl process that runs under Rosetta", () => {
    expect(
      isBareMetalAppleSilicon("darwin", "sysctl.proc_translated: 1\nkern.hv_vmm_present: 0\n"),
    ).toBe(true);
  });

  test("rejects every platform other than macOS", () => {
    expect(isBareMetalAppleSilicon("linux", APPLE_SILICON)).toBe(false);
    expect(isBareMetalAppleSilicon("win32", APPLE_SILICON)).toBe(false);
  });

  test("tolerates CRLF line endings and no output", () => {
    expect(isBareMetalAppleSilicon("darwin", APPLE_SILICON.replaceAll("\n", "\r\n"))).toBe(true);
    expect(isBareMetalAppleSilicon("darwin", "")).toBe(false);
  });
});

describe("defaultEmulatorGpu", () => {
  test("uses host on a bare-metal Apple silicon Mac and auto elsewhere", async () => {
    expect(await defaultEmulatorGpu(async () => true)).toBe("host");
    expect(await defaultEmulatorGpu(async () => false)).toBe("auto");
  });
});
