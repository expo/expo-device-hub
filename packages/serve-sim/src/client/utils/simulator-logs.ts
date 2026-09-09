import { isLoopbackPreviewHostname } from "./screenshot-capture";

type PreviewLocation = Pick<Location, "hostname" | "search">;

/**
 * Simulator unified logs are extremely verbose, so remote previews must opt in
 * explicitly. Keep the existing local developer experience unless the URL
 * explicitly disables it.
 */
export function shouldStreamSimulatorLogs(location: PreviewLocation): boolean {
  const override = new URLSearchParams(location.search).get("logs");
  if (override !== null) return override === "1";
  return isLoopbackPreviewHostname(location.hostname);
}
