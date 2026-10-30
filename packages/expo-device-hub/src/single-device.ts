declare global {
  interface Window {
    __EXPO_DEVICE_HUB_SINGLE_DEVICE__?: string;
  }
}

export function dashboardSingleDevice(): string | undefined {
  return typeof window === "undefined" ? undefined : window.__EXPO_DEVICE_HUB_SINGLE_DEVICE__;
}
