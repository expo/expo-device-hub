export const SHARE_URL_ENV = 'EXPO_DEVICE_HUB_SHARE_URL';

/** Set only by the standalone CLI, from `--share-url`, before it imports the server bundle. */
export const SERVER_SHARE_URL =
  process.env.EXPO_DEVICE_HUB_BASE_PATH === '' ? process.env[SHARE_URL_ENV] || undefined : undefined;
