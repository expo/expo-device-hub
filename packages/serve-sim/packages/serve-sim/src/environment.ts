/** Whether this server is running on a hosted EAS worker, excluding local EAS builds. */
export function isRunningOnEAS(): boolean {
  return process.env.EAS_BUILD_RUNNER === "eas-build";
}
