import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef } from 'react';

import { HINGE_POSES } from './hinge-control';
import { type DeviceClient, type KeyboardInput } from './types';

/**
 * Physical-keyboard forwarding shared by {@link DeviceScreen} and the iPhone Duo
 * model. A focused device surface owns keyboard input; held keys are released
 * on blur or when the tab hides so modifiers never stick in the device.
 * Option+Shift+1–5 select the Duo's five poses, like serve-sim and Xcode's
 * Device Hub, and never reach the device as keystrokes.
 */
export function useDeviceKeyboard(client: Pick<DeviceClient, 'sendKey' | 'hinge'>) {
  const { sendKey, hinge } = client;
  const pressedKeysRef = useRef(new Map<string, KeyboardInput>());
  const releasePressedKeys = useCallback(() => {
    for (const input of pressedKeysRef.current.values()) {
      sendKey({ ...input, phase: 'up', repeat: false });
    }
    pressedKeysRef.current.clear();
  }, [sendKey]);

  useEffect(() => {
    const onWindowBlur = () => releasePressedKeys();
    const onVisibilityChange = () => {
      if (document.hidden) releasePressedKeys();
    };
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      releasePressedKeys();
    };
  }, [releasePressedKeys]);

  const keyboardInputFrom = (
    event: ReactKeyboardEvent<HTMLElement>,
    phase: KeyboardInput['phase'],
  ): KeyboardInput => ({
    phase,
    code: event.code,
    key: event.key,
    repeat: event.repeat,
  });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // Keep the remote surface escapable for keyboard-only users while leaving a
    // plain Escape available to the simulator/emulator.
    if (event.key === 'Escape' && event.shiftKey) {
      event.preventDefault();
      releasePressedKeys();
      event.currentTarget.blur();
      return;
    }
    // Physical codes, so Option+Shift's layout-specific characters cannot
    // affect the pose lookup. Command+digits stay with the browser's tabs.
    if (hinge && event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey) {
      const digit = /^Digit([1-5])$/.exec(event.code);
      if (digit) {
        event.preventDefault();
        const pose = HINGE_POSES[Number(digit[1]) - 1];
        if (pose && !event.repeat) hinge.setControl({ control: 'pose', value: pose.id });
        return;
      }
    }
    if (event.nativeEvent.isComposing) return;
    const input = keyboardInputFrom(event, 'down');
    if (!sendKey(input)) return;
    event.preventDefault();
    pressedKeysRef.current.set(event.code || event.key, input);
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLElement>) => {
    const keyId = event.code || event.key;
    const wasPressed = pressedKeysRef.current.delete(keyId);
    const handled = sendKey(keyboardInputFrom(event, 'up'));
    if (wasPressed || handled) event.preventDefault();
  };

  return { onKeyDown, onKeyUp, releasePressedKeys };
}
