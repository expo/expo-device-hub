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

// @ref LLP 0003#action-catalog — metadata uses fresh device observations without starting an adb query.
/** Capture with fresh observed cache values only; never query the device for metadata. */
export async function captureScreenshot(
  capture: () => Promise<Uint8Array>,
  orientation: Pick<DisplayOrientationReader, "peek">,
): Promise<{ png: Uint8Array; metadata: ScreenshotMetadata }> {
  const before = orientation.peek();
  const png = await capture();
  const after = orientation.peek();
  const metadata = screenshotMetadata();
  if (before && before === after) {
    metadata.displayRotation = before.orientation.replaceAll(
      "_",
      "-",
    ) as ScreenshotMetadata["displayRotation"];
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
