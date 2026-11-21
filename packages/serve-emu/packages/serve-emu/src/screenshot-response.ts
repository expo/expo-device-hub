import type { DisplayOrientationReader } from "./display-orientation.ts";
import {
  SCREENSHOT_METADATA_HEADER,
  screenshotMetadata,
  screenshotMetadataHeaders,
  type ScreenshotMetadata,
} from "./screenshot-metadata.ts";
import { Buffer } from "node:buffer";
import { ApiError } from "./api/api-error.ts";
import { readBodyBytes } from "./api/body.ts";
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

const MAX_SCREENSHOT_REQUEST_BYTES = 1024;

/** What `GET /api` reports, so a client can tell this server accepts `{ "automation": true }`. */
export const SCREENSHOT_CAPABILITIES = { automation: true } as const;

/**
 * Read the optional `{ "automation": true }` body. An empty body is a manual capture. Anything
 * else is an error response, returned before the capture starts.
 */
async function readAutomation(request: Request | undefined): Promise<boolean | Response> {
  if (!request) return false;
  let bytes: Uint8Array;
  try {
    bytes = await readBodyBytes(request, MAX_SCREENSHOT_REQUEST_BYTES);
  } catch (error) {
    const tooLarge = error instanceof ApiError && error.status === 413;
    return Response.json(
      {
        ok: false,
        error: tooLarge ? "Screenshot request is too large" : "Invalid screenshot request",
      },
      { status: tooLarge ? 413 : 400 },
    );
  }
  if (bytes.byteLength === 0) return false;
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).every((key) => key === "automation") &&
      ["boolean", "undefined"].includes(typeof (body as { automation?: unknown }).automation)
    ) {
      return (body as { automation?: boolean }).automation === true;
    }
  } catch {}
  return Response.json({ ok: false, error: "Invalid screenshot request" }, { status: 400 });
}

// @ref LLP 0003#android-screenshot-images — keep PNG session artifacts for JPEG responses.
/**
 * Answer `POST /api/screenshot`. With `request`, its optional JSON body may set
 * `automation: true`, which skips the session artifact, as serve-sim's does.
 */
export async function screenshotResponse(
  capture: () => Promise<{ png: Uint8Array; metadata?: ScreenshotMetadata }>,
  url: URL,
  request?: Request,
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
  const automation = await readAutomation(request);
  if (automation instanceof Response) return automation;
  let { png, metadata = screenshotMetadata() } = await capture();
  const captured = performance.now();
  let image = png;
  if (width !== undefined || format === "jpeg") {
    const { default: sharp } = await import("sharp");
    if (width !== undefined) {
      png = await sharp(Buffer.from(png))
        .resize({ width, withoutEnlargement: true })
        .png()
        .toBuffer();
      const size = pngSize(png);
      if (size) metadata = { ...metadata, ...size };
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
  // @ref LLP 0003#android-screenshot-images — automated captures, such as session previews, are not user screenshots.
  const result = automation ? { status: "disabled" as const } : await saveScreenshotArtifact(png);
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
      metadata,
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
    ...screenshotMetadataHeaders(metadata),
    "Cache-Control": "no-store",
    "Server-Timing": `total;dur=${(finished - started).toFixed(3)}, capture;dur=${(captured - started).toFixed(3)}, encode;dur=${(encoded - captured).toFixed(3)}, artifact;dur=${(saved - encoded).toFixed(3)}`,
    "Access-Control-Expose-Headers": `${SCREENSHOT_ARTIFACT_HEADER}, ${SCREENSHOT_ARTIFACT_ERROR_HEADER}, ${SCREENSHOT_METADATA_HEADER}, Server-Timing`,
  };
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
