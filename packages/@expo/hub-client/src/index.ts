/**
 * The common device-client interface + its two implementations.
 *
 * - {@link DeviceScreen} — the component rendered inside `PhoneFrame` (replaces
 *   the static `<img>`), shared by both platforms.
 * - {@link useIosDeviceClient} / {@link useAndroidDeviceClient} — the serve-sim
 *   and serve-emu implementations of the connection hook.
 * - {@link useActiveDeviceClient} — picks + connects the selected one.
 * - {@link KeyboardCapture} + {@link useCoarsePointer} — phone-keyboard typing
 *   for touch clients, feeding `DeviceClient.sendKeyEvents`.
 *
 * See `./types.ts` for the full contract.
 */

export * from './types.js';
export { areRecordingControlsLocked } from './screen-recording.js';
export { DeviceScreen } from './DeviceScreen.js';
export { KeyboardCapture, type KeyboardCaptureProps } from './KeyboardCapture.js';
export {
  AGENT_INTERACTION_IDLE_TIMEOUT_MS,
  agentInteractionCursorExpiresAt,
  agentInteractionEndMs,
  agentInteractionPointsAt,
} from './agent-interaction-animation.js';
export { displayScreen, streamGeometry } from './orientation.js';
export { useIosDeviceClient } from './useIosDevice.js';
export { useAndroidDeviceClient } from './useAndroidDevice.js';
export { useActiveDeviceClient, type ActiveDeviceTarget } from './useActiveDeviceClient.js';
export { useCoarsePointer } from './useCoarsePointer.js';
export { isVisualViewportKeyboardRaised, readNativeKeyboardRaised } from './viewport-keyboard.js';
export {
  KEYBOARD_CAPTURE_ATTRIBUTES,
  keydownForward,
  keyEventsForBeforeInput,
  keyEventsForInputType,
  keyEventsForTextChange,
} from './mobile-keyboard.js';
export { createPacedKeySender, type PacedKeySender } from './paced-key-sender.js';
export { textToKeyEventsLenient } from './text-to-keys.js';
