import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEmulatorRenderer, readEmulatorRenderer } from "../emulator-renderer";

// "Graphics Adapter" lines that emulator 37.2.7 printed on a Mac mini M2, and
// that emulator 37.1.11 printed on an EAS Linux VM.
const MAC_AUTO =
  "Android Emulator OpenGL ES Translator (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver-5.0.0))";
const MAC_HOST = "Android Emulator OpenGL ES Translator (Apple M2)";
const LINUX_LAVAPIPE =
  "Android Emulator OpenGL ES Translator (ANGLE (Mesa, Vulkan 1.4.318 (llvmpipe (LLVM 21.0.0 256 bits) (0x00000000)), llvmpipe-25.2.4))";
const LINUX_AUTO = "Android Emulator OpenGL ES Translator (Google SwiftShader)";

const dump = (renderer: string) =>
  `Other diagnostics\r\nGLES: Google (Google Inc. (Google)), ${renderer}, OpenGL ES 3.1 (ANGLE 2.1.1)\r\nMore diagnostics`;

describe("parseEmulatorRenderer", () => {
  test.each([
    [MAC_AUTO, "SwiftShader", true],
    [LINUX_LAVAPIPE, "llvmpipe", true],
    [LINUX_AUTO, "SwiftShader", true],
    ["lavapipe", "lavapipe", true],
    [MAC_HOST, "Apple M2", false],
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)", null, false],
  ])("reads %s", (renderer, name, software) => {
    expect(parseEmulatorRenderer(dump(renderer))).toEqual({
      renderer,
      name: name ?? renderer,
      software,
    });
  });

  test.each([
    "",
    "Permission denied",
    "Vulkan device initialized: 1",
    "GLES:",
    "GLES: vendor, , 3.1",
  ])("returns null without a renderer: %j", (output) => {
    expect(parseEmulatorRenderer(output)).toBeNull();
  });
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fakeAdb(code: string): string {
  const directory = mkdtempSync(join(tmpdir(), "hub-renderer-test-"));
  directories.push(directory);
  const path = join(directory, "adb");
  writeFileSync(path, `#!${process.execPath}\n${code}`, { mode: 0o755 });
  return path;
}

describe("readEmulatorRenderer", () => {
  test("reads the selected serial", async () => {
    const adbPath = fakeAdb(`
      const expected = ["-s", "emulator-5556", "shell", "dumpsys", "SurfaceFlinger"];
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(1);
      console.log(${JSON.stringify(dump(MAC_AUTO))});
    `);
    expect(await readEmulatorRenderer("emulator-5556", { adbPath })).toEqual({
      value: { renderer: MAC_AUTO, name: "SwiftShader", software: true },
      error: null,
    });
  });

  test("returns null on a failed command, even with a renderer in stdout", async () => {
    const adbPath = fakeAdb(`console.log(${JSON.stringify(dump(MAC_AUTO))}); process.exit(1);`);
    const read = await readEmulatorRenderer("emulator-5554", { adbPath });
    expect(read.value).toBeNull();
    expect(read.error).not.toBeNull();
  });

  test("returns null on a timeout", async () => {
    const adbPath = fakeAdb("setInterval(() => {}, 1000);");
    const read = await readEmulatorRenderer("emulator-5554", { adbPath, timeoutMs: 50 });
    expect(read.value).toBeNull();
    expect(read.error).not.toBeNull();
  });

  test("returns null when cancelled", async () => {
    const adbPath = fakeAdb("setInterval(() => {}, 1000);");
    const read = await readEmulatorRenderer("emulator-5554", {
      adbPath,
      signal: AbortSignal.abort(),
    });
    expect(read.value).toBeNull();
    expect(read.error).not.toBeNull();
  });
});
