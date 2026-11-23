import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  createFfmpegSourceArchive,
  validateFfmpegSourceArchive,
} from "../scripts/ffmpeg-source.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "ffmpeg-source-"));
  const archive = join(root, "out/source.tar.gz");
  const source = join(root, "repo");
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  const commit = () => {
    git("add", "-A");
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
    return git("rev-parse", "HEAD").toString().trim();
  };
  try {
    mkdirSync(join(source, "libavcodec"), { recursive: true });
    for (const file of ["configure", "COPYING.LGPLv2.1", "libavcodec/nvenc.c"])
      writeFileSync(join(source, file), "test source\n");
    git("init", "--quiet");
    run({ root, archive, source, git, commit, initial: commit() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("source packaging and validation need no standalone compressor", () =>
  fixture(({ root, source, archive, initial }) => {
    const tools = join(root, "tools");
    mkdirSync(tools);
    for (const tool of ["git", "tar"]) symlinkSync(`/usr/bin/${tool}`, join(tools, tool));
    const module = new URL("../scripts/ffmpeg-source.mjs", import.meta.url).href;
    const code = `import {createFfmpegSourceArchive,validateFfmpegSourceArchive} from ${JSON.stringify(module)};
    createFfmpegSourceArchive(${JSON.stringify(source)},${JSON.stringify(archive)},${JSON.stringify(initial)});
    validateFfmpegSourceArchive(${JSON.stringify(archive)},${JSON.stringify(initial)});`;
    // Even a machine with Homebrew xz/gzip installed must exercise the portable path.
    expect(() =>
      execFileSync(process.execPath, ["--eval", code], {
        env: { ...process.env, PATH: tools },
        stdio: "pipe",
      }),
    ).not.toThrow();
    expect(existsSync(archive)).toBe(true);
  }));

test("publication rejects a complete archive from the wrong source commit", () =>
  fixture(({ source, archive, initial, commit }) => {
    createFfmpegSourceArchive(source, archive, initial);
    expect(() => validateFfmpegSourceArchive(archive, initial)).not.toThrow();
    // The default publication check must compare with the real pinned FFmpeg SHA.
    expect(() => validateFfmpegSourceArchive(archive)).toThrow("source commit mismatch");
    writeFileSync(join(source, "libavcodec/nvenc.c"), "another revision\n");
    const changed = commit();
    createFfmpegSourceArchive(source, archive, changed);
    expect(() => validateFfmpegSourceArchive(archive, changed)).not.toThrow();
    expect(() => validateFfmpegSourceArchive(archive, initial)).toThrow("source commit mismatch");
  }));

test("failed, empty and incomplete archives cannot remain publishable", () =>
  fixture(({ source, archive, initial, commit }) => {
    createFfmpegSourceArchive(source, archive, initial);
    // This is the git failure hidden by the former shell pipeline.
    expect(() => createFfmpegSourceArchive(source, archive, "missing-ref")).toThrow();
    expect(existsSync(archive)).toBe(false);
    writeFileSync(archive, gzipSync(Buffer.alloc(1024)));
    expect(() => validateFfmpegSourceArchive(archive, initial)).toThrow();
    rmSync(join(source, "libavcodec/nvenc.c"));
    const incomplete = commit();
    expect(() => createFfmpegSourceArchive(source, archive, incomplete)).toThrow("incomplete");
    expect(existsSync(archive)).toBe(false);
  }));
