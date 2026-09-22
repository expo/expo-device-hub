import { type CSSProperties, type RefObject, useEffect, useRef } from 'react';

import {
  KEYBOARD_CAPTURE_ATTRIBUTES,
  keyEventsForBeforeInput,
  keyEventsForTextChange,
} from './mobile-keyboard';
import { type HidKeyEvent } from './types';
import { readNativeKeyboardRaised } from './viewport-keyboard';

export interface KeyboardCaptureProps {
  /** Focus the hidden input (raising the phone keyboard) while true; blur when false. */
  open: boolean;
  /**
   * Receives the HID key events for what the user typed. Hand them to
   * `DeviceClient.sendKeyEvents`, which paces them onto the simulator.
   */
  onKeys: (events: HidKeyEvent[]) => void;
  /** Optional ref to the hidden input, for callers that check focus themselves. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

const HIDDEN_INPUT_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: 1,
  height: 1,
  opacity: 0,
  border: 'none',
  padding: 0,
  margin: 0,
  background: 'transparent',
};

/**
 * Hidden `<input>` that lets a touch client type into the simulator with its
 * phone keyboard. Ported from serve-sim's `components/keyboard-capture.tsx`
 * (serve-sim #131). The soft keyboard reports text through `beforeinput` /
 * `input`; each value change is diffed against what was already sent and
 * forwarded as key presses, so autocorrect and paste work too. While `open`,
 * a focus loss that was not a keyboard dismissal re-focuses the input.
 */
export function KeyboardCapture({ open, onKeys, inputRef }: KeyboardCaptureProps) {
  const ownRef = useRef<HTMLInputElement | null>(null);
  const ref = inputRef ?? ownRef;
  const onKeysRef = useRef(onKeys);
  onKeysRef.current = onKeys;
  const openRef = useRef(open);
  openRef.current = open;
  const sentRef = useRef('');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      el.value = '';
      sentRef.current = '';
      el.focus();
    } else {
      el.blur();
    }
  }, [open, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const emit = (events: HidKeyEvent[]) => {
      if (events.length) onKeysRef.current(events);
    };
    const onBeforeInput = (event: Event) => {
      const e = event as InputEvent;
      emit(keyEventsForBeforeInput(e.inputType));
      if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
        e.preventDefault();
      }
    };
    const onInput = () => {
      emit(keyEventsForTextChange(sentRef.current, el.value));
      sentRef.current = el.value;
    };
    const onFocusOut = () => {
      if (!openRef.current) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!openRef.current || document.activeElement === el) return;
          if (readNativeKeyboardRaised()) el.focus();
        });
      });
    };
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('input', onInput);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('input', onInput);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, [ref]);

  return (
    <input
      ref={ref}
      style={HIDDEN_INPUT_STYLE}
      aria-hidden
      tabIndex={-1}
      defaultValue=""
      {...KEYBOARD_CAPTURE_ATTRIBUTES}
    />
  );
}
