export const SESSION_TOKEN_ENV = 'EXPO_DEVICE_HUB_SESSION_TOKEN';

/**
 * The session token, set only by the standalone CLI, under `--require-token`, before it imports
 * the server bundle. The Hub and both backends take it as a bearer, a query, a cookie, or a
 * subprotocol. Letters, digits, and `-._~` travel unchanged in all of them, as serve-emu and
 * serve-sim require, so a token with any other character is refused.
 *
 * This module reads nothing at import, so a test can load it without fixing `SESSION_TOKEN` in
 * `session-token.ts` for the other test files in the same process.
 */
export function readSessionToken(env: Record<string, string | undefined>): string | undefined {
  if (env.EXPO_DEVICE_HUB_BASE_PATH !== '') return undefined;
  const token = env[SESSION_TOKEN_ENV] || undefined;
  if (token !== undefined && !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new Error(`${SESSION_TOKEN_ENV} must use only letters, digits, '-', '.', '_', or '~'.`);
  }
  return token;
}
