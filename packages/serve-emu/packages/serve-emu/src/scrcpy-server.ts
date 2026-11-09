import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Pinned scrcpy server version. Bumping it means re-validating the wire protocol
// in `scrcpy.ts` (the framing drifts between scrcpy majors).
// @ref LLP 0008#scrcpy-upgrade-checklist — Canonical wire spec and upgrade checklist
export const SCRCPY_VERSION = "4.0";

const DEFAULT_BASE_URL = "https://github.com/Genymobile/scrcpy/releases/download";

// GitHub release downloads sometimes return 5xx, which fails the session. A host can point the
// download at a mirror with SERVE_EMU_SCRCPY_BASE_URL. The mirror keeps the release layout, so
// a version bump fetches the matching file. Temporary failures are retried.
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

const here = dirname(fileURLToPath(import.meta.url));
// `src/scrcpy-server.ts` → `<pkg>/vendor`; `dist/scrcpy-server.mjs` → `<pkg>/vendor`.
const VENDOR_DIR = join(here, "..", "vendor");
export const SCRCPY_SERVER_PATH = join(VENDOR_DIR, `scrcpy-server-v${SCRCPY_VERSION}`);

export function scrcpyServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.SERVE_EMU_SCRCPY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
}

// Errors and logs show a download URL without credentials or a query string.
function redactUrl(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return "<invalid URL>";
  }
}

export async function downloadWithRetry(
  url: string,
  { attempts = DOWNLOAD_ATTEMPTS, baseDelayMs = RETRY_BASE_DELAY_MS } = {},
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      lastError = new Error(
        `Failed to download ${redactUrl(url)}: ${res.status} ${res.statusText}`,
      );
      // A 4xx other than 429 does not change on a retry.
      if (res.status < 500 && res.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

// A mirror that fails falls back to the GitHub release, so a missing or broken mirror does not
// fail a download that GitHub can still serve.
export async function downloadScrcpyServer(
  env: NodeJS.ProcessEnv = process.env,
  options?: { attempts?: number; baseDelayMs?: number },
): Promise<Uint8Array> {
  const url = scrcpyServerUrl(env);
  const githubUrl = scrcpyServerUrl({});
  if (url === githubUrl) return downloadWithRetry(url, options);
  try {
    return await downloadWithRetry(url, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Could not download from the mirror (${reason}); trying ${githubUrl}`);
    return downloadWithRetry(githubUrl, options);
  }
}

export async function ensureScrcpyServer(): Promise<string> {
  if (existsSync(SCRCPY_SERVER_PATH)) return SCRCPY_SERVER_PATH;
  await mkdir(VENDOR_DIR, { recursive: true });
  console.log(`Downloading scrcpy-server v${SCRCPY_VERSION}…`);
  const buf = await downloadScrcpyServer();
  await writeFile(SCRCPY_SERVER_PATH, buf);
  console.log(`Saved ${SCRCPY_SERVER_PATH} (${buf.byteLength} bytes)`);
  return SCRCPY_SERVER_PATH;
}
