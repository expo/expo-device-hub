import { parseTransport } from '../transport';

/** Set only by the standalone CLI before it imports the server bundle. */
export const SERVER_TRANSPORT =
  process.env.EXPO_DEVICE_HUB_BASE_PATH === ''
    ? parseTransport(process.env.EXPO_DEVICE_HUB_TRANSPORT)
    : undefined;
