import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const FFMPEG_COMMIT = "894da5ca7d742e4429ffb2af534fcda0103ef593";
const prefix = "ffmpeg-8.0.1/";

// @ref LLP 0021#nvidia-build-and-verification-scope — publication requires usable pinned sources
export function validateFfmpegSourceArchive(archive, expectedCommit = FFMPEG_COMMIT) {
  // Git writes the source commit in the first global PAX header. Feed just that
  // header to git, avoiding a producer/consumer pipe that can fail with SIGPIPE.
  const tar = gunzipSync(readFileSync(archive), { maxOutputLength: 256 * 1024 * 1024 });
  const actual = execFileSync("git", ["get-tar-commit-id"], {
    input: tar.subarray(0, 1024),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  if (actual !== expectedCommit)
    throw new Error(`FFmpeg source commit mismatch: expected ${expectedCommit}, got ${actual}`);
  const temporary = mkdtempSync(join(tmpdir(), "ffmpeg-source-check-"));
  try {
    const uncompressed = join(temporary, "source.tar");
    writeFileSync(uncompressed, tar);
    const entries = new Set(
      execFileSync("tar", ["-tf", uncompressed], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
        .trim()
        .split("\n"),
    );
    for (const file of ["configure", "COPYING.LGPLv2.1", "libavcodec/nvenc.c"]) {
      if (!entries.has(prefix + file))
        throw new Error(`FFmpeg source archive is incomplete: missing ${prefix}${file}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function createFfmpegSourceArchive(source, output, commit = FFMPEG_COMMIT) {
  mkdirSync(dirname(output), { recursive: true });
  // Do not leave an older archive eligible for publication after a failed rebuild.
  rmSync(output, { force: true });
  const temporary = mkdtempSync(join(dirname(output), ".ffmpeg-source-"));
  try {
    const resolved = execFileSync("git", ["-C", source, "rev-parse", `${commit}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const compressed = join(temporary, "source.tar.gz");
    // Git's built-in gzip writer needs no standalone compressor on macOS.
    execFileSync(
      "git",
      [
        "-C",
        source,
        "archive",
        "--format=tar.gz",
        `--prefix=${prefix}`,
        `--output=${compressed}`,
        resolved,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    validateFfmpegSourceArchive(compressed, resolved);
    renameSync(compressed, output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
