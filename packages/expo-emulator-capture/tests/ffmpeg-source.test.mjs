import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  createFfmpegSourceArchive,
  validateFfmpegSourceArchive,
} from "../scripts/ffmpeg-source.mjs";

function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {}
  }
  throw new Error(`${name} not found on PATH`);
}

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
    for (const tool of ["git", "tar"]) symlinkSync(executable(tool), join(tools, tool));
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

test("a failing archive command discards partial output after valid commit resolution", () =>
  fixture(({ root, source, archive, initial }) => {
    createFfmpegSourceArchive(source, archive, initial);
    const tools = join(root, "failing-git");
    const marker = join(root, "archive-attempted");
    mkdirSync(tools);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      join(tools, "git"),
      `#!/bin/sh
for argument do
  if [ "$argument" = archive ]; then
    for argument do
      case "$argument" in --output=*) printf partial > "\${argument#--output=}" ;; esac
    done
    printf 'archive failed after resolution' > ${quote(marker)}
    exit 73
  fi
done
exec ${quote(executable("git"))} "$@"
`,
      { mode: 0o755 },
    );
    const module = new URL("../scripts/ffmpeg-source.mjs", import.meta.url).href;
    const code = `import {createFfmpegSourceArchive} from ${JSON.stringify(module)};
      createFfmpegSourceArchive(${JSON.stringify(source)},${JSON.stringify(archive)},${JSON.stringify(initial)});`;
    const result = spawnSync(process.execPath, ["--eval", code], {
      env: { ...process.env, PATH: tools + delimiter + process.env.PATH },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("archive failed after resolution");
    expect(existsSync(archive)).toBe(false);
    expect(readdirSync(dirname(archive))).toEqual([]);
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
