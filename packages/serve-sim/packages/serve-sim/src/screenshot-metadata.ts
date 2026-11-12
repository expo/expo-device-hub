/** Screenshot values are unknown until the capture source supplies them. */
export type ScreenshotMetadata = {
  width: number;
  height: number;
  displayRotation:
    | "portrait"
    | "portrait-upside-down"
    | "landscape-left"
    | "landscape-right"
    | null;
  /** Two-panel device identity; omitted for single-display devices or unknown panels. */
  screen?: "inner" | "outer";
};

export function screenshotMetadata(): ScreenshotMetadata {
  return { width: 0, height: 0, displayRotation: null };
}

export const SCREENSHOT_METADATA_HEADER = "X-Expo-Screenshot-Metadata";

export function screenshotMetadataHeaders(metadata = screenshotMetadata()): Record<string, string> {
  return { [SCREENSHOT_METADATA_HEADER]: JSON.stringify(metadata) };
}
