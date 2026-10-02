export const SESSION_TOKEN_ENV = 'EXPO_DEVICE_HUB_SESSION_TOKEN';
export const FRAME_ANCESTORS_ENV = 'EXPO_DEVICE_HUB_FRAME_ANCESTORS';

/** Set only by the standalone CLI, under `--require-token`, before it imports the server bundle. */
export const SESSION_TOKEN =
  process.env.EXPO_DEVICE_HUB_BASE_PATH === ''
    ? process.env[SESSION_TOKEN_ENV] || undefined
    : undefined;

/** `--frame-ancestor` origins, a JSON array. They apply only under the token, as in serve-sim. */
export const FRAME_ANCESTORS: string[] = SESSION_TOKEN
  ? parseOrigins(process.env[FRAME_ANCESTORS_ENV])
  : [];

function parseOrigins(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((origin): origin is string => typeof origin === 'string')
      : [];
  } catch {
    return [];
  }
}
