import { apiUrl } from "./android-api-url";
import { type ScreenshotArtifact, type ScreenshotCapture, type ScreenshotMetadata } from "./types";

type ScreenshotFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Capture a still PNG through serve-sim's or serve-emu's POST-only screenshot endpoint, along with whether it reached the session artifacts. */
export async function fetchScreenshot(
  baseUrl: string,
  device?: string | null,
  fetchImpl: ScreenshotFetch = fetch,
): Promise<ScreenshotCapture | null> {
  const url = `${apiUrl(baseUrl, "/api/screenshot")}${
    device ? `?device=${encodeURIComponent(device)}` : ""
  }`;
  try {
    const response = await fetchImpl(url, { method: "POST", cache: "no-store" });
    if (!response.ok) return null;
    const metadata = screenshotMetadata(response.headers);
    return {
      blob: await response.blob(),
      artifact: screenshotArtifact(response.headers),
      ...(metadata ? { metadata } : {}),
    };
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

function screenshotMetadata(headers: Headers): ScreenshotMetadata | undefined {
  const header = headers.get("X-Expo-Screenshot-Metadata");
  if (!header || header.length > 1024) return;
  try {
    const value: unknown = JSON.parse(header);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    const nonnegative = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (
      !nonnegative(data.width) ||
      !nonnegative(data.height) ||
      !nonnegative(data.displayId) ||
      !nonnegative(data.displayCount)
    )
      return;
    const rotation = data.displayRotation;
    if (
      rotation !== null &&
      rotation !== "portrait" &&
      rotation !== "portrait-upside-down" &&
      rotation !== "landscape-left" &&
      rotation !== "landscape-right"
    )
      return;
    return {
      width: data.width,
      height: data.height,
      displayId: data.displayId,
      displayCount: data.displayCount,
      displayRotation: rotation,
    };
  } catch {
    // Optional metadata must never prevent an otherwise successful PNG download.
    return;
  }
}
