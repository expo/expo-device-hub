import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** The session host uploads completed PNGs from this directory. */
export async function saveScreenshotArtifact(
  png: Uint8Array,
  directory = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY,
): Promise<void> {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const filename = `screenshot-${randomUUID()}.png`;
  const temporary = join(directory, `${filename}.tmp`);
  try {
    await writeFile(temporary, png, { flag: "wx", mode: 0o600 });
    await rename(temporary, join(directory, filename));
  } finally {
    await rm(temporary, { force: true });
  }
}
