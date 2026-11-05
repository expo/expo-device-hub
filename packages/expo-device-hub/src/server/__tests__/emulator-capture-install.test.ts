import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMULATOR_CAPTURE_PACKAGE,
  installEmulatorCapture,
  type InstallCommand,
} from "../emulator-capture-install";

const LIBRARY = "dist/darwin-arm64/libexpo_emulator_capture.dylib";

/** An npm stand-in that writes the package into `--prefix`, as `npm install` would. */
function fakeNpm(calls: string[][], { withLibrary = true } = {}): InstallCommand {
  return async (command, args) => {
    calls.push([command, ...args]);
    const prefix = args[args.indexOf("--prefix") + 1]!;
    const packageDirectory = join(prefix, "node_modules", EMULATOR_CAPTURE_PACKAGE);
    await mkdir(join(packageDirectory, "dist", "darwin-arm64"), { recursive: true });
    if (withLibrary) await writeFile(join(packageDirectory, LIBRARY), "agent");
    return { status: 0, output: "added 1 package" };
  };
}

async function withCache(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "hub-capture-install-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("installEmulatorCapture", () => {
  test("installs the pinned version into its own folder, then reuses it", () =>
    withCache(async (baseDirectory) => {
      const calls: string[][] = [];
      const options = { version: "1.2.3", platform: "darwin" as const, baseDirectory };
      const library = await installEmulatorCapture({ ...options, run: fakeNpm(calls) });
      const installDirectory = join(baseDirectory, "tools", EMULATOR_CAPTURE_PACKAGE, "1.2.3");
      expect(library).toBe(
        join(installDirectory, "node_modules", EMULATOR_CAPTURE_PACKAGE, LIBRARY),
      );
      expect(await readFile(join(installDirectory, ".install-complete"), "utf8")).toBe("1.2.3\n");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(`${EMULATOR_CAPTURE_PACKAGE}@1.2.3`);
      expect(calls[0]?.slice(0, 2)).toEqual(["npm", "install"]);
      // No staging folder or lock is left behind.
      expect(await readdir(join(baseDirectory, "tools", EMULATOR_CAPTURE_PACKAGE))).toEqual([
        "1.2.3",
      ]);

      expect(await installEmulatorCapture({ ...options, run: fakeNpm(calls) })).toBe(library);
      expect(calls).toHaveLength(1);
    }));

  test("reports npm's output when the install fails, and keeps nothing", () =>
    withCache(async (baseDirectory) => {
      const failing: InstallCommand = async () => ({
        status: 1,
        output: "npm ERR! 404 Not Found - GET https://registry.npmjs.org/expo-emulator-capture",
      });
      await expect(
        installEmulatorCapture({
          version: "9.9.9",
          platform: "darwin",
          baseDirectory,
          run: failing,
        }),
      ).rejects.toThrow("npm install expo-emulator-capture@9.9.9 failed: npm ERR! 404 Not Found");
      expect(await readdir(join(baseDirectory, "tools", EMULATOR_CAPTURE_PACKAGE))).toEqual([]);
    }));

  test("refuses a package without the agent library for this host", () =>
    withCache(async (baseDirectory) => {
      await expect(
        installEmulatorCapture({
          version: "1.2.3",
          platform: "darwin",
          baseDirectory,
          run: fakeNpm([], { withLibrary: false }),
        }),
      ).rejects.toThrow("has no agent library for darwin");
      expect(existsSync(join(baseDirectory, "tools", EMULATOR_CAPTURE_PACKAGE, "1.2.3"))).toBe(
        false,
      );
    }));

  test("runs one install for two Hubs that start at the same time", () =>
    withCache(async (baseDirectory) => {
      const calls: string[][] = [];
      const npm = fakeNpm(calls);
      const slowNpm: InstallCommand = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return npm(...args);
      };
      const options = {
        version: "1.2.3",
        platform: "darwin" as const,
        baseDirectory,
        run: slowNpm,
      };
      const [first, second] = await Promise.all([
        installEmulatorCapture(options),
        installEmulatorCapture(options),
      ]);
      expect(first).toBe(second);
      expect(calls).toHaveLength(1);
    }));

  test("has no agent for hosts other than macOS", async () => {
    await expect(installEmulatorCapture({ platform: "win32", run: fakeNpm([]) })).rejects.toThrow(
      "has no agent for win32",
    );
  });
});
