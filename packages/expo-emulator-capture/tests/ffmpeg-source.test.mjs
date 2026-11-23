import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFfmpegSourceArchive,
  validateFfmpegSourceArchive,
} from "../scripts/ffmpeg-source.mjs";

test("a failed source archive command cannot leave a publishable archive", () => {
  const root = mkdtempSync(join(tmpdir(), "ffmpeg-source-"));
  const archive = join(root, "out/source.tar.xz");
  const source = join(root, "repo");
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  try {
    mkdirSync(join(source, "libavcodec"), { recursive: true });
    for (const file of ["configure", "COPYING.LGPLv2.1", "libavcodec/nvenc.c"])
      writeFileSync(join(source, file), "test source\n");
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    createFfmpegSourceArchive(source, archive, "HEAD");
    expect(() => validateFfmpegSourceArchive(archive)).not.toThrow();

    // This is the failure hidden by `git archive | xz` in Bun's shell.
    expect(() => createFfmpegSourceArchive(source, archive, "missing-ref")).toThrow();
    expect(() => validateFfmpegSourceArchive(archive)).toThrow();
    writeFileSync(archive, execFileSync("xz", ["-c"], { input: Buffer.alloc(1024) }));
    expect(() => validateFfmpegSourceArchive(archive)).toThrow("incomplete");

    git("rm", "libavcodec/nvenc.c");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "incomplete",
    );
    expect(() => createFfmpegSourceArchive(source, archive, "HEAD")).toThrow("incomplete");
    expect(() => validateFfmpegSourceArchive(archive)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
