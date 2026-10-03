/**
 * Shared device connections, screens and controls.
 *
 * - {@link DeviceScreen} — the component rendered inside `PhoneFrame` (replaces
 *   the static `<img>`), shared by both platforms.
 * - {@link DeviceClientProvider} owns the selected device connection.
 * - {@link useDeviceClient} and {@link useDeviceClientSelector} read state and controls.
 * - {@link useDeviceScreenClient} reads the inputs needed by {@link DeviceScreen}.
 * - {@link KeyboardCapture} + {@link useCoarsePointer} — phone-keyboard typing
 *   for touch clients, feeding `DeviceClient.sendKeyEvents`.
 *
 * See `./types.ts` for the full contract.
 */

export * from './types';
export { areRecordingControlsLocked } from './screen-recording';
export { DeviceScreen } from './DeviceScreen';
export {
  DeviceClientProvider,
  useDeviceClientSelector,
  type DeviceClientProviderProps,
} from './DeviceClientProvider';
export { useDeviceClient } from './useDeviceClient';
export { useDeviceScreenClient } from './useDeviceScreenClient';
export { KeyboardCapture, type KeyboardCaptureProps } from './KeyboardCapture';
export {
  AGENT_INTERACTION_IDLE_TIMEOUT_MS,
  agentInteractionCursorExpiresAt,
  agentInteractionEndMs,
  agentInteractionPointsAt,
} from './agent-interaction-animation';
export { displayScreen, streamGeometry } from './orientation';
export { useIosDeviceClient } from './useIosDevice';
export { useAndroidDeviceClient } from './useAndroidDevice';
export {
  useActiveDeviceClient,
  type ActiveDeviceClientOptions,
  type ActiveDeviceTarget,
} from './useActiveDeviceClient';
export { useCoarsePointer } from './useCoarsePointer';
export { isVisualViewportKeyboardRaised, readNativeKeyboardRaised } from './viewport-keyboard';
export {
  KEYBOARD_CAPTURE_ATTRIBUTES,
  keydownForward,
  keyEventsForBeforeInput,
  keyEventsForInputType,
  keyEventsForTextChange,
} from './mobile-keyboard';
export { createPacedKeySender, type PacedKeySender } from './paced-key-sender';
export { textToKeyEventsLenient } from './text-to-keys';
