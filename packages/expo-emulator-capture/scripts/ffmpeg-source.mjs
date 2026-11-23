import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const FFMPEG_COMMIT = "894da5ca7d742e4429ffb2af534fcda0103ef593";
const prefix = "ffmpeg-8.0.1/";

// @ref LLP 0021#nvidia-build-and-verification-scope — publication requires usable pinned sources
export function validateFfmpegSourceArchive(archive) {
  const entries = new Set(
    execFileSync("tar", ["-tJf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .trim()
      .split("\n"),
  );
  for (const file of ["configure", "COPYING.LGPLv2.1", "libavcodec/nvenc.c"]) {
    if (!entries.has(prefix + file))
      throw new Error(`FFmpeg source archive is incomplete: missing ${prefix}${file}`);
  }
}

export function createFfmpegSourceArchive(source, output, commit = FFMPEG_COMMIT) {
  mkdirSync(dirname(output), { recursive: true });
  // Do not leave an older archive eligible for publication after a failed rebuild.
  rmSync(output, { force: true });
  const temporary = mkdtempSync(join(dirname(output), ".ffmpeg-source-"));
  try {
    const tar = join(temporary, "source.tar");
    const compressed = join(temporary, "source.tar.xz");
    // Separate commands preserve git's failure status under Bun as well as Node.
    execFileSync("git", [
      "-C",
      source,
      "archive",
      "--format=tar",
      `--prefix=${prefix}`,
      `--output=${tar}`,
      commit,
    ]);
    const fd = openSync(compressed, "wx");
    try {
      execFileSync("xz", ["-c", tar], { stdio: ["ignore", fd, "pipe"] });
    } finally {
      closeSync(fd);
    }
    validateFfmpegSourceArchive(compressed);
    renameSync(compressed, output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
