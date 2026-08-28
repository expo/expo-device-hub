import { type DeviceSettingKey } from './types';

export type AndroidDeviceSettingKey = Extract<
  DeviceSettingKey,
  'appearance' | 'network' | 'text-size'
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

export interface AndroidDeviceSettingRequest {
  path: '/api/uimode' | '/api/network' | '/api/font-scale';
  body: Record<string, unknown>;
}

export function androidDeviceSettingPath(
  key: AndroidDeviceSettingKey,
): AndroidDeviceSettingRequest['path'] {
  if (key === 'appearance') return '/api/uimode';
  if (key === 'network') return '/api/network';
  return '/api/font-scale';
}

export function androidDeviceSettingRequest(
  key: DeviceSettingKey,
  value: string,
): AndroidDeviceSettingRequest | null {
  if (key === 'appearance' && (value === 'light' || value === 'dark')) {
    return {
      path: androidDeviceSettingPath(key),
      body: { night: value === 'dark' ? 'yes' : 'no' },
    };
  }
  if (key === 'network' && (value === 'on' || value === 'off')) {
    return { path: androidDeviceSettingPath(key), body: { enabled: value === 'on' } };
  }
  if (key === 'text-size') {
    const scale = androidFontScaleForTextSize(value);
    return scale === null ? null : { path: androidDeviceSettingPath(key), body: { scale } };
  }
  return null;
}

export function parseAndroidDeviceSetting(
  key: AndroidDeviceSettingKey,
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  if (data.ok !== true) return null;

  if (key === 'appearance') {
    if (data.night === 'yes') return 'dark';
    if (data.night === 'no' || data.night === 'auto') return 'light';
    return null;
  }
  if (key === 'network') {
    const network = data.network;
    if (!network || typeof network !== 'object' || Array.isArray(network)) return null;
    const enabled = (network as Record<string, unknown>).enabled;
    if (enabled === true) return 'on';
    if (enabled === false) return 'off';
    return enabled === null ? 'unknown' : null;
  }
  const fontScale = data.fontScale;
  if (!fontScale || typeof fontScale !== 'object' || Array.isArray(fontScale)) return null;
  return androidTextSizeForFontScale((fontScale as Record<string, unknown>).scale);
}
