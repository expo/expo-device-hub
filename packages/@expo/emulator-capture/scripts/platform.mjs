export function supportsNative(platform = process.platform, arch = process.arch) {
  return platform === "linux" && arch === "x64";
}

export function skipMessage(task, platform = process.platform, arch = process.arch) {
  return `[emulator-capture] WARNING: ${task} skipped on ${platform}/${arch}; this experiment builds and runs only on Linux x64. No Linux artifacts were produced by this command. Cross-compilation is not configured.`;
}

export function skipUnlessNative(task) {
  if (!supportsNative()) {
    console.warn(skipMessage(task));
    process.exit(0);
  }
}
