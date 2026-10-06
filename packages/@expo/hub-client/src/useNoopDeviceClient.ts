import type { DeviceClient, Feature, HubResult, Writes } from './types';

const noop = () => {};
const unavailable = async (): Promise<HubResult<never>> => ({
  ok: false,
  error: { code: 'unsupported', message: 'No device selected', retryable: false },
});
const feature = <D>(): Feature<D> => ({
  status: 'unsupported',
  data: undefined,
  error: null,
  refresh: noop,
});
const writes = <K extends string>(): Writes<K> => ({ pending: new Set(), errors: new Map() });
const attachable = { enabled: false, attach: noop, detach: noop };

/** Inert, stable client returned while no device is selected. */
export const NOOP_DEVICE_CLIENT: DeviceClient = {
  platform: 'ios',
  stream: {
    ...feature(),
    videoKind: 'img',
    attachVideo: noop,
    transports: {
      modeAvailability: { mjpeg: false, h264: false, webrtc: false },
      httpCodecs: [],
      webRtcCodecs: [],
    },
    webRtcCodec: 'h264',
    setWebRtcCodec: noop,
  },
  streamSettings: { ...feature(), editable: new Set(), writes: writes(), update: unavailable },
  streamSource: { ...feature(), writes: writes(), update: unavailable },
  streamStats: { ...feature(), ...attachable },
  screenRecording: feature(),
  devices: feature(),
  foregroundApp: feature(),
  logs: { ...feature(), ...attachable, clear: noop },
  events: { ...feature(), ...attachable, clear: noop },
  activity: { ...feature(), ...attachable },
  deviceSettings: { ...feature(), writes: writes(), set: unavailable },
  keyboard: {
    ...feature(),
    writes: writes(),
    setHardwareConnected: unavailable,
    toggleSoftware: noop,
  },
  camera: { ...feature(), writes: writes(), setImage: unavailable, clearImage: unavailable },
  accessibility: feature(),
  location: {
    ...feature(),
    canClear: false,
    writes: writes(),
    set: unavailable,
    clear: unavailable,
  },
  permissions: { ...feature(), writes: writes(), set: unavailable, reset: unavailable },
  input: feature(),
  sendTouch: noop,
  sendMultiTouch: noop,
  sendKey: () => false,
  pressButton: noop,
  reload: noop,
  rotate: noop,
  screenshot: unavailable,
};
