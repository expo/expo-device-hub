import { Buffer } from "node:buffer";
import {
  SCREENSHOT_ARTIFACT_ERROR_HEADER,
  SCREENSHOT_ARTIFACT_HEADER,
  saveScreenshotArtifact,
  screenshotArtifactHeaders,
} from "./screenshot-artifacts.ts";
import type { ScreenshotArtifactReport, ScreenshotBase64Response } from "./shared/api-contracts.ts";

/** Validate before capture; preserve PNG artifacts even when the response is JPEG. */
export async function screenshotResponse(
  capture: () => Promise<Uint8Array>,
  url: URL,
): Promise<Response> {
  const started = performance.now();
  const width = url.searchParams.has("maxWidth")
    ? Number(url.searchParams.get("maxWidth"))
    : undefined;
  const quality = url.searchParams.has("quality") ? Number(url.searchParams.get("quality")) : 80;
  const format = url.searchParams.get("format") ?? "png";
  if (
    (width !== undefined && (!Number.isInteger(width) || width < 1 || width > 8192)) ||
    !Number.isInteger(quality) ||
    quality < 1 ||
    quality > 100 ||
    !["png", "jpeg", "base64"].includes(format)
  ) {
    return Response.json({ ok: false, error: "Invalid screenshot image options" }, { status: 400 });
  }
  let png = await capture();
  const captured = performance.now();
  let image = png;
  if (width !== undefined || format === "jpeg") {
    const { default: sharp } = await import("sharp");
    if (width !== undefined) {
      png = await sharp(Buffer.from(png))
        .resize({ width, withoutEnlargement: true })
        .png()
        .toBuffer();
    }
    image =
      format === "jpeg"
        ? await sharp(Buffer.from(png))
            .flatten({ background: "white" })
            .jpeg({ quality })
            .toBuffer()
        : png;
  }
  const encoded = performance.now();
  const result = await saveScreenshotArtifact(png);
  const saved = performance.now();
  let response: Response;
  if (format === "base64") {
    const artifact: ScreenshotArtifactReport =
      result.status === "failed"
        ? { status: "failed", error: result.error }
        : { status: result.status };
    const body: ScreenshotBase64Response = {
      ok: true,
      mimeType: "image/png",
      data: Buffer.from(png).toString("base64"),
      artifact,
    };
    response = Response.json(body);
  } else {
    response = new Response(new Uint8Array(image), {
      headers: {
        "Content-Type": format === "jpeg" ? "image/jpeg" : "image/png",
        "Content-Length": String(image.byteLength),
      },
    });
  }
  const finished = performance.now();
  const headers: Record<string, string> = {
    ...screenshotArtifactHeaders(result),
    "Cache-Control": "no-store",
    "Server-Timing": `total;dur=${(finished - started).toFixed(3)}, capture;dur=${(captured - started).toFixed(3)}, encode;dur=${(encoded - captured).toFixed(3)}, artifact;dur=${(saved - encoded).toFixed(3)}`,
    "Access-Control-Expose-Headers": `${SCREENSHOT_ARTIFACT_HEADER}, ${SCREENSHOT_ARTIFACT_ERROR_HEADER}, Server-Timing`,
  };
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
