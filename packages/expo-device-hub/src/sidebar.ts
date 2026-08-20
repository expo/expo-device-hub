declare global {
  interface Window {
    __EXPO_DEVICE_HUB_HIDE_SIDEBAR__?: boolean;
  }
}

/** Whether the standalone CLI asked the dashboard to start with its device list hidden. */
export function dashboardHideSidebar(): boolean {
  if (typeof window === 'undefined') return false;
  return window.__EXPO_DEVICE_HUB_HIDE_SIDEBAR__ === true;
}
