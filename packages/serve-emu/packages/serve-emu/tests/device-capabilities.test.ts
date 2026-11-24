import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableStreamModesForSerial,
  emulatorCaptureSocketFor,
  isEmulatorSerial,
  parseEmulatorSerial,
} from "../src/device-capabilities.ts";

describe("device capabilities", () => {
  test("recognizes adb emulator serials and exposes their console port", () => {
    expect(parseEmulatorSerial("emulator-5554")).toEqual({
      consolePort: "5554",
    });
    expect(isEmulatorSerial("emulator-5554")).toBe(true);
    expect(parseEmulatorSerial("physical-device")).toBeNull();
    expect(isEmulatorSerial("emulator-5554-extra")).toBe(false);
  });

  test("offers host screenshot streaming only to emulators", () => {
    expect(availableStreamModesForSerial("emulator-5554")).toEqual(["scrcpy", "grpc-screenshot"]);
    expect(availableStreamModesForSerial("physical-device")).toEqual(["scrcpy"]);
  });
});

test("capture discovery requires a socket in this user's private directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "capture-discovery-"));
  const path = join(directory, "emulator-5554.sock");
  let listener: ReturnType<typeof Bun.listen> | undefined;
  try {
    await writeFile(path, "not a socket");
    expect(emulatorCaptureSocketFor("emulator-5554", directory)).toBeNull();
    await rm(path);
    listener = Bun.listen({ unix: path, socket: { data() {} } });
    expect(emulatorCaptureSocketFor("emulator-5554", directory)).toBe(path);
    expect(emulatorCaptureSocketFor("physical", directory)).toBeNull();
    await chmod(directory, 0o777);
    expect(emulatorCaptureSocketFor("emulator-5554", directory)).toBeNull();
    await chmod(directory, 0o700);
    const alias = `${directory}-link`;
    await symlink(directory, alias);
    try {
      expect(emulatorCaptureSocketFor("emulator-5554", alias)).toBeNull();
    } finally {
      await rm(alias);
    }
    await symlink(path, join(directory, "emulator-5556.sock"));
    expect(emulatorCaptureSocketFor("emulator-5556", directory)).toBeNull();
  } finally {
    listener?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
