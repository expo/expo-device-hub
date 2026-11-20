import type { ApplePhysicalDevice } from "./types";

const MINIMUM_OS_MAJOR = 27;
const MINIMUM_CORE_DEVICE_MAJOR = 642;

// @ref LLP 0027#listing — same order and words as serve-sim's native physicalDeviceSupport
/**
 * Why a listed phone cannot stream yet, or null when it can. Streaming a phone needs the
 * CoreDevice framework of Xcode 27 (version 642 or newer) on this Mac and iOS 27 on the phone. An
 * unreadable CoreDevice version counts as too old. The Mac is checked first.
 */
export function physicalDeviceUnsupportedReason(
  device: Pick<ApplePhysicalDevice, "osVersion">,
  coreDeviceVersion: string | null,
): string | null {
  if (majorVersion(coreDeviceVersion) < MINIMUM_CORE_DEVICE_MAJOR) return "needs Xcode 27";
  if (majorVersion(device.osVersion) < MINIMUM_OS_MAJOR) return "needs iOS 27";
  return null;
}

function majorVersion(version: string | null): number {
  const major = Number.parseInt(version ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}
