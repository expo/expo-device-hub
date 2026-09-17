import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGpuInfo, readGpuInfo } from "../gpu-info";

const swiftshader =
  "Android Emulator OpenGL ES Translator (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver-5.0.0))";
const dump = (renderer: string) =>
  `Other diagnostics\r\nGLES: Google (Google Inc. (Google)), ${renderer}, OpenGL ES 3.1 (ANGLE 2.1.1)\r\nMore diagnostics`;

describe("parseGpuInfo", () => {
  test.each([
    [swiftshader, "SwiftShader", "Software · ANGLE / Vulkan"],
    ["Google SwiftShader", "SwiftShader", "Software"],
    ["llvmpipe (LLVM 15.0.7, 256 bits)", "LLVMpipe", "Software"],
    ["lavapipe", "Lavapipe", "Software"],
    ["ANGLE (ANGLE Metal Renderer: Apple M2 Pro)", "Apple M2 Pro", "ANGLE / Metal"],
    [
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
      "Apple M2 Pro",
      "ANGLE / Metal",
    ],
    [
      "ANGLE (NVIDIA, Vulkan 1.3.0 (NVIDIA GeForce RTX 4070 (0x00002786)), NVIDIA driver)",
      "NVIDIA GeForce RTX 4070",
      "ANGLE / Vulkan",
    ],
    [
      "ANGLE (Intel, Intel UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "Intel UHD Graphics",
      "ANGLE / Direct3D 11",
    ],
    [
      "Android Emulator OpenGL ES Translator (Apple M2 Pro)",
      "Apple M2 Pro",
      "Emulator OpenGL ES translator",
    ],
    ["ANGLE (Unfamiliar backend)", "ANGLE (Unfamiliar backend)", "ANGLE"],
    ["Future Renderer (A, B)", "Future Renderer (A, B)", null],
  ])("maps %s without inferring a launch flag", (renderer, name, description) => {
    expect(parseGpuInfo(dump(renderer!))).toEqual({ name, renderer, description });
  });

  test.each([
    "",
    "Permission denied",
    "Vulkan device initialized: 1",
    "GLES:",
    "GLES: vendor, , OpenGL ES 3.1",
    "GLES: invalid",
  ])("returns null for missing or malformed renderer: %s", (output) => {
    expect(parseGpuInfo(output)).toBeNull();
  });
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fakeAdb(code: string): string {
  const directory = mkdtempSync(join(tmpdir(), "hub-gpu-test-"));
  directories.push(directory);
  const path = join(directory, "adb");
  writeFileSync(path, `#!${process.execPath}\n${code}`, { mode: 0o755 });
  return path;
}

describe("readGpuInfo", () => {
  test("uses the selected serial and parses real command output", async () => {
    const adbPath = fakeAdb(`
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["-s", "emulator-5556", "shell", "dumpsys", "SurfaceFlinger"])) process.exit(1);
      console.log(${JSON.stringify(dump(swiftshader))});
    `);
    expect(await readGpuInfo("emulator-5556", { adbPath })).toEqual({
      value: {
        name: "SwiftShader",
        renderer: swiftshader,
        description: "Software · ANGLE / Vulkan",
      },
      error: null,
    });
  });

  test("returns null on a command failure even if stdout contains a renderer", async () => {
    const adbPath = fakeAdb(`console.log(${JSON.stringify(dump(swiftshader))}); process.exit(1);`);
    const result = await readGpuInfo("emulator-5554", { adbPath });
    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("returns null on timeout", async () => {
    const adbPath = fakeAdb("setInterval(() => {}, 1000);");
    const result = await readGpuInfo("emulator-5554", { adbPath, timeoutMs: 50 });
    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("returns null when cancelled", async () => {
    const adbPath = fakeAdb("setInterval(() => {}, 1000);");
    const result = await readGpuInfo("emulator-5554", { adbPath, signal: AbortSignal.abort() });
    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("returns null when the command succeeds without renderer information", async () => {
    const adbPath = fakeAdb('console.log("Vulkan device initialized: 1");');
    expect(await readGpuInfo("emulator-5554", { adbPath })).toEqual({ value: null, error: null });
  });
});
