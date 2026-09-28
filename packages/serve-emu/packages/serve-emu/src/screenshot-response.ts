import { Buffer } from "node:buffer";
import { saveScreenshotArtifact, screenshotArtifactHeaders } from "./screenshot-artifacts.ts";
import type { ScreenshotArtifactReport, ScreenshotBase64Response } from "./shared/api-contracts.ts";

/** Save the capture for session artifacts, then answer `/api/screenshot` with the PNG and the save outcome. */
export async function screenshotResponse(png: Uint8Array, url: URL): Promise<Response> {
  const result = await saveScreenshotArtifact(png);
  const headers = screenshotArtifactHeaders(result);
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
