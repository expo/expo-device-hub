import { type DeviceSettingKey } from './types';

export type AndroidDeviceSettingKey = Extract<
  DeviceSettingKey,
  | 'appearance'
  | 'network'
  | 'text-size'
  | 'display-size'
  | 'reduce-motion'
  | 'bold-text'
  | 'increase-contrast'
>;

export type AndroidSizeStep = 'small' | 'medium' | 'large' | 'extra-large';

const ANDROID_SIZE_SCALES: ReadonlyArray<{
  value: AndroidSizeStep;
  scale: number;
}> = [
  { value: 'small', scale: 0.85 },
  { value: 'medium', scale: 1 },
  { value: 'large', scale: 1.15 },
  { value: 'extra-large', scale: 1.3 },
];

export function androidScaleForSizeStep(value: string): number | null {
  return ANDROID_SIZE_SCALES.find((preset) => preset.value === value)?.scale ?? null;
}

/** Map externally-set Android scales onto the nearest S–XL Hub option. */
export function androidSizeStepForScale(value: unknown): AndroidSizeStep | null {
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return ANDROID_SIZE_SCALES.reduce((nearest, preset) =>
    Math.abs(preset.scale - scale) < Math.abs(nearest.scale - scale) ? preset : nearest,
  ).value;
}

/** The text-size spelling of the shared step helpers. */
export type AndroidTextSize = AndroidSizeStep;
export const androidFontScaleForTextSize = androidScaleForSizeStep;
export const androidTextSizeForFontScale = androidSizeStepForScale;

export type AndroidDeviceSettingPath =
  | '/api/uimode'
  | '/api/network'
  | '/api/font-scale'
  | '/api/display-density'
  | '/api/reduce-motion'
  | '/api/font-weight'
  | '/api/high-text-contrast';

export interface AndroidDeviceSettingRequest {
  path: AndroidDeviceSettingPath;
  body: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function enabledBodyForOnOff(value: string): Record<string, unknown> | null {
  return value === 'on' || value === 'off' ? { enabled: value === 'on' } : null;
}

function onOffForEnabledBody(value: unknown): string | null {
  const enabled = asRecord(value)?.enabled;
  if (enabled === true) return 'on';
  if (enabled === false) return 'off';
  return null;
}

interface AndroidDeviceSettingSpec {
  path: AndroidDeviceSettingPath;
  /** Whether the 3s poll refreshes this key. */
  polled: boolean;
  /** Hub value to request body, or null when the value is not writable. */
  encode: (value: string) => Record<string, unknown> | null;
  /** Server payload to Hub value, or null when it cannot be read. */
  decode: (data: Record<string, unknown>) => string | null;
}

const ANDROID_DEVICE_SETTINGS: Record<AndroidDeviceSettingKey, AndroidDeviceSettingSpec> = {
  appearance: {
    path: '/api/uimode',
    polled: false,
    encode: (value) =>
      value === 'light' || value === 'dark' ? { night: value === 'dark' ? 'yes' : 'no' } : null,
    decode: (data) => {
      if (data.night === 'yes') return 'dark';
      if (data.night === 'no' || data.night === 'auto') return 'light';
      return null;
    },
  },
  network: {
    path: '/api/network',
    polled: true,
    encode: enabledBodyForOnOff,
    decode: (data) => {
      const network = asRecord(data.network);
      if (!network) return null;
      if (network.enabled === true) return 'on';
      if (network.enabled === false) return 'off';
      return network.enabled === null ? 'unknown' : null;
    },
  },
  'text-size': {
    path: '/api/font-scale',
    polled: true,
    encode: (value) => {
      const scale = androidScaleForSizeStep(value);
      return scale === null ? null : { scale };
    },
    decode: (data) => {
      const fontScale = asRecord(data.fontScale);
      return fontScale === null ? null : androidSizeStepForScale(fontScale.scale);
    },
  },
  'display-size': {
    path: '/api/display-density',
    polled: true,
    encode: (value) => {
      const scale = androidScaleForSizeStep(value);
      return scale === null ? null : { scale };
    },
    decode: (data) => {
      const displayDensity = asRecord(data.displayDensity);
      return displayDensity === null ? null : androidSizeStepForScale(displayDensity.scale);
    },
  },
  'reduce-motion': {
    path: '/api/reduce-motion',
    polled: true,
    encode: enabledBodyForOnOff,
    decode: (data) => onOffForEnabledBody(data.reduceMotion),
  },
  'bold-text': {
    path: '/api/font-weight',
    polled: true,
    encode: enabledBodyForOnOff,
    decode: (data) => onOffForEnabledBody(data.fontWeight),
  },
  'increase-contrast': {
    path: '/api/high-text-contrast',
    polled: true,
    encode: enabledBodyForOnOff,
    decode: (data) => onOffForEnabledBody(data.highTextContrast),
  },
};

export const ANDROID_DEVICE_SETTING_KEYS: readonly AndroidDeviceSettingKey[] = Object.keys(
  ANDROID_DEVICE_SETTINGS,
) as AndroidDeviceSettingKey[];

export const ANDROID_POLLED_DEVICE_SETTING_KEYS: readonly AndroidDeviceSettingKey[] =
  ANDROID_DEVICE_SETTING_KEYS.filter((key) => ANDROID_DEVICE_SETTINGS[key].polled);

export function createAndroidDeviceSettingVersions(): Record<AndroidDeviceSettingKey, number> {
  return Object.fromEntries(ANDROID_DEVICE_SETTING_KEYS.map((key) => [key, 0])) as Record<
    AndroidDeviceSettingKey,
    number
  >;
}

export function androidDeviceSettingPathFor(
  key: AndroidDeviceSettingKey,
): AndroidDeviceSettingPath {
  return ANDROID_DEVICE_SETTINGS[key].path;
}

function isAndroidDeviceSettingKey(key: DeviceSettingKey): key is AndroidDeviceSettingKey {
  return Object.hasOwn(ANDROID_DEVICE_SETTINGS, key);
}

export function androidDeviceSettingRequest(
  key: DeviceSettingKey,
  value: string,
): AndroidDeviceSettingRequest | null {
  if (!isAndroidDeviceSettingKey(key)) return null;
  const spec = ANDROID_DEVICE_SETTINGS[key];
  const body = spec.encode(value);
  return body === null ? null : { path: spec.path, body };
}

export function parseAndroidDeviceSetting(
  key: AndroidDeviceSettingKey,
  payload: unknown,
): string | null {
  const data = asRecord(payload);
  if (!data || data.ok !== true) return null;
  return ANDROID_DEVICE_SETTINGS[key].decode(data);
}

/** The smallest-width dp a display-density payload reports, in `swNNNdp` terms. */
export function androidDisplayWidthDpFromPayload(payload: unknown): number | null {
  const data = asRecord(payload);
  if (!data || data.ok !== true) return null;
  const widthDp = asRecord(data.displayDensity)?.widthDp;
  return typeof widthDp === 'number' && Number.isFinite(widthDp) && widthDp > 0 ? widthDp : null;
}
