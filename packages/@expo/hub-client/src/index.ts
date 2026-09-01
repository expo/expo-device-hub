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
export {
  AGENT_INTERACTION_IDLE_TIMEOUT_MS,
  agentInteractionCursorExpiresAt,
  agentInteractionEndMs,
  agentInteractionPointsAt,
} from './agent-interaction-animation';
export {
  DEVICE_POINTER_LABEL_OFFSET_X,
  DEVICE_POINTER_LABEL_OFFSET_Y,
  DEVICE_POINTER_LABEL_STYLE,
  DEVICE_POINTER_SIZE,
  DEVICE_POINTER_STYLE,
  devicePointerLabelRadius,
  type DevicePointerLabelPlacement,
} from './device-pointer-presentation';
export { displayScreen, streamGeometry } from './orientation';
export { useIosDeviceClient } from './useIosDevice';
export { useAndroidDeviceClient } from './useAndroidDevice';
export { useActiveAgentInteraction } from './useActiveAgentInteraction';
export { useActiveDeviceClient, type ActiveDeviceTarget } from './useActiveDeviceClient';
