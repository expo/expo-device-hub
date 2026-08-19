import { parsePlatformFilter } from '../platform-filter';

/** Set only by the standalone CLI before it imports the server bundle. */
export const SERVER_PLATFORM_FILTER =
  process.env.EXPO_DEVICE_HUB_BASE_PATH === ''
    ? parsePlatformFilter(process.env.EXPO_DEVICE_HUB_PLATFORM)
    : undefined;
