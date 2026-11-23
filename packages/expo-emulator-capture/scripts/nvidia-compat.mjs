// R570 can JIT CUDA 12.8 / PTX 8.7. A newer override must not silently raise
// the published runtime requirement even when it still targets compute_75.
export function validateNvidiaPtx(source) {
  const version = /^\s*\.version\s+(\d+)\.(\d+)\s*$/m.exec(source);
  if (!version || Number(version[1]) > 8 || (Number(version[1]) === 8 && Number(version[2]) > 7)) {
    throw new Error(
      "NVIDIA transform requires PTX 8.7 or older for R570; use pinned NVRTC 12.8.93",
    );
  }
}

// Keep source/release builds from silently raising the prebuilt agent's libc
// requirement when the release image advances to a newer Ubuntu version.
export function validateNvidiaGlibc(versionInfo) {
  const versions = [...versionInfo.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.\d+)?/g)];
  if (!versions.length)
    throw new Error("NVIDIA agent has no inspectable glibc version requirements");
  for (const [, major, minor] of versions) {
    if (Number(major) > 2 || (Number(major) === 2 && Number(minor) > 38))
      throw new Error(`NVIDIA agent requires glibc ${major}.${minor}; prebuilt limit is 2.38`);
  }
}
