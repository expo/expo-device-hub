export const SESSION_TOKEN_ENV = 'EXPO_DEVICE_HUB_SESSION_TOKEN';
export const FRAME_ANCESTORS_ENV = 'EXPO_DEVICE_HUB_FRAME_ANCESTORS';

/**
 * The session token, set only by the standalone CLI, under `--require-token`, before it imports
 * the server bundle. The Hub and both backends take it as a bearer, a query, a cookie, or a
 * subprotocol. Letters, digits, and `-._~` travel unchanged in all of them, as serve-emu and
 * serve-sim require, so a token with any other character is refused.
 */
export function readSessionToken(env: Record<string, string | undefined>): string | undefined {
  if (env.EXPO_DEVICE_HUB_BASE_PATH !== '') return undefined;
  const token = env[SESSION_TOKEN_ENV] || undefined;
  if (token !== undefined && !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new Error(`${SESSION_TOKEN_ENV} must use only letters, digits, '-', '.', '_', or '~'.`);
  }
  return token;
}

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
