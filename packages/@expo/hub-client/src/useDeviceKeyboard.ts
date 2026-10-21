import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useRef,
} from "react";

import { HINGE_POSES } from "./hinge-control";
import { type DeviceClient, type KeyboardInput } from "./types";

const isClipboardShortcut = (event: ReactKeyboardEvent, code: "KeyC" | "KeyV") =>
  event.code === code && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;

/**
 * Physical-keyboard forwarding of {@link DeviceScreen}, for any focusable
 * device surface, such as the iPhone Duo's 3D model in `@expo/hub-components`.
 * Spread the returned handlers on the surface. A focused device surface owns keyboard input. The caller releases held
 * keys and resets shortcuts when input is cancelled, so modifiers never stick in
 * the device. Option+Shift+1–5 select the Duo's five poses, like serve-sim and
 * Xcode's Device Hub, and never reach the device as keystrokes. Command+C and
 * Command+V copy and paste text.
 */
export function useDeviceKeyboard(
  client: Pick<DeviceClient, "sendKey" | "hinge" | "pasteText" | "capabilities">,
  { onCopy }: { onCopy?: () => Promise<void> } = {},
) {
  const { sendKey, hinge, pasteText, capabilities } = client;
  const canPaste = capabilities.clipboard !== false && capabilities.clipboard.paste;
  const pressedKeysRef = useRef(new Map<string, KeyboardInput>());
  // Keys whose keydown was consumed as a pose shortcut; their keyup must not
  // reach the device either, or it would see a release without a press.
  const swallowedKeysRef = useRef(new Set<string>());
  const releasePressedKeys = useCallback(() => {
    for (const input of pressedKeysRef.current.values()) {
      sendKey({ ...input, phase: "up", repeat: false });
    }
    pressedKeysRef.current.clear();
    swallowedKeysRef.current.clear();
  }, [sendKey]);

  // @ref LLP 0013#clipboard — Cmd+V sends the browser's paste text; without text the device pastes its own clipboard
  // Keep a handled shortcut held until V keyup so auto-repeat cannot paste twice.
  const pasteShortcutRef = useRef<"pending" | "handled" | null>(null);
  const copyShortcutRef = useRef(false);
  const resetShortcuts = useCallback(() => {
    pasteShortcutRef.current = null;
    copyShortcutRef.current = false;
  }, []);
  const paste = (text?: string) => {
    void pasteText(text).catch(() => {});
  };

  const keyboardInputFrom = (
    event: ReactKeyboardEvent<HTMLElement>,
    phase: KeyboardInput["phase"],
  ): KeyboardInput => ({
    phase,
    code: event.code,
    key: event.key,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
  });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // Keep the remote surface escapable for keyboard-only users while leaving a
    // plain Escape available to the simulator/emulator.
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      releasePressedKeys();
      event.currentTarget.blur();
      return;
    }
    // Physical codes, so Option+Shift's layout-specific characters cannot
    // affect the pose lookup. Command+digits stay with the browser's tabs.
    if (hinge?.supported && event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey) {
      const digit = /^Digit([1-5])$/.exec(event.code);
      if (digit) {
        event.preventDefault();
        swallowedKeysRef.current.add(event.code);
        const pose = HINGE_POSES[Number(digit[1]) - 1];
        if (pose && !event.repeat) hinge.setControl({ control: "pose", value: pose.id });
        return;
      }
    }
    if (event.nativeEvent.isComposing) return;
    if (event.code === "KeyC") {
      if (copyShortcutRef.current && event.repeat) {
        event.preventDefault();
        return;
      }
      copyShortcutRef.current = false;
      if (
        onCopy &&
        capabilities.clipboard &&
        capabilities.clipboard.copy &&
        isClipboardShortcut(event, "KeyC")
      ) {
        event.preventDefault();
        copyShortcutRef.current = true;
        if (!event.repeat) void onCopy().catch(() => {});
        return;
      }
    }
    if (canPaste && event.code === "KeyV") {
      if (pasteShortcutRef.current) {
        // An auto-repeat still belongs to the shortcut. A new press means its keyup was lost.
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        pasteShortcutRef.current = null;
      }
      if (isClipboardShortcut(event, "KeyV")) {
        // Keep the default action, so that the browser fires `paste` with its clipboard text.
        if (!event.repeat) pasteShortcutRef.current = "pending";
        return;
      }
    }
    const input = keyboardInputFrom(event, "down");
    if (!sendKey(input)) return;
    event.preventDefault();
    pressedKeysRef.current.set(event.code || event.key, input);
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLElement>) => {
    const keyId = event.code || event.key;
    if (swallowedKeysRef.current.delete(keyId) && !pressedKeysRef.current.has(keyId)) {
      event.preventDefault();
      return;
    }
    if (event.code === "KeyC" && copyShortcutRef.current && !pressedKeysRef.current.has(keyId)) {
      event.preventDefault();
      copyShortcutRef.current = false;
      return;
    }
    if (canPaste && event.code === "KeyV" && !pressedKeysRef.current.has(keyId)) {
      event.preventDefault();
      // No paste event came before the keyup, so the device pastes its own clipboard.
      if (pasteShortcutRef.current === "pending") paste();
      pasteShortcutRef.current = null;
      return;
    }
    const wasPressed = pressedKeysRef.current.delete(keyId);
    const handled = sendKey(keyboardInputFrom(event, "up"));
    if (wasPressed || handled) event.preventDefault();
  };

  const onPaste = (event: ReactClipboardEvent<HTMLElement>) => {
    if (!canPaste) return;
    const shortcut = pasteShortcutRef.current;
    if (shortcut === "handled") {
      event.preventDefault();
      return;
    }
    if (shortcut) pasteShortcutRef.current = "handled";
    // Reading the event's data needs no clipboard permission.
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text && !shortcut) return;
    event.preventDefault();
    paste(text || undefined);
  };

  return { onKeyDown, onKeyUp, onPaste, releasePressedKeys, resetShortcuts };
}
