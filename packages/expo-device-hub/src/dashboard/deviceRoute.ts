import { useSyncExternalStore } from 'react';

import { trimTrailingSlash } from '../utils/trimTrailingSlash';
import { basePath } from './basePath';

const DEVICE_ROUTE_CHANGE_EVENT = 'expo-device-hub:device-route-change';

/** The web app is at the origin root in Metro, even though its API uses the plugin mount. */
function browserMountPath(): string {
  const provided = window.__EXPO_DEVICE_HUB_BASE_PATH__;
  if (provided != null) return trimTrailingSlash(provided);
  return window.__DEV__ ? '' : basePath();
}

/** Read one encoded iOS UDID or Android serial under the dashboard's mount. */
export function readDeviceRoute(pathname: string, mountPath = ''): string {
  const prefix = `${trimTrailingSlash(mountPath)}/device/`;
  if (!pathname.startsWith(prefix)) return '';
  const encodedId = pathname.slice(prefix.length).replace(/\/$/, '');
  if (!encodedId || encodedId.includes('/')) return '';
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return '';
  }
}

export function selectedDeviceRoute(): string {
  if (typeof window === 'undefined') return '';
  return readDeviceRoute(window.location.pathname, browserMountPath());
}

export function subscribeToDeviceRoute(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(DEVICE_ROUTE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(DEVICE_ROUTE_CHANGE_EVENT, onChange);
  };
}

export function selectDeviceRoute(id: string, options?: { replace?: boolean }): void {
  const mountPath = browserMountPath();
  const pathname = id ? `${mountPath}/device/${encodeURIComponent(id)}` : `${mountPath}/`;
  if (window.location.pathname === pathname) return;

  const url = `${pathname}${window.location.search}${window.location.hash}`;
  if (options?.replace) {
    window.history.replaceState(window.history.state, '', url);
  } else {
    window.history.pushState(window.history.state, '', url);
  }
  window.dispatchEvent(new Event(DEVICE_ROUTE_CHANGE_EVENT));
}

const serverSelectedDeviceRoute = () => '';

export function useDeviceRoute(): {
  selectedId: string;
  selectDevice: typeof selectDeviceRoute;
} {
  const selectedId = useSyncExternalStore(
    subscribeToDeviceRoute,
    selectedDeviceRoute,
    serverSelectedDeviceRoute
  );
  return { selectedId, selectDevice: selectDeviceRoute };
}
