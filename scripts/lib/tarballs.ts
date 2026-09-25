import { $ } from "bun";
import { readdir } from "node:fs/promises";

export interface Tarball {
  name: string;
  version: string;
  path: string;
}

export async function readTarballs(dir: string): Promise<Tarball[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".tgz")).sort();
  const tarballs: Tarball[] = [];
  for (const file of files) {
    const path = `${dir}/${file}`;
    const pkg = JSON.parse(
      await $`tar -xOzf ${path} package/package.json`.text(),
    );
    tarballs.push({ name: pkg.name, version: pkg.version, path });
  }
  return tarballs;
}
