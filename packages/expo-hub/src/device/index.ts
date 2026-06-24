/**
 * The common device-client interface + its two implementations.
 *
 * - {@link DeviceScreen} — the component rendered inside `PhoneFrame` (replaces
 *   the static `<img>`), shared by both platforms.
 * - {@link useIosDeviceClient} / {@link useAndroidDeviceClient} — the serve-sim
 *   and serve-emu implementations of the connection hook.
 * - {@link useActiveDeviceClient} — picks + connects the selected one.
 *
 * See `./types.ts` for the full contract.
 */

export * from './types';
export { DeviceScreen } from './DeviceScreen';
export { useIosDeviceClient } from './useIosDevice';
export { useAndroidDeviceClient } from './useAndroidDevice';
export { useActiveDeviceClient, type ActiveDeviceTarget } from './useActiveDeviceClient';
export { DEFAULT_ENDPOINTS, endpointFor } from './connections';
