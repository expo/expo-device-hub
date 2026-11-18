/** The native target for a host, or null when the agent does not build there. */
export function nativeTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return null;
}

export function skipMessage(task, platform = process.platform, arch = process.arch) {
  const linux =
    nativeTarget(platform, arch) === "linux-x64"
      ? " On Linux x86-64, build the Linux agent with bun run build:linux-x64."
      : "";
  return `[expo-emulator-capture] WARNING: ${task} skipped on ${platform}/${arch}; bun run build builds only the macOS agent (darwin-arm64).${linux} No native artifacts were produced by this command.`;
}

/**
 * The target that a build script builds on this host.
 *
 * Without `--target`, it is the macOS agent, and other hosts skip with a warning: the generic
 * `build` task runs everywhere, including Linux CI, and the release builds it on an EAS macOS
 * job. `--target linux-x64` is the Linux agent's own task, so the two agents get separate
 * Turborepo cache entries. A host that cannot build the requested target fails, so that a
 * release build never passes without its agent.
 */
export function requireNativeTarget(task, argv = process.argv.slice(2)) {
  const index = argv.indexOf("--target");
  const requested = index >= 0 ? argv[index + 1] : undefined;
  const host = nativeTarget();
  if (requested !== undefined) {
    if (requested !== host) {
      console.error(
        `[expo-emulator-capture] ${task} --target ${requested} needs a ${requested} host; this host is ${process.platform}/${process.arch}.`,
      );
      process.exit(1);
    }
    return requested;
  }
  if (host !== "darwin-arm64") {
    console.warn(skipMessage(task));
    process.exit(0);
  }
  return host;
}
