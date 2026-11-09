import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Pinned scrcpy server version. Bumping it means re-validating the wire protocol
// in `scrcpy.ts` (the framing drifts between scrcpy majors).
// @ref LLP 0008#scrcpy-upgrade-checklist — Canonical wire spec and upgrade checklist
export const SCRCPY_VERSION = "4.0";

export const SCRCPY_BASE_URL_ENV = "SERVE_EMU_SCRCPY_BASE_URL";
export const DEFAULT_SCRCPY_DOWNLOAD_BASE_URL =
  "https://github.com/Genymobile/scrcpy/releases/download";

// Mirrors must use the GitHub release layout: `<base>/v<version>/scrcpy-server-v<version>`.
export function scrcpyServerDownloadUrl(
  baseUrl: string | undefined = process.env[SCRCPY_BASE_URL_ENV],
): string {
  const base = (baseUrl?.trim() || DEFAULT_SCRCPY_DOWNLOAD_BASE_URL).replace(/\/+$/, "");
  return `${base}/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
}

const here = dirname(fileURLToPath(import.meta.url));
// `src/scrcpy-server.ts` → `<pkg>/vendor`; `dist/scrcpy-server.mjs` → `<pkg>/vendor`.
const VENDOR_DIR = join(here, "..", "vendor");
export const SCRCPY_SERVER_PATH = join(VENDOR_DIR, `scrcpy-server-v${SCRCPY_VERSION}`);

export async function ensureScrcpyServer(): Promise<string> {
  if (existsSync(SCRCPY_SERVER_PATH)) return SCRCPY_SERVER_PATH;
  await mkdir(VENDOR_DIR, { recursive: true });
  const url = scrcpyServerDownloadUrl();
  console.log(`Downloading scrcpy-server v${SCRCPY_VERSION} from ${url}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(SCRCPY_SERVER_PATH, buf);
  console.log(`Saved ${SCRCPY_SERVER_PATH} (${buf.byteLength} bytes)`);
  return SCRCPY_SERVER_PATH;
}
