import { describe, expect, it } from "bun:test";

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { InvalidHostActionError, runHostActionAsync } from "../host-actions";
import { SCREENSHOT_DIR, UPLOAD_DIR } from "../host-paths";

// `true` ignores its arguments and exits 0, so these assert validation without running simctl.
const BIN = "true";

describe("runHostActionAsync validation", () => {
  it("refuses an unknown action", async () => {
    await expect(runHostActionAsync({ action: "shell.run" }, BIN)).rejects.toBeInstanceOf(
      InvalidHostActionError,
    );
  });

  it("refuses a missing action", async () => {
    await expect(runHostActionAsync({}, BIN)).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a required param that is missing or empty", async () => {
    await expect(runHostActionAsync({ action: "appearance.get" }, BIN)).rejects.toBeInstanceOf(
      InvalidHostActionError,
    );
    await expect(
      runHostActionAsync({ action: "appearance.get", params: { udid: "" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a value outside the allowed set", async () => {
    await expect(
      runHostActionAsync(
        { action: "appearance.set", params: { udid: "U", value: "rm -rf /" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("rejects a bundle id carrying shell metacharacters", async () => {
    await expect(
      runHostActionAsync(
        { action: "permissions.resetAll", params: { bundleId: "a; touch /tmp/pwned", udid: "U" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("rejects a path outside the paths the preview may read", async () => {
    await expect(
      runHostActionAsync({ action: "file.readBase64", params: { path: "/etc/passwd" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
    await expect(
      runHostActionAsync(
        { action: "file.readBase64", params: { path: `${homedir()}/Desktop/../../.ssh/id_rsa` } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("rejects an argument that would be read as a flag", async () => {
    await expect(
      runHostActionAsync({ action: "server.detach", params: { udid: "--host=0.0.0.0" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("passes params through as literal arguments to a real spawn", async () => {
    const result = await runHostActionAsync(
      {
        action: "permissions.set",
        params: { udid: "U", bundleId: "com.example.app", action: "grant", service: "camera" },
      },
      "echo",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("permissions grant camera com.example.app");
  });

  it("rejects an uploadId that tries to traverse out of the upload directory", async () => {
    for (const uploadId of ["../../evil", "a/b", ".hidden"]) {
      await expect(
        runHostActionAsync({ action: "upload.append", params: { uploadId, data: "aGk=" } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    }
  });

  it("rejects an install with neither an upload nor a path", async () => {
    await expect(
      runHostActionAsync({ action: "app.install", params: { udid: "U" } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses a symlink that escapes the allowed roots", async () => {
    const secret = join(tmpdir(), `probe-secret-${randomUUID()}.txt`);
    const link = join(UPLOAD_DIR, `probe-link-${randomUUID()}.txt`);
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(secret, "SECRET");
    symlinkSync(secret, link);

    try {
      await expect(
        runHostActionAsync({ action: "file.readBase64", params: { path: link } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    } finally {
      rmSync(link, { force: true });
      rmSync(secret, { force: true });
    }
  });

  // The target stays inside the roots: containment is decided before existence, so a dangling link
  // pointing outside them is refused for leaving the roots and never reaches this message.
  it("refuses a symlink whose target cannot be followed", async () => {
    const link = join(UPLOAD_DIR, `probe-dangling-${randomUUID()}.txt`);
    mkdirSync(UPLOAD_DIR, { recursive: true });
    symlinkSync(join(UPLOAD_DIR, `probe-gone-${randomUUID()}.txt`), link);

    try {
      const attempt = runHostActionAsync({ action: "file.readBase64", params: { path: link } }, BIN);
      await expect(attempt).rejects.toBeInstanceOf(InvalidHostActionError);
      await expect(attempt).rejects.toThrow(/is a link this server cannot follow/);
    } finally {
      rmSync(link, { force: true });
    }
  });

  // The link component is a directory, so the escape is only visible partway through resolving the
  // path: lexically every component sits under an allowed root.
  it("refuses a directory symlink inside an allowed root that leads out of them", async () => {
    const outside = join(tmpdir(), `probe-outside-${randomUUID()}`);
    const link = join(UPLOAD_DIR, `probe-dirlink-${randomUUID()}`);
    mkdirSync(UPLOAD_DIR, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "SECRET");
    symlinkSync(outside, link);

    try {
      await expect(
        runHostActionAsync(
          { action: "file.readBase64", params: { path: join(link, "secret.txt") } },
          BIN,
        ),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    } finally {
      rmSync(link, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Staged uploads and staged screenshots are separate roots, and a link between them is ordinary.
  it("accepts a symlink that lands in another allowed root", async () => {
    const target = join(SCREENSHOT_DIR, `probe-target-${randomUUID()}`);
    const link = join(UPLOAD_DIR, `probe-inlink-${randomUUID()}`);
    mkdirSync(UPLOAD_DIR, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "staged.txt"), "hello");
    symlinkSync(target, link);

    try {
      const result = await runHostActionAsync(
        { action: "file.readBase64", params: { path: join(link, "staged.txt") } },
        BIN,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(btoa("hello"));
    } finally {
      rmSync(link, { force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("gives up on a symlink loop rather than following it", async () => {
    const first = join(UPLOAD_DIR, `probe-loop-a-${randomUUID()}`);
    const second = join(UPLOAD_DIR, `probe-loop-b-${randomUUID()}`);
    mkdirSync(UPLOAD_DIR, { recursive: true });
    symlinkSync(second, first);
    symlinkSync(first, second);

    try {
      const attempt = runHostActionAsync(
        { action: "file.readBase64", params: { path: join(first, "payload.txt") } },
        BIN,
      );
      await expect(attempt).rejects.toBeInstanceOf(InvalidHostActionError);
      await expect(attempt).rejects.toThrow(/is a link this server cannot follow/);
    } finally {
      rmSync(first, { force: true });
      rmSync(second, { force: true });
    }
  });

  // An upload target does not exist until the first chunk lands, so a missing leaf is not a link.
  it("accepts a path under an allowed root whose leaf does not exist yet", async () => {
    const target = join(UPLOAD_DIR, `probe-missing-${randomUUID()}.bin`);
    const result = await runHostActionAsync(
      { action: "camera.switch", params: { source: "file", target, udid: "U" } },
      "echo",
    );
    expect(result.stdout).toContain(`camera switch file ${target} -d U --quiet`);
  });

  // A file source is rendered into the preview stream, so it is confined like any other read.
  it("refuses a camera file source outside the allowed roots", async () => {
    await expect(
      runHostActionAsync(
        { action: "camera.switch", params: { source: "file", target: "/etc/passwd", udid: "U" } },
        BIN,
      ),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses coordinates that are not numbers", async () => {
    await expect(
      runHostActionAsync({ action: "location.set", params: { udid: "U", lat: null, lng: null } }, BIN),
    ).rejects.toBeInstanceOf(InvalidHostActionError);
  });

  it("refuses an upload chunk that is empty or not base64", async () => {
    for (const data of ["", "not base64!!"]) {
      await expect(
        runHostActionAsync({ action: "upload.append", params: { uploadId: "a.bin", data } }, BIN),
      ).rejects.toBeInstanceOf(InvalidHostActionError);
    }
  });

  it("accepts a path inside an allowed root", async () => {
    const file = join(UPLOAD_DIR, `probe-ok-${randomUUID()}.txt`);
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(file, "hello");

    try {
      const result = await runHostActionAsync(
        { action: "file.readBase64", params: { path: file } },
        BIN,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(btoa("hello"));
    } finally {
      rmSync(file, { force: true });
    }
  });

  // Both paths fail against a missing binary, so assert which program was actually spawned.
  it("runs a .ts entrypoint through bun rather than executing it directly", async () => {
    const viaBun = await runHostActionAsync(
      { action: "camera.listWebcams" },
      // Under the operator's home dir, so the reply would carry their path if it were not redacted.
      join(homedir(), "does-not-exist", "serve-sim.ts"),
    );
    const direct = await runHostActionAsync(
      { action: "camera.listWebcams" },
      "/does/not/exist/serve-sim",
    );

    // The runtime prints the absolute path it could not load; the reply keeps the reason, not the path.
    expect(viaBun.stderr).toContain("Module not found");
    expect(viaBun.stderr).not.toContain(homedir());
    expect(direct.stderr).toContain("ENOENT");
  });
});
