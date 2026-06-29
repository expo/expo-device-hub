import type { AndroidSystemImage } from "./types";

const PACKAGE_PREFIX = "system-images;";

/**
 * Parse the output of `sdkmanager --list_installed`, keeping only the
 * `system-images;…` rows of its `Path | Version | Description | Location` table.
 *
 * The header, separator, loading/progress noise and every non-system-image
 * package are ignored, so the full command output can be passed in unfiltered.
 * Never throws.
 */
export function parseSystemImages(stdout: string): AndroidSystemImage[] {
  const images: AndroidSystemImage[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const cells = rawLine.split("|").map((cell) => cell.trim());

    const pkg = cells[0];
    if (!pkg || !pkg.startsWith(PACKAGE_PREFIX)) continue;

    images.push(toSystemImage(pkg, cells));
  }

  return images;
}

function toSystemImage(pkg: string, cells: string[]): AndroidSystemImage {
  const [, apiLevel, tag, abi] = pkg.split(";");

  return {
    package: pkg,
    apiLevel: apiLevel || null,
    tag: tag || null,
    abi: abi || null,
    version: cells[1] ?? "",
    description: cells[2] ?? "",
    location: cells[3] ?? "",
  };
}
