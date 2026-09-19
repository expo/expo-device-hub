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
  const archiveExists = existsSync(archive);
  const downloadPath = archiveExists ? archive : `${archive}.tmp`;
  try {
    if (!archiveExists) await $`curl -fL --retry 2 ${url} -o ${downloadPath}`;

    const hash = createHash("sha256");
    for await (const chunk of createReadStream(downloadPath)) hash.update(chunk);
    const actualChecksum = hash.digest("hex");
    if (actualChecksum !== checksum)
      throw new Error(`SHA-256 mismatch: ${downloadPath}. Remove the archive and retry.`);

    if (!archiveExists) await rename(downloadPath, archive);
  } finally {
    if (!archiveExists) await rm(downloadPath, { force: true });
  }
}
