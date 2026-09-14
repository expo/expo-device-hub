import { $ } from "bun";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
$.cwd(root);
export { $ };

// Both fresh and cached archives must match the pinned digest before extraction.
export async function downloadVerified(url, archive, checksum) {
  await mkdir(dirname(archive), { recursive: true });
  const cached = existsSync(archive);
  const downloaded = cached ? archive : `${archive}.tmp`;
  try {
    if (!cached) await $`curl -fL --retry 2 ${url} -o ${downloaded}`;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(downloaded)) hash.update(chunk);
    if (hash.digest("hex") !== checksum)
      throw new Error(`SHA-256 mismatch: ${downloaded}. Remove the archive and retry.`);
    if (!cached) await rename(downloaded, archive);
  } finally {
    if (!cached) await rm(downloaded, { force: true });
  }
}
