import { readSessionToken, SESSION_TOKEN_ENV } from './read-session-token';

export { SESSION_TOKEN_ENV };
export const FRAME_ANCESTORS_ENV = 'EXPO_DEVICE_HUB_FRAME_ANCESTORS';

/** The session token for this process, or `undefined` when the Hub is open. */
export const SESSION_TOKEN = readSessionToken(process.env);

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
