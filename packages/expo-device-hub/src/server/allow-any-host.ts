export const ALLOW_ANY_HOST_ENV = 'EXPO_DEVICE_HUB_ALLOW_ANY_HOST';

/**
 * Set by `--allow-any-host-when-insecure`. Under Expo CLI the Hub takes no flags, so set
 * `EXPO_DEVICE_HUB_ALLOW_ANY_HOST=1` there to open it on another name, such as a tunnel. Read at
 * import, after the standalone CLI has set it, as `session-token.ts` reads the token.
 */
export const ALLOW_ANY_HOST = process.env[ALLOW_ANY_HOST_ENV] === '1';
