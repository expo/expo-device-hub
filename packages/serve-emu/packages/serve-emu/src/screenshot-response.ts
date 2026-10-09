import { Buffer } from "node:buffer";
import {
  SCREENSHOT_ARTIFACT_ERROR_HEADER,
  SCREENSHOT_ARTIFACT_HEADER,
  saveScreenshotArtifact,
  screenshotArtifactHeaders,
} from "./screenshot-artifacts.ts";
import type { ScreenshotArtifactReport, ScreenshotBase64Response } from "./shared/api-contracts.ts";

/** Save the capture for session artifacts, then answer `/api/screenshot` with the PNG and the save outcome. */
export async function screenshotResponse(png: Uint8Array, url: URL): Promise<Response> {
  const result = await saveScreenshotArtifact(png);
  const headers: Record<string, string> = {
    ...screenshotArtifactHeaders(result),
    // An allowed cross-origin caller can read only the custom headers listed here, as in serve-sim.
    "Access-Control-Expose-Headers": `${SCREENSHOT_ARTIFACT_HEADER}, ${SCREENSHOT_ARTIFACT_ERROR_HEADER}`,
  };
  if (url.searchParams.get("format") === "base64") {
    const artifact: ScreenshotArtifactReport =
      result.status === "failed" ? { status: "failed", error: result.error } : { status: result.status };
    const body: ScreenshotBase64Response = {
      ok: true,
      mimeType: "image/png",
      data: Buffer.from(png).toString("base64"),
      artifact,
    };
    return Response.json(body, { headers });
  }
  return new Response(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png" } });
}
