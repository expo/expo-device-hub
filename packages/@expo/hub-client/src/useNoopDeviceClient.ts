import { DeviceClient } from './types';

/** Inert client returned while no device is selected — module-level so its
 *  identity is stable across renders. */
export const NOOP_DEVICE_CLIENT: DeviceClient = {
  platform: 'ios',
  status: 'idle',
  error: null,
  screen: null,
  fps: 0,
  webRtcCodec: null,
  setWebRtcCodec: () => {},
  devices: [],
  logs: [],
  logsEnabled: false,
  attachLogs: () => {},
  detachLogs: () => {},
  clearLogs: () => {},
  foregroundApp: null,
  videoKind: 'img',
  attachVideo: () => {},
  sendTouch: () => {},
  sendKey: () => false,
  pressButton: () => {},
  reload: () => {},
  rotate: () => {},
  screenshot: async () => null,
  appearance: null,
  setAppearance: () => {},
  hardwareKeyboardConnected: null,
  setHardwareKeyboardConnected: () => {},
  toggleSoftwareKeyboard: () => {},
};
