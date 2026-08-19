export type PlatformFilter = 'ios' | 'android';

export function parsePlatformFilter(value: unknown): PlatformFilter | undefined {
  return value === 'ios' || value === 'android' ? value : undefined;
}

declare global {
  interface Window {
    __EXPO_DEVICE_HUB_PLATFORM__?: PlatformFilter;
  }
}

/** Platform selected by the standalone CLI, or undefined when both should be shown. */
export function dashboardPlatformFilter(): PlatformFilter | undefined {
  if (typeof window === 'undefined') return undefined;
  return parsePlatformFilter(window.__EXPO_DEVICE_HUB_PLATFORM__);
}
