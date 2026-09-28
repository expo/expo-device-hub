import { simEndpoint } from "./sim-endpoint";

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

export function isLoopbackPreviewHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return LOOPBACK_HOSTNAMES.has(normalized) || normalized.endsWith(".localhost");
}

interface FetchScreenshotOptions {
  endpoint?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}

async function screenshotErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
  } catch {}
  return `Screenshot failed (${response.status})`;
}

// `unknown` means the server sent no artifact header, as older serve-sim builds do.
export type ScreenshotArtifact = {
  status: "saved" | "failed" | "disabled" | "unknown";
  error?: string;
};

interface ScreenshotCapture {
  png: Blob;
  artifact: ScreenshotArtifact;
}

// Literal names: screenshot-artifacts.ts imports node:fs and must stay out of the client bundle.
function screenshotArtifact(headers: Headers): ScreenshotArtifact {
  const status = headers.get("X-Expo-Screenshot-Artifact");
  if (status === "failed") {
    const error = headers.get("X-Expo-Screenshot-Artifact-Error")?.trim();
    return error ? { status, error } : { status };
  }
  return status === "saved" || status === "disabled" ? { status } : { status: "unknown" };
}

export async function fetchScreenshotPng(
  deviceUdid: string,
  options: FetchScreenshotOptions = {},
): Promise<ScreenshotCapture> {
  const endpoint = options.endpoint ?? simEndpoint("api/screenshot");
  const separator = endpoint.includes("?") ? "&" : "?";
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${endpoint}${separator}device=${encodeURIComponent(deviceUdid)}`,
    { method: "POST", signal: options.signal },
  );

  if (!response.ok) throw new Error(await screenshotErrorMessage(response));

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== "image/png") {
    throw new Error("Screenshot endpoint did not return a PNG");
  }
  return { png: await response.blob(), artifact: screenshotArtifact(response.headers) };
}

export function triggerBrowserDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
