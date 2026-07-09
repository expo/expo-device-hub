import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Pinned scrcpy server version. Bumping it means re-validating the wire protocol
// in `scrcpy.ts` (the framing drifts between scrcpy majors).
export const SCRCPY_VERSION = "4.0";

const DOWNLOAD_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;

const here = dirname(fileURLToPath(import.meta.url));
// `src/scrcpy-server.ts` → `<pkg>/vendor`; `dist/scrcpy-server.mjs` → `<pkg>/vendor`.
const VENDOR_DIR = join(here, "..", "vendor");
export const SCRCPY_SERVER_PATH = join(VENDOR_DIR, `scrcpy-server-v${SCRCPY_VERSION}`);

export async function ensureScrcpyServer(): Promise<string> {
  if (existsSync(SCRCPY_SERVER_PATH)) return SCRCPY_SERVER_PATH;
  await mkdir(VENDOR_DIR, { recursive: true });
  console.log(`Downloading scrcpy-server v${SCRCPY_VERSION}…`);
  const res = await fetch(DOWNLOAD_URL);
  if (!res.ok) throw new Error(`Failed to download ${DOWNLOAD_URL}: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(SCRCPY_SERVER_PATH, buf);
  console.log(`Saved ${SCRCPY_SERVER_PATH} (${buf.byteLength} bytes)`);
  return SCRCPY_SERVER_PATH;
}
