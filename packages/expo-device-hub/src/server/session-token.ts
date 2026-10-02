export const SESSION_TOKEN_ENV = 'EXPO_DEVICE_HUB_SESSION_TOKEN';

/** Set only by the standalone CLI, under `--require-token`, before it imports the server bundle. */
export const SESSION_TOKEN =
  process.env.EXPO_DEVICE_HUB_BASE_PATH === ''
    ? process.env[SESSION_TOKEN_ENV] || undefined
    : undefined;
