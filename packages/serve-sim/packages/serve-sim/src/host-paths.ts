import { lstatSync, readlinkSync, realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, isAbsolute, join, resolve, sep } from "path";
import { z } from "zod";

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** $TMPDIR sits behind a symlink (/var -> /private/var); a canonical path needs a root in that shape. */
const TMP_ROOT = realpathOrSelf(tmpdir());

export const UPLOAD_DIR = join(TMP_ROOT, "serve-sim-uploads");
/** Staged here; only a child writes to the Desktop (see TCC_PROTECTED_DIRS). */
export const SCREENSHOT_DIR = join(TMP_ROOT, "serve-sim-screenshots");
/** Protected (see TCC_PROTECTED_DIRS), so only child processes ever name a path under it. */
export const DESKTOP_DIR = join(homedir(), "Desktop");

/**
 * macOS gates these behind a consent prompt. Opening one on a host with nobody to answer that
 * prompt blocks in the kernel and never returns, and the block cannot be detected or timed out.
 * So this process never opens one: ConfinedPath refuses these lexically, and the Desktop copy in
 * screenshot-store runs in a child. Compared case-insensitively: the root volume folds case, so
 * "/users/x/desktop" opens the same directory as "/Users/x/Desktop".
 */
const TCC_PROTECTED_DIRS = [
  DESKTOP_DIR,
  join(homedir(), "Documents"),
  join(homedir(), "Downloads"),
].map((dir) => dir.toLowerCase());

// Only names the refusal. The allowlist below is what refuses spellings this list does not know,
// such as the /System/Volumes/Data firmlink.
function leadsIntoProtectedLocation(path: string): boolean {
  const folded = path.toLowerCase();
  return TCC_PROTECTED_DIRS.some((dir) => folded === dir || folded.startsWith(dir + sep));
}

// Each root in the spelling a caller sends and in its realpath, because a path is compared lexically
// before it is canonicalized. None may sit under TCC_PROTECTED_DIRS: a path under a root is opened.
const ALLOWED_ROOTS = [
  ...new Set(
    [
      join(homedir(), "Library", "Developer", "CoreSimulator", "Devices"),
      // Apple's own apps live in the runtime root, not under a device's data container.
      "/Library/Developer/CoreSimulator",
      join(tmpdir(), basename(UPLOAD_DIR)),
      join(tmpdir(), basename(SCREENSHOT_DIR)),
      UPLOAD_DIR,
      SCREENSHOT_DIR,
    ].flatMap((root) => [root, realpathOrSelf(root)]),
  ),
];

/** A value passed straight to a program: a leading "-" would be read as a flag. */
export const Argument = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\p{C}]+$/u, "must not contain control characters")
  .refine((v) => !v.startsWith("-"), 'must not start with "-"');

function isUnderAllowedRoot(path: string): boolean {
  return ALLOWED_ROOTS.some((root) => path === root || path.startsWith(root + sep));
}

/** What macOS itself follows before it gives up with ELOOP (MAXSYMLINKS, sys/param.h). */
const MAX_SYMLINK_HOPS = 32;

/**
 * Canonicalizes one component at a time, in place of `realpathSync`, which resolves the whole path
 * inside a single `openat` walk: a symlink under an allowed root can point at a TCC_PROTECTED_DIRS
 * entry, and by the time realpath returns the target it has already opened it. `lstat` and
 * `readlink` report a link without opening what it names, so every prefix is checked against
 * ALLOWED_ROOTS before either one runs and nothing outside them is ever touched.
 *
 * Returns the canonical path, or the first resolved path that left the roots so the caller's
 * containment check refuses it, or null when a link exists but cannot be followed.
 */
function resolveWithinRoots(absolutePath: string): string | null {
  let prefix: string = sep;
  let parts = absolutePath.split(sep).filter(Boolean);
  let hops = 0;
  let leafIsLink = false;

  for (let component = parts.shift(); component !== undefined; component = parts.shift()) {
    const candidate = join(prefix, component);
    const whole = join(candidate, ...parts);
    if (leadsIntoProtectedLocation(whole) || !isUnderAllowedRoot(whole)) return whole;

    let isLink: boolean;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch {
      // Nothing below this exists, so no component under it can be a link and `whole` is already
      // canonical. A leaf reached by following a link is dangling, not a write about to happen.
      return parts.length === 0 && leafIsLink ? null : whole;
    }

    if (!isLink) {
      prefix = candidate;
      continue;
    }

    if (++hops > MAX_SYMLINK_HOPS) return null;
    if (parts.length === 0) leafIsLink = true;
    const target = readlinkSync(candidate);
    // A relative target hangs off the link's own directory, which is the prefix resolved so far.
    const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(prefix, target);
    prefix = sep;
    parts = [...resolvedTarget.split(sep).filter(Boolean), ...parts];
  }

  return prefix;
}

/**
 * A caller-named path, confined to ALLOWED_ROOTS: everything the preview legitimately touches is a
 * simulator app container, a screenshot this server took, or a file it staged. Decided on the
 * resolved string before anything is canonicalized, because canonicalizing opens the path and
 * opening a TCC_PROTECTED_DIRS entry on a host with nobody to answer the consent prompt never
 * returns. Only a path already known to sit under an allowed root is opened, and its canonical form
 * is checked again so a symlink under a root cannot point elsewhere.
 */
const OUTSIDE_ROOTS = "is outside the paths this preview may read";

export const ConfinedPath = Argument.refine(
  (value) => !leadsIntoProtectedLocation(resolve(value)),
  { error: "is inside a location this host protects", abort: true },
)
  .refine((value) => isUnderAllowedRoot(resolve(value)), {
    error: OUTSIDE_ROOTS,
    // zod runs every refine even after one fails, and the next one touches the filesystem.
    abort: true,
  })
  .transform((value, ctx) => {
    const resolved = resolveWithinRoots(resolve(value));
    if (resolved === null) {
      ctx.addIssue({ code: "custom", message: "is a link this server cannot follow", fatal: true });
      return z.NEVER;
    }
    return resolved;
  })
  .refine(isUnderAllowedRoot, OUTSIDE_ROOTS);
