/** The shipped GLB files, read for tests without their images. */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type DEVICE_MODELS } from "../foldable/device-models";

// The Hub ships the models with its dashboard.
export const MODELS = fileURLToPath(
  new URL("../../../../expo-device-hub/assets/device-models/", import.meta.url),
);
export const FILES: Record<keyof typeof DEVICE_MODELS, string> = {
  "ios:iphone-duo": "iphone-duo.glb",
  "ios:iphone-18-pro": "iphone-18-pro.glb",
  "android:pixel-9-pro": "pixel-9-pro.glb",
  "android:pixel-9-pro-fold": "pixel-9-pro-fold.glb",
};

/** The GLB without its images: geometry, materials, and animation are real; image decoding needs a browser. */
export function withoutTextures(path: string): ArrayBuffer {
  const file = readFileSync(path);
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
  const binary = file.subarray(20 + jsonLength);
  delete json.textures;
  delete json.images;
  delete json.samplers;
  const strip = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (key.endsWith("Texture")) delete (value as Record<string, unknown>)[key];
      else strip((value as Record<string, unknown>)[key]);
    }
  };
  for (const material of json.materials ?? []) strip(material);
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const chunk = Buffer.from(text, "utf8");
  const out = Buffer.alloc(20 + chunk.length + binary.length);
  file.copy(out, 0, 0, 12);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(chunk.length, 12);
  out.write("JSON", 16);
  chunk.copy(out, 20);
  binary.copy(out, 20 + chunk.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

/** True when this checkout has the GLB files (they are stored with Git LFS). */
export const MODELS_AVAILABLE = Object.values(FILES).every((file) => existsSync(MODELS + file));
