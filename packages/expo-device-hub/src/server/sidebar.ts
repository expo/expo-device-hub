/** Set only by the standalone CLI before it imports the server bundle. */
export const SERVER_HIDE_SIDEBAR =
  process.env.EXPO_DEVICE_HUB_BASE_PATH === '' &&
  process.env.EXPO_DEVICE_HUB_HIDE_SIDEBAR === 'true';
