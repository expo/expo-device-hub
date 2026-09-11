import { type DeviceStreamMode } from '@expo/hub-client';
import { type StreamModeAvailability } from '@expo/hub-components';
import { create } from 'zustand';

import { dashboardHideSidebar } from '../sidebar';
import { dashboardTransport } from '../transport';
import { browserStreamModeAvailability, resolveStreamMode } from './streamMode';

export const DEFAULT_SIDEBAR_WIDTH = 400;
export const HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY = 'expo-device-hub.hideUnsupportedDevices';

export type SidebarPreference = 'auto' | 'open' | 'hidden';
export type SidebarSide = 'left' | 'right';

type DashboardStoreValues = {
  streamMode: DeviceStreamMode;
  sidebarWidths: Record<SidebarSide, number>;
  sidebarPreferences: Record<SidebarSide, SidebarPreference>;
  lastOpenedSidebar: SidebarSide;
  hideUnsupportedDevices: boolean;
  showDeviceFrame: boolean;
};

export type DashboardStore = DashboardStoreValues & {
  chooseStreamMode: (mode: DeviceStreamMode, availability: StreamModeAvailability) => void;
  resizeSidebar: (side: SidebarSide, width: number) => void;
  openSidebar: (side: SidebarSide, canDock: boolean) => void;
  closeSidebar: (side: SidebarSide) => void;
  setHideUnsupportedDevices: (hide: boolean) => void;
  setShowDeviceFrame: (show: boolean) => void;
};

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Missing or malformed values use the safe default: hide untested devices. */
export function readHideUnsupportedDevices(storage: ReadableStorage): boolean {
  try {
    return storage.getItem(HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Persist the default so the browser flag is visible and easy to override. */
export function persistHideUnsupportedDevicesDefault(storage: WritableStorage): void {
  try {
    if (storage.getItem(HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY) === null) {
      storage.setItem(HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY, 'true');
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts; retain the in-memory default.
  }
}

function initialHideUnsupportedDevices(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return readHideUnsupportedDevices(window.localStorage);
  } catch {
    return true;
  }
}

function defaultDashboardStoreValues(): DashboardStoreValues {
  const availability = browserStreamModeAvailability();
  return {
    streamMode: resolveStreamMode(dashboardTransport(), availability),
    sidebarWidths: { left: DEFAULT_SIDEBAR_WIDTH, right: DEFAULT_SIDEBAR_WIDTH },
    sidebarPreferences: {
      left: dashboardHideSidebar() ? 'hidden' : 'auto',
      right: 'auto',
    },
    lastOpenedSidebar: 'right',
    hideUnsupportedDevices: initialHideUnsupportedDevices(),
    showDeviceFrame: true,
  };
}

export function createDashboardStore(initialState: Partial<DashboardStoreValues> = {}) {
  return create<DashboardStore>()((set) => ({
    ...defaultDashboardStoreValues(),
    ...initialState,
    chooseStreamMode: (mode, availability) =>
      set({ streamMode: resolveStreamMode(mode, availability) }),
    resizeSidebar: (side, width) =>
      set((state) => ({ sidebarWidths: { ...state.sidebarWidths, [side]: width } })),
    openSidebar: (side, canDock) =>
      set((state) => ({
        sidebarPreferences: {
          ...state.sidebarPreferences,
          [side]: canDock ? 'auto' : 'open',
        },
        lastOpenedSidebar: side,
      })),
    closeSidebar: (side) =>
      set((state) => ({
        sidebarPreferences: { ...state.sidebarPreferences, [side]: 'hidden' },
      })),
    setHideUnsupportedDevices: (hideUnsupportedDevices) => set({ hideUnsupportedDevices }),
    setShowDeviceFrame: (showDeviceFrame) => set({ showDeviceFrame }),
  }));
}

export const useDashboardStore = createDashboardStore();
