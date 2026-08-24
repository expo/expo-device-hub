import { type DeviceStreamMode } from '@expo/hub-client';
import { type Device, type StreamModeAvailability } from '@expo/hub-components';
import { create } from 'zustand';

import { dashboardTransport } from '../transport';
import { browserStreamModeAvailability, resolveStreamMode } from './streamMode';

export const DEFAULT_SIDEBAR_WIDTH = 400;
export const HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY = 'expo-device-hub.hideUnsupportedDevices';

export type SidebarPreference = 'auto' | 'open' | 'hidden';
export type SidebarSide = 'left' | 'right';

type DashboardStoreValues = {
  selectedDeviceId: string;
  addedDevices: Device[];
  streamMode: DeviceStreamMode;
  sidebarWidths: Record<SidebarSide, number>;
  sidebarPreferences: Record<SidebarSide, SidebarPreference>;
  lastOpenedSidebar: SidebarSide;
  hideUnsupportedDevices: boolean;
};

export type DashboardStore = DashboardStoreValues & {
  selectDevice: (id: string) => void;
  reconcileSelectedDevice: (availableIds: readonly string[]) => void;
  trackAddedDevice: (device: Device, replacedIds: readonly string[]) => void;
  dismissDevice: (id: string) => void;
  chooseStreamMode: (mode: DeviceStreamMode, availability: StreamModeAvailability) => void;
  resizeSidebar: (side: SidebarSide, width: number) => void;
  openSidebar: (side: SidebarSide, canDock: boolean) => void;
  closeSidebar: (side: SidebarSide) => void;
  setHideUnsupportedDevices: (hide: boolean) => void;
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
    selectedDeviceId: '',
    addedDevices: [],
    streamMode: resolveStreamMode(dashboardTransport(), availability),
    sidebarWidths: { left: DEFAULT_SIDEBAR_WIDTH, right: DEFAULT_SIDEBAR_WIDTH },
    sidebarPreferences: { left: 'auto', right: 'auto' },
    lastOpenedSidebar: 'right',
    hideUnsupportedDevices: initialHideUnsupportedDevices(),
  };
}

export function createDashboardStore(initialState: Partial<DashboardStoreValues> = {}) {
  return create<DashboardStore>()((set) => ({
    ...defaultDashboardStoreValues(),
    ...initialState,
    selectDevice: (selectedDeviceId) => set({ selectedDeviceId }),
    reconcileSelectedDevice: (availableIds) =>
      set((state) =>
        availableIds.includes(state.selectedDeviceId)
          ? state
          : { selectedDeviceId: availableIds[0] ?? '' },
      ),
    trackAddedDevice: (device, replacedIds) =>
      set((state) => {
        const replaced = new Set([...replacedIds, device.id]);
        return {
          addedDevices: [...state.addedDevices.filter((item) => !replaced.has(item.id)), device],
          selectedDeviceId: device.id,
        };
      }),
    dismissDevice: (id) =>
      set((state) => ({
        addedDevices: state.addedDevices.filter((item) => item.id !== id),
        selectedDeviceId: state.selectedDeviceId === id ? '' : state.selectedDeviceId,
      })),
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
  }));
}

export const useDashboardStore = createDashboardStore();
