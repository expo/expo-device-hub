import { trimTrailingSlash } from "../utils/trimTrailingSlash";

declare global {
  interface Window {
    __DEV__?: boolean;
    __EXPO_DEVICE_HUB_BASE_PATH__?: string;
  }
}

export function basePath(): string {
  // Use local development module from /modules/expo-device-hub
  if (window.__DEV__) return '/_expo/plugins/expo-device-hub';

  const provided = window.__EXPO_DEVICE_HUB_BASE_PATH__;
  // Empty string -> the origin root
  if (provided == null) throw new Error('window.__EXPO_DEVICE_HUB_BASE_PATH__ is not defined');
  return trimTrailingSlash(provided);
}
