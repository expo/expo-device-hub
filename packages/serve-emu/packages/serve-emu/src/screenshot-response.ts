import type { DisplayOrientationReader } from "./display-orientation.ts";
import {
  SCREENSHOT_METADATA_HEADER,
  screenshotMetadata,
  screenshotMetadataHeaders,
  type ScreenshotMetadata,
} from "./screenshot-metadata.ts";
import { Buffer } from "node:buffer";
import {
  SCREENSHOT_ARTIFACT_ERROR_HEADER,
  SCREENSHOT_ARTIFACT_HEADER,
  saveScreenshotArtifact,
  screenshotArtifactHeaders,
} from "./screenshot-artifacts.ts";
import type { ScreenshotArtifactReport, ScreenshotBase64Response } from "./shared/api-contracts.ts";

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.byteLength < 24 || signature.some((byte, i) => png[i] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(12) !== 0x49484452) return null; // "IHDR"
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// @ref LLP 0003#action-catalog — the rotation is observed around this capture, as serve-sim's comes with its frame.
/**
 * Capture between two display-rotation readings: one that finishes before the capture starts
 * and one that starts after it ends. The rotation is reported only when both agree and match
 * the image's shape, with no Hub rotation command between them, so a single turn around the
 * capture, including a 180-degree one, leaves it null. Width and height come from the PNG, which `screencap` does not scale.
 */
export async function captureScreenshot(
  capture: () => Promise<Uint8Array>,
  orientation: Pick<DisplayOrientationReader, "observe">,
): Promise<{ png: Uint8Array; metadata: ScreenshotMetadata }> {
  const first = await orientation.observe();
  const png = await capture();
  const after = await orientation.observe();
  const metadata = screenshotMetadata();
  const size = pngSize(png);
  if (size) {
    metadata.width = size.width;
    metadata.height = size.height;
  }
  const pose = first?.orientation;
  if (
    pose &&
    pose === after?.orientation &&
    first.generation === after.generation &&
    (!size ||
      size.width === size.height ||
      pose.startsWith("portrait") === size.height > size.width)
  ) {
    metadata.displayRotation = pose.replaceAll("_", "-") as ScreenshotMetadata["displayRotation"];
  }
  return { png, metadata };
}

/** Save the capture for session artifacts, then answer `/api/screenshot` with the PNG and the save outcome. */
export async function screenshotResponse(
  png: Uint8Array,
  url: URL,
  metadata: ScreenshotMetadata = screenshotMetadata(),
): Promise<Response> {
  const result = await saveScreenshotArtifact(png);
  const headers: Record<string, string> = {
    ...screenshotArtifactHeaders(result),
    ...screenshotMetadataHeaders(metadata),
    // An allowed cross-origin caller can read only the custom headers listed here, as in serve-sim.
    "Access-Control-Expose-Headers": `${SCREENSHOT_ARTIFACT_HEADER}, ${SCREENSHOT_ARTIFACT_ERROR_HEADER}, ${SCREENSHOT_METADATA_HEADER}`,
  };
  if (url.searchParams.get("format") === "base64") {
    const artifact: ScreenshotArtifactReport =
      result.status === "failed"
        ? { status: "failed", error: result.error }
        : { status: result.status };
    const body: ScreenshotBase64Response = {
      ok: true,
      mimeType: "image/png",
      data: Buffer.from(png).toString("base64"),
      artifact,
      metadata,
    };
    return Response.json(body, { headers });
  }
  return new Response(new Uint8Array(png), {
    headers: { ...headers, "Content-Type": "image/png" },
  });
}
