import { type DeviceSettingKey } from './types';

export type AndroidDeviceSettingKey = Extract<
  DeviceSettingKey,
  'appearance' | 'network' | 'text-size' | 'reduce-motion' | 'increase-contrast'
>;

export type AndroidTextSize = 'small' | 'medium' | 'large' | 'extra-large';

const ANDROID_FONT_SCALES: ReadonlyArray<{
  value: AndroidTextSize;
  scale: number;
}> = [
  { value: 'small', scale: 0.85 },
  { value: 'medium', scale: 1 },
  { value: 'large', scale: 1.15 },
  { value: 'extra-large', scale: 1.3 },
];

export function androidFontScaleForTextSize(value: string): number | null {
  return ANDROID_FONT_SCALES.find((preset) => preset.value === value)?.scale ?? null;
}

/** Map externally-set Android scales onto the nearest S–XL Hub option. */
export function androidTextSizeForFontScale(value: unknown): AndroidTextSize | null {
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return ANDROID_FONT_SCALES.reduce((nearest, preset) =>
    Math.abs(preset.scale - scale) < Math.abs(nearest.scale - scale) ? preset : nearest,
  ).value;
}

export type AndroidDeviceSettingPath =
  | '/api/uimode'
  | '/api/network'
  | '/api/font-scale'
  | '/api/reduce-motion'
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
      const scale = androidFontScaleForTextSize(value);
      return scale === null ? null : { scale };
    },
    decode: (data) => {
      const fontScale = asRecord(data.fontScale);
      return fontScale === null ? null : androidTextSizeForFontScale(fontScale.scale);
    },
  },
  'reduce-motion': {
    path: '/api/reduce-motion',
    polled: true,
    encode: enabledBodyForOnOff,
    decode: (data) => onOffForEnabledBody(data.reduceMotion),
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
