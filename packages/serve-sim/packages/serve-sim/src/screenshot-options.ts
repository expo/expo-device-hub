import { z } from "zod";

/** Optional image output settings; omission preserves native-resolution PNG. */
export const ScreenshotImageOptions = z.object({
  maxWidth: z.number().int().min(1).max(8192).optional(),
  format: z.enum(["png", "jpeg"]).optional(),
  quality: z.number().int().min(1).max(100).optional(),
});
