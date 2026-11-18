/** The native target for a host, or null when the agent does not build there. */
export function nativeTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return null;
}

export function skipMessage(task, platform = process.platform, arch = process.arch) {
  return `[expo-emulator-capture] WARNING: ${task} skipped on ${platform}/${arch}; the capture agent builds and runs only on macOS with Apple silicon (darwin-arm64). No native artifacts were produced by this command.`;
}

/** Returns this host's native target, or exits with a warning when there is none. */
export function requireNativeTarget(task) {
  const target = nativeTarget();
  if (!target) {
    console.warn(skipMessage(task));
    process.exit(0);
  }
  return target;
}
