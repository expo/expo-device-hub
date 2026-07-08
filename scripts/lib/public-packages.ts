import { Glob } from "bun";

interface PublicPackage {
  name: string;
  dir: string;
  version: string;
}

export async function getPublicPackages(
  root = process.cwd(),
): Promise<PublicPackage[]> {
  const rootPkg = await Bun.file(`${root}/package.json`).json();
  const patterns: string[] = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : Array.isArray(rootPkg.workspaces?.packages)
    ? rootPkg.workspaces.packages
    : [];

  const seen = new Set<string>();
  const packages: PublicPackage[] = [];

  for (const pattern of patterns) {
    const glob = new Glob(`${pattern}/package.json`);
    for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
      const dir = rel.slice(0, -"/package.json".length);
      if (seen.has(dir)) continue;
      seen.add(dir);

      const pkg = await Bun.file(`${root}/${rel}`).json();
      if (pkg.private === true) continue;
      if (!pkg.name || !pkg.version) continue;
      packages.push({ name: pkg.name, dir, version: pkg.version });
    }
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}
