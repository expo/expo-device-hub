import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";

test("private authority stays denied through broadened roots and symlinks", async () => {
  const root = realpathSync("/tmp");
  const temporary = mkdtempSync(join(root, "serve-sim-path-test-"));
  const authority = mkdtempSync(join(root, "serve-sim-owner-"));
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = temporary;
    const stagedTemporary = join(temporary, "serve-sim-uploads", temporary.split("/").at(-1)!);
    symlinkSync(root, join(temporary, "serve-sim-uploads"));
    writeFileSync(join(temporary, "ordinary"), "allowed");
    // Only the mkdtemp spelling of the authority directory is refused, not files that share its prefix.
    writeFileSync(join(temporary, "serve-sim-owner-report.txt"), "allowed");
    mkdirSync(join(temporary, "serve-sim-owner-notes"));
    writeFileSync(join(temporary, "serve-sim-owner-notes", "file"), "allowed");
    writeFileSync(join(authority, "authority"), "private");
    symlinkSync(authority, join(temporary, "alias"));
    const { ConfinedPath } = await import("../../host-paths");
    for (const name of ["ordinary", "serve-sim-owner-report.txt", "serve-sim-owner-notes/file"])
      expect(ConfinedPath.safeParse(join(stagedTemporary, name)).success).toBe(true);
    for (const path of [
      join(authority, "authority"),
      join("/System/Volumes/Data/private/tmp", authority.split("/").at(-1)!, "authority"),
      join("/tmp", authority.split("/").at(-1)!, "authority"),
      join(stagedTemporary, "alias", "authority"),
      join(temporary, "serve-sim-uploads", authority.split("/").at(-1)!, "authority"),
    ])
      expect(ConfinedPath.safeParse(path).success).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(temporary, { recursive: true, force: true });
    rmSync(authority, { recursive: true, force: true });
  }
});
