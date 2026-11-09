import { apiUrl } from "./android-api-url";
import { type ScreenshotArtifact, type ScreenshotCapture, type ScreenshotOptions } from "./types";

type ScreenshotFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Capture a still image through serve-sim's or serve-emu's POST-only screenshot endpoint, along with whether it reached the session artifacts. */
export async function fetchScreenshot(
  baseUrl: string,
  device?: string | null,
  fetchImpl: ScreenshotFetch = fetch,
  options?: ScreenshotOptions,
): Promise<ScreenshotCapture | null> {
  let url = `${apiUrl(baseUrl, "/api/screenshot")}${
    device ? `?device=${encodeURIComponent(device)}` : ""
  }`;
  for (const key of ["maxWidth", "format", "quality"] as const) {
    const value = options?.[key];
    if (value !== undefined) {
      url += `${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(String(value))}`;
    }
  }
  try {
    const response = await fetchImpl(url, { method: "POST", cache: "no-store" });
    if (!response.ok) return null;
    return { blob: await response.blob(), artifact: screenshotArtifact(response.headers) };
  } catch {
    return null;
  }
}

function screenshotArtifact(headers: Headers): ScreenshotArtifact | null {
  const status = headers.get("X-Expo-Screenshot-Artifact");
  if (status === null) return null;
  if (status === "failed") {
    const error = headers.get("X-Expo-Screenshot-Artifact-Error")?.trim();
    return error ? { status, error } : { status };
  }
  if (status === "saved" || status === "disabled") return { status };
  console.warn(`Ignoring unknown X-Expo-Screenshot-Artifact value: ${status}`);
  return null;
}
