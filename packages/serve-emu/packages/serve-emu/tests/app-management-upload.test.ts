import { describe, expect, test } from "bun:test";
import {
  AppManagementError,
  importMediaFile,
  installApk,
  type LocalUploadFile,
} from "../src/app-management.ts";
import type { ExecOpts, ExecResult } from "../src/exec.ts";

type ExecCall = {
  cmd: string;
  args: string[];
  opts: ExecOpts;
};

function result(
  overrides: Partial<ExecResult<string>> = {},
): ExecResult<string> {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    error: null,
    ...overrides,
  };
}

function upload(
  overrides: Partial<LocalUploadFile> = {},
): LocalUploadFile {
  return {
    path: "/private/tmp/serve-emu-upload/upload",
    filename: "sample.apk",
    mediaType: "application/octet-stream",
    size: 128,
    ...overrides,
  };
}

describe("staged app management uploads", () => {
  test("installs the staged APK path without materializing the file", async () => {
    const calls: ExecCall[] = [];
    const controller = new AbortController();
    const run = async (cmd: string, args: string[], opts: ExecOpts) => {
      calls.push({ cmd, args, opts });
      return result({ stdout: "Success\n" });
    };

    expect(
      await installApk("device-a", upload(), controller.signal, {
        execText: run,
      }),
    ).toEqual({ ok: true, output: "Success" });
    expect(calls).toEqual([
      {
        cmd: "adb",
        args: [
          "-s",
          "device-a",
          "install",
          "-r",
          "/private/tmp/serve-emu-upload/upload",
        ],
        opts: {
          timeout: 120_000,
          signal: controller.signal,
          lane: "background",
        },
      },
    ]);
  });

  test("rejects a non-APK filename before invoking adb", async () => {
    let invoked = false;
    await expect(
      installApk("device-a", upload({ filename: "sample.zip" }), undefined, {
        execText: async () => {
          invoked = true;
          return result();
        },
      }),
    ).rejects.toThrow("APK file must end with .apk");
    expect(invoked).toBe(false);
  });

  test("imports through a hidden partial path before the final atomic rename", async () => {
    const calls: ExecCall[] = [];
    const run = async (cmd: string, args: string[], opts: ExecOpts) => {
      calls.push({ cmd, args, opts });
      return result();
    };
    const file = upload({
      filename: "My photo.jpg",
      mediaType: "image/jpeg",
    });

    const imported = await importMediaFile("old-device", file, undefined, {
      execText: run,
      uploadId: () => "fixed",
    });

    const partial =
      "/sdcard/Pictures/.serve-emu-fixed-My-photo.jpg.part";
    const final = "/sdcard/Pictures/My-photo.jpg";
    expect(imported).toEqual({
      ok: true,
      output: `Imported My photo.jpg to ${final}`,
      path: final,
      kind: "image",
    });
    expect(calls.map((call) => call.args.slice(2))).toEqual([
      ["shell", "mkdir", "-p", "/sdcard/Pictures"],
      ["push", file.path, partial],
      ["shell", "mv", "-f", partial, final],
      [
        "shell",
        "am",
        "broadcast",
        "-a",
        "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
        "-d",
        `file://${final}`,
      ],
    ]);
    expect(calls.every((call) => call.args[1] === "old-device")).toBe(true);
  });

  test("removes a remote partial file after an ADB failure", async () => {
    const calls: ExecCall[] = [];
    const run = async (cmd: string, args: string[], opts: ExecOpts) => {
      calls.push({ cmd, args, opts });
      if (args.includes("push")) {
        return result({ status: 1, stderr: "push failed" });
      }
      return result();
    };

    let error: unknown;
    try {
      await importMediaFile(
        "old-device",
        upload({ filename: "clip.mp4", mediaType: "video/mp4" }),
        undefined,
        { execText: run, uploadId: () => "failed" },
      );
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(AppManagementError);
    expect(error).toMatchObject({ code: "adb-failed" });
    expect(calls.at(-1)?.args.slice(2)).toEqual([
      "shell",
      "rm",
      "-f",
      "/sdcard/Movies/.serve-emu-failed-clip.mp4.part",
    ]);
    expect(calls.at(-1)?.opts.signal).toBeUndefined();
  });

  test.each([".", "..", "/"])(
    "replaces the special or empty path component %p",
    async (filename) => {
      const calls: ExecCall[] = [];
      await importMediaFile(
        "device-a",
        upload({ filename, mediaType: "application/octet-stream" }),
        undefined,
        {
          uploadId: () => "safe",
          execText: async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return result();
          },
        },
      );

      const final = "/sdcard/Download/upload-safe";
      expect(calls[2]?.args.slice(2)).toEqual([
        "shell",
        "mv",
        "-f",
        "/sdcard/Download/.serve-emu-safe-upload-safe.part",
        final,
      ]);
    },
  );

  test("reports a remote partial cleanup failure with the primary failure", async () => {
    const pushError = new Error("push process failed");
    let calls = 0;
    const importing = importMediaFile(
      "device-a",
      upload({ filename: "large.bin" }),
      undefined,
      {
        uploadId: () => "cleanup",
        execText: async () => {
          calls++;
          if (calls === 2) {
            return result({ status: null, error: pushError });
          }
          if (calls === 3) {
            return result({ status: 1, stderr: "rm failed" });
          }
          return result();
        },
      },
    );

    let error: unknown;
    try {
      await importing;
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(AppManagementError);
    expect(error).toMatchObject({
      code: "adb-cleanup-failed",
      message:
        "failed to remove partial upload /sdcard/Download/.serve-emu-cleanup-large.bin.part",
    });
    expect(error).toHaveProperty("cause");
    expect((error as Error).cause).toBeInstanceOf(AggregateError);
    expect(((error as Error).cause as AggregateError).errors).toHaveLength(2);
  });

  test("preserves cancellation and classifies ADB timeouts", async () => {
    const controller = new AbortController();
    const cancelled = new Error("device session changed");
    controller.abort(cancelled);
    let invoked = false;
    await expect(
      installApk("device-a", upload(), controller.signal, {
        execText: async () => {
          invoked = true;
          return result();
        },
      }),
    ).rejects.toBe(cancelled);
    expect(invoked).toBe(false);

    const timeout = installApk("device-a", upload(), undefined, {
      execText: async () =>
        result({
          status: null,
          timedOut: true,
          error: new Error("adb timed out"),
        }),
    });
    await expect(timeout).rejects.toMatchObject({
      name: "AppManagementError",
      code: "adb-timeout",
    });
  });
});
