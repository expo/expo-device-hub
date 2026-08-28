declare global {
  interface Window {
    __EXPO_DEVICE_HUB_HIDE_BOOT_DEVICE__?: boolean;
  }
}

/** Whether the standalone CLI disabled controls for booting or creating devices. */
export function dashboardHideBootDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.__EXPO_DEVICE_HUB_HIDE_BOOT_DEVICE__ === true;
}
