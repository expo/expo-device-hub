/**
 * Checks the files that `npm publish` would put in the package against the
 * manifest. The tests read `package.json` and the source tree, so a `files`
 * entry that matches nothing, or build output that is absent, passes them.
 *
 * `bun run test:package` packs the package without writing it and runs the
 * check. It needs the build output in `dist` and `npm` on the PATH.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PackageManifest {
  files: string[];
  exports: Record<string, unknown>;
  main?: string;
  module?: string;
  types?: string;
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function readManifest(): PackageManifest {
  return JSON.parse(readFileSync(`${PACKAGE_ROOT}package.json`, "utf8")) as PackageManifest;
}

/** Every file that the manifest's entry points name, relative to the package root. */
export function entryPointFiles(manifest: PackageManifest): string[] {
  const files = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string") files.add(value.replace(/^\.\//, ""));
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect([manifest.main, manifest.module, manifest.types, manifest.exports]);
  return [...files].sort();
}

/** A `files` entry is a file, a directory, or a pattern with `*` in one path segment. */
function matchesFilesEntry(pattern: string, path: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${expression}(/|$)`).test(path);
}

const isTestFile = (path: string) => /(^|\/)__tests__\//.test(path) || /\.test\.\w+$/.test(path);

/** What is wrong with a packed file list, one line per problem. None is an empty list. */
export function packedFileProblems(manifest: PackageManifest, packed: readonly string[]): string[] {
  const problems: string[] = [];
  const packedFiles = new Set(packed);
  for (const file of entryPointFiles(manifest)) {
    if (!packedFiles.has(file)) problems.push(`An entry point names ${file}, which is not packed.`);
  }
  for (const entry of manifest.files) {
    const excludes = entry.startsWith("!");
    const pattern = excludes ? entry.slice(1) : entry;
    const matched = packed.filter((path) => matchesFilesEntry(pattern, path));
    if (excludes && matched.length > 0) {
      problems.push(`"files" excludes ${pattern}, but ${matched[0]} is packed.`);
    }
    if (!excludes && matched.length === 0) {
      problems.push(`"files" has ${entry}, which matches no packed file.`);
    }
  }
  for (const path of packed) {
    if (isTestFile(path)) problems.push(`${path} is a test file.`);
  }
  return problems;
}

/** The paths that `npm pack` would write, from its report, without a tarball. */
function npmPackedFiles(): string[] {
  const npm = Bun.which("npm");
  if (!npm) throw new Error("npm is not on the PATH.");
  const { exitCode, stdout, stderr } = Bun.spawnSync(
    [npm, "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (exitCode !== 0) throw new Error(`npm pack failed (${exitCode}):\n${stderr.toString()}`);
  const [report] = JSON.parse(stdout.toString()) as [{ files: { path: string }[] }];
  return report.files.map((file) => file.path);
}

if (import.meta.main) {
  const packed = npmPackedFiles();
  const problems = packedFileProblems(readManifest(), packed);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`\nThe package content is wrong. Is the build output in dist? (bun run build)`);
    process.exit(1);
  }
  console.log(`The package has ${packed.length} files and every entry point's file.`);
}
