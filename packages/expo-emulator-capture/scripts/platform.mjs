export function supportsNative(platform = process.platform, arch = process.arch) {
  return platform === "darwin" && arch === "arm64";
}

export function skipMessage(task, platform = process.platform, arch = process.arch) {
  return `[expo-emulator-capture] WARNING: ${task} skipped on ${platform}/${arch}; the capture agent builds and runs only on macOS with Apple silicon (darwin-arm64). No native artifacts were produced by this command.`;
}

export function unlessDarwinArm64(task) {
  if (!supportsNative()) {
    console.warn(skipMessage(task));
    process.exit(0);
  }
}
