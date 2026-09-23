type PreviewLocation = Pick<Location, "hostname" | "search">;

/**
 * Simulator unified logs are extremely verbose. The in-page drawer is the
 * default reader; dumping them to the browser console is opt-in (`?logs=1`).
 */
export function shouldStreamSimulatorLogs(location: PreviewLocation): boolean {
  return new URLSearchParams(location.search).get("logs") === "1";
}
