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
  displayId: number;
  displayCount: number;
};

export function screenshotMetadata(): ScreenshotMetadata {
  return { width: 0, height: 0, displayRotation: null, displayId: 0, displayCount: 0 };
}

export const SCREENSHOT_METADATA_HEADER = "X-Expo-Screenshot-Metadata";

export function screenshotMetadataHeaders(): Record<string, string> {
  return { [SCREENSHOT_METADATA_HEADER]: JSON.stringify(screenshotMetadata()) };
}
