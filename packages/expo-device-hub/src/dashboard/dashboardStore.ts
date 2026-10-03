import { type DeviceStreamMode, type DuoPreviewMode } from '@expo/hub-client';
import { type Device, type StreamModeAvailability } from '@expo/hub-components';
import { create } from 'zustand';

import { dashboardHideSidebar } from '../sidebar';
import { dashboardTransport } from '../transport';
import { browserStreamModeAvailability, resolveStreamMode } from './streamMode';

export const DEFAULT_SIDEBAR_WIDTH = 400;
export const HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY = 'expo-device-hub.hideUnsupportedDevices';
export const DUO_PREVIEW_MODE_STORAGE_KEY = 'expo-device-hub.duoPreviewMode';
export const DUO_CACHE_SCREEN_ON_FOLD_STORAGE_KEY = 'expo-device-hub.duoCacheScreenOnFold';
export const DUO_PREVIEW_SIZE_STORAGE_KEY = 'expo-device-hub.duoPreviewSize';

export type DuoPreviewSize = 'physical' | 'fill';

/** How the viewer draws an iPhone Duo; remembered per browser like serve-sim's settings. */
export type DuoPreviewPreferences = {
  mode: DuoPreviewMode;
  cacheScreenOnFold: boolean;
  sizeMode: DuoPreviewSize;
};

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
  showDeviceFrame: boolean;
  duoPreview: DuoPreviewPreferences;
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
  setShowDeviceFrame: (show: boolean) => void;
  setDuoPreview: (patch: Partial<DuoPreviewPreferences>) => void;
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

/** serve-sim's defaults: the Duo opens in 3D, panels stay live while folding, and the model fills its stage. */
export const DEFAULT_DUO_PREVIEW: DuoPreviewPreferences = {
  mode: '3d',
  cacheScreenOnFold: false,
  sizeMode: 'fill',
};

/** Missing or malformed values fall back to the defaults; only `2d` opts out of the model. */
export function readDuoPreview(storage: ReadableStorage): DuoPreviewPreferences {
  try {
    return {
      mode: storage.getItem(DUO_PREVIEW_MODE_STORAGE_KEY) === '2d' ? '2d' : '3d',
      cacheScreenOnFold: storage.getItem(DUO_CACHE_SCREEN_ON_FOLD_STORAGE_KEY) === 'true',
      sizeMode: storage.getItem(DUO_PREVIEW_SIZE_STORAGE_KEY) === 'physical' ? 'physical' : 'fill',
    };
  } catch {
    return DEFAULT_DUO_PREVIEW;
  }
}

export function persistDuoPreview(storage: WritableStorage, preferences: DuoPreviewPreferences): void {
  try {
    storage.setItem(DUO_PREVIEW_MODE_STORAGE_KEY, preferences.mode);
    storage.setItem(DUO_CACHE_SCREEN_ON_FOLD_STORAGE_KEY, String(preferences.cacheScreenOnFold));
    storage.setItem(DUO_PREVIEW_SIZE_STORAGE_KEY, preferences.sizeMode);
  } catch {
    // Storage can be unavailable in restricted browser contexts; keep the in-memory choice.
  }
}

function initialDuoPreview(): DuoPreviewPreferences {
  if (typeof window === 'undefined') return DEFAULT_DUO_PREVIEW;
  try {
    return readDuoPreview(window.localStorage);
  } catch {
    return DEFAULT_DUO_PREVIEW;
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
    sidebarPreferences: {
      left: dashboardHideSidebar() ? 'hidden' : 'auto',
      right: 'auto',
    },
    lastOpenedSidebar: 'right',
    hideUnsupportedDevices: initialHideUnsupportedDevices(),
    showDeviceFrame: true,
    duoPreview: initialDuoPreview(),
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
    setShowDeviceFrame: (showDeviceFrame) => set({ showDeviceFrame }),
    setDuoPreview: (patch) =>
      set((state) => {
        const duoPreview = { ...state.duoPreview, ...patch };
        if (typeof window !== 'undefined') {
          try {
            persistDuoPreview(window.localStorage, duoPreview);
          } catch {
            // Keep the in-memory choice without storage.
          }
        }
        return { duoPreview };
      }),
  }));
}

export const useDashboardStore = createDashboardStore();
