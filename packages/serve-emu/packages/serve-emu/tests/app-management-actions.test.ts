import { describe, expect, test } from "bun:test";
import {
  AppManagementError,
  activityName,
  clearAppData,
  forceStopApp,
  grantPermission,
  importMediaFile,
  installApk,
  launchApp,
  packageName,
  permissionName,
  type LocalUploadFile,
} from "../src/app-management.ts";
import type { ExecOpts, ExecResult, execText } from "../src/exec.ts";

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
    path: "/private/tmp/serve-emu-upload/staged",
    filename: "sample.apk",
    mediaType: "application/octet-stream",
    size: 128,
    ...overrides,
  };
}

function recordingExec(
  calls: ExecCall[],
  response: ExecResult<string> = result(),
): typeof execText {
  return async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return response;
  };
}

describe("app management identifiers", () => {
  test("trims valid package, activity, and permission names", () => {
    expect(packageName("  Com_Example.app2  ")).toBe("Com_Example.app2");
    expect(activityName("  .MainActivity  ")).toBe(".MainActivity");
    expect(activityName("  com.example/.MainActivity  ")).toBe(
      "com.example/.MainActivity",
    );
    expect(permissionName("  android.permission.CAMERA  ")).toBe(
      "android.permission.CAMERA",
    );
  });

  test("rejects malformed package names", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "single",
      "1com.example",
      "com..example",
      "com.example-app",
    ]) {
      expect(() => packageName(value)).toThrow("packageName is invalid");
    }
  });

  test("rejects malformed activities and permissions", () => {
    for (const value of [
      undefined,
      null,
      "",
      "/",
      "1Main",
      "bad activity",
    ]) {
      expect(() => activityName(value)).toThrow("activity is invalid");
    }
    for (const value of [
      undefined,
      null,
      "",
      "CAMERA",
      "android.permission.",
      "android.permission.READ-MEDIA",
    ]) {
      expect(() => permissionName(value)).toThrow("permission is invalid");
    }
  });
});

describe("app management actions", () => {
  test("builds default, relative, and explicit-component launch commands", async () => {
    const calls: ExecCall[] = [];
    const run = recordingExec(
      calls,
      result({ stdout: "Starting\n", stderr: "warning\n" }),
    );

    expect(
      await launchApp("device-a", " com.example.app ", undefined, {
        execText: run,
      }),
    ).toEqual({ ok: true, output: "Starting\nwarning" });
    await launchApp("device-a", "com.example.app", " .MainActivity ", {
      execText: run,
    });
    await launchApp(
      "device-a",
      "com.example.app",
      " com.other/.Entry ",
      { execText: run },
    );

    expect(calls.map((call) => call.args)).toEqual([
      [
        "-s",
        "device-a",
        "shell",
        "monkey",
        "-p",
        "com.example.app",
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ],
      [
        "-s",
        "device-a",
        "shell",
        "am",
        "start",
        "-n",
        "com.example.app/.MainActivity",
      ],
      [
        "-s",
        "device-a",
        "shell",
        "am",
        "start",
        "-n",
        "com.other/.Entry",
      ],
    ]);
    expect(calls.every((call) => call.cmd === "adb")).toBe(true);
    expect(calls.every((call) => call.opts.timeout === 30_000)).toBe(true);
    expect(calls.every((call) => call.opts.lane === "background")).toBe(true);
    expect(calls.every((call) => call.opts.signal === undefined)).toBe(true);
  });

  test("builds clear, force-stop, and permission grant commands", async () => {
    const calls: ExecCall[] = [];
    const run = recordingExec(calls, result({ stdout: "Success\n" }));

    expect(
      await clearAppData("device-b", " com.example.app ", { execText: run }),
    ).toEqual({ ok: true, output: "Success" });
    await forceStopApp("device-b", "com.example.app", { execText: run });
    await grantPermission(
      "device-b",
      " com.example.app ",
      " android.permission.CAMERA ",
      { execText: run },
    );

    expect(calls.map((call) => call.args)).toEqual([
      ["-s", "device-b", "shell", "pm", "clear", "com.example.app"],
      [
        "-s",
        "device-b",
        "shell",
        "am",
        "force-stop",
        "com.example.app",
      ],
      [
        "-s",
        "device-b",
        "shell",
        "pm",
        "grant",
        "com.example.app",
        "android.permission.CAMERA",
      ],
    ]);
  });

  test("validates action inputs before invoking adb", () => {
    const calls: ExecCall[] = [];
    const dependencies = { execText: recordingExec(calls) };

    expect(() =>
      launchApp("device-a", "invalid", undefined, dependencies),
    ).toThrow("packageName is invalid");
    expect(() =>
      launchApp(
        "device-a",
        "com.example.app",
        "bad activity",
        dependencies,
      ),
    ).toThrow("activity is invalid");
    expect(() => clearAppData("device-a", "invalid", dependencies)).toThrow(
      "packageName is invalid",
    );
    expect(() => forceStopApp("device-a", "invalid", dependencies)).toThrow(
      "packageName is invalid",
    );
    expect(() =>
      grantPermission(
        "device-a",
        "com.example.app",
        "CAMERA",
        dependencies,
      ),
    ).toThrow("permission is invalid");
    expect(calls).toEqual([]);
  });

  test("preserves status, process, and timeout failure diagnostics", async () => {
    const nonzero = clearAppData("device-a", "com.example.app", {
      execText: async () => result({ status: 1 }),
    });
    await expect(nonzero).rejects.toMatchObject({
      name: "AppManagementError",
      code: "adb-failed",
      message: "adb shell pm clear com.example.app failed",
    });

    const spawnError = new Error("spawn adb ENOENT");
    const failed = forceStopApp("device-a", "com.example.app", {
      execText: async () =>
        result({ status: null, error: spawnError, stderr: "adb unavailable" }),
    });
    await expect(failed).rejects.toMatchObject({
      code: "adb-failed",
      message: "adb unavailable",
      cause: spawnError,
    });

    const timeoutError = new Error("deadline exceeded");
    const timedOut = grantPermission(
      "device-a",
      "com.example.app",
      "android.permission.CAMERA",
      {
        execText: async () =>
          result({ status: null, timedOut: true, error: timeoutError }),
      },
    );
    await expect(timedOut).rejects.toMatchObject({
      code: "adb-timeout",
      message:
        "adb shell pm grant com.example.app android.permission.CAMERA timed out",
      cause: timeoutError,
    });
  });
});

describe("app management install and import boundaries", () => {
  test("accepts case-insensitive APK extensions and rechecks cancellation after adb", async () => {
    const controller = new AbortController();
    const reason = new Error("device session changed");
    let calls = 0;

    const installing = installApk(
      "device-a",
      upload({ filename: "Release.APK" }),
      controller.signal,
      {
        execText: async () => {
          calls++;
          controller.abort(reason);
          return result({ stdout: "Success" });
        },
      },
    );

    await expect(installing).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  test("normalizes a non-Error cancellation before invoking adb", async () => {
    const controller = new AbortController();
    controller.abort("cancelled by caller");
    let invoked = false;

    try {
      await installApk(
        "device-a",
        upload(),
        controller.signal,
        {
          execText: async () => {
            invoked = true;
            return result();
          },
        },
      );
      throw new Error("expected install to be cancelled");
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
      expect((error as DOMException).message).toBe(
        "The operation was aborted",
      );
    }
    expect(invoked).toBe(false);
  });

  test.each([
    ["photo.HEIC", "application/octet-stream", "image", "/sdcard/Pictures"],
    ["clip.MKV", "application/octet-stream", "video", "/sdcard/Movies"],
    ["notes.txt", "text/plain", "file", "/sdcard/Download"],
  ] as const)(
    "infers %s media placement when MIME metadata is generic",
    async (filename, mediaType, kind, directory) => {
      const calls: ExecCall[] = [];
      const imported = await importMediaFile(
        "device-a",
        upload({ filename, mediaType }),
        undefined,
        {
          uploadId: () => "media-kind",
          execText: recordingExec(calls),
        },
      );

      expect(imported).toMatchObject({
        ok: true,
        kind,
        path: `${directory}/${filename}`,
      });
      expect(calls[0]?.args.slice(2)).toEqual([
        "shell",
        "mkdir",
        "-p",
        directory,
      ]);
    },
  );

  test("generates a random partial-upload identifier when none is supplied", async () => {
    const calls: ExecCall[] = [];

    await importMediaFile(
      "device-a",
      upload({ filename: "photo.png", mediaType: "image/png" }),
      undefined,
      { execText: recordingExec(calls) },
    );

    expect(calls[1]?.args.at(-1)).toMatch(
      /^\/sdcard\/Pictures\/\.serve-emu-[0-9a-f]{12}-photo\.png\.part$/,
    );
  });

  test("does not remove the committed file when media scanning fails", async () => {
    const calls: ExecCall[] = [];
    const run: typeof execText = async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, opts });
      return args.includes("broadcast")
        ? result({ status: 1, stderr: "scanner unavailable" })
        : result();
    };

    const importing = importMediaFile(
      "device-a",
      upload({ filename: "photo.jpg", mediaType: "image/jpeg" }),
      undefined,
      { uploadId: () => "committed", execText: run },
    );

    await expect(importing).rejects.toMatchObject({
      code: "adb-failed",
      message: "scanner unavailable",
    });
    expect(calls).toHaveLength(4);
    expect(calls.some((call) => call.args.includes("rm"))).toBe(false);
    expect(calls[2]?.args.slice(2)).toEqual([
      "shell",
      "mv",
      "-f",
      "/sdcard/Pictures/.serve-emu-committed-photo.jpg.part",
      "/sdcard/Pictures/photo.jpg",
    ]);
  });

  test("cleans the partial path after cancellation during push", async () => {
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const calls: ExecCall[] = [];
    const run: typeof execText = async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, opts });
      if (args.includes("push")) controller.abort(reason);
      return result();
    };

    const importing = importMediaFile(
      "device-a",
      upload({ filename: "clip.mp4", mediaType: "video/mp4" }),
      controller.signal,
      { uploadId: () => "cancelled", execText: run },
    );

    await expect(importing).rejects.toBe(reason);
    expect(calls.at(-1)?.args.slice(2)).toEqual([
      "shell",
      "rm",
      "-f",
      "/sdcard/Movies/.serve-emu-cancelled-clip.mp4.part",
    ]);
    expect(calls.at(-1)?.opts.signal).toBeUndefined();
  });

  test("exposes structured application errors with their original cause", () => {
    const cause = new Error("adb root cause");
    const error = new AppManagementError("adb-failed", "action failed", {
      cause,
    });

    expect(error).toMatchObject({
      name: "AppManagementError",
      code: "adb-failed",
      message: "action failed",
      cause,
    });
  });
});
