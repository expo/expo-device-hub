export function shouldStreamSimulatorLogs(location: Pick<Location, "search">): boolean {
  return new URLSearchParams(location.search).get("logs") === "1";
}
