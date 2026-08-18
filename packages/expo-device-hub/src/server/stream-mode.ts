import { parseStreamMode } from '../stream-mode';

/** Set only by the standalone CLI before it imports the server bundle. */
export const SERVER_STREAM_MODE =
  process.env.EXPO_DEVICE_HUB_BASE_PATH === ''
    ? parseStreamMode(process.env.EXPO_DEVICE_HUB_STREAM_MODE)
    : undefined;
