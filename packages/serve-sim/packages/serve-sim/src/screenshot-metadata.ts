/** Dimensions of the encoded PNG, not the device framebuffer or physical pose. */
export type ScreenshotMetadata = { width: number; height: number };

export function screenshotMetadata(png: Uint8Array): ScreenshotMetadata | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (png.length < 33 || !signature.every((byte, index) => png[index] === byte)) return;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Check only the fixed-size IHDR, not the compressed pixel stream.
  let crc = 0xffffffff;
  for (const byte of png.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(29)) return;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return;
  return { width, height };
}

export const SCREENSHOT_METADATA_HEADER = "X-Expo-Screenshot-Metadata";

export function screenshotMetadataHeaders(png: Uint8Array): Record<string, string> {
  const metadata = screenshotMetadata(png);
  return metadata ? { [SCREENSHOT_METADATA_HEADER]: JSON.stringify(metadata) } : {};
}
