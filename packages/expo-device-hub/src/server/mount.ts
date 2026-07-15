import { trimTrailingSlash } from '../utils/trimTrailingSlash';

const DEFAULT_PATH = '/_expo/plugins/expo-device-hub';
export const MOUNT_PATH = trimTrailingSlash(process.env.EXPO_DEVICE_HUB_BASE_PATH ?? DEFAULT_PATH);
