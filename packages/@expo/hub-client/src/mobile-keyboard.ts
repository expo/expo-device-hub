/**
 * Phone (soft) keyboard → HID key events, ported from serve-sim's
 * `utils/mobile-keyboard.ts` (serve-sim #131).
 *
 * A touch browser has no physical key events worth forwarding: the soft
 * keyboard reports text through `beforeinput` / `input` on a focused element.
 * {@link KeyboardCapture} owns a hidden `<input>`; these helpers turn its value
 * changes and editing intents into the same `0x06` key presses a physical
 * keyboard would produce, so autocorrect, suggestions, and paste all type into
 * the simulator.
 */

import { hidUsageForCode } from './keyboard';
import { textToKeyEventsLenient } from './text-to-keys';
import { type HidKeyEvent } from './types';

const BACKSPACE = hidUsageForCode('Backspace')!;
const ENTER = hidUsageForCode('Enter')!;

function press(usage: number): HidKeyEvent[] {
  return [
    { type: 'down', usage },
    { type: 'up', usage },
  ];
}

/** Key events for an `InputEvent.inputType` + its `data`. */
export function keyEventsForInputType(inputType: string, data: string | null): HidKeyEvent[] {
  switch (inputType) {
    case 'insertText':
    case 'insertFromPaste':
      return data != null && data !== '' ? textToKeyEventsLenient(data).events : [];
    case 'insertLineBreak':
    case 'insertParagraph':
      return press(ENTER);
    case 'deleteContentBackward':
    case 'deleteWordBackward':
      return press(BACKSPACE);
    default:
      return [];
  }
}

/** Key events to send from `beforeinput`, before the value changes. */
export function keyEventsForBeforeInput(inputType: string): HidKeyEvent[] {
  switch (inputType) {
    case 'insertLineBreak':
    case 'insertParagraph':
      // Enter fires `beforeinput` but changes no value, so the value diff misses
      // it. Backspace is left to the keydown path so it is never sent twice.
      return keyEventsForInputType(inputType, null);
    default:
      return [];
  }
}

/**
 * Key events that turn `previous` into `next`: backspace the replaced tail,
 * then type the new characters. Characters that were never keystrokes (emoji)
 * are not backspaced, since the simulator never received them.
 */
export function keyEventsForTextChange(previous: string, next: string): HidKeyEvent[] {
  const prev = Array.from(previous);
  const cur = Array.from(next);
  let common = 0;
  const max = Math.min(prev.length, cur.length);
  while (common < max && prev[common] === cur[common]) common++;
  const removed = prev.slice(common).join('');
  const added = cur.slice(common).join('');
  const removedKeystrokes = prev.length - common - textToKeyEventsLenient(removed).skipped.length;
  const events: HidKeyEvent[] = [];
  for (let i = 0; i < removedKeystrokes; i++) events.push(...press(BACKSPACE));
  events.push(...textToKeyEventsLenient(added).events);
  return events;
}

/**
 * Whether a physical `keydown` should be forwarded as a HID usage while the
 * phone keyboard capture may be open. Returns the usage, or null to drop it.
 */
export function keydownForward(
  code: string,
  state: { simFocused: boolean; keyboardOpen: boolean; captureInputEmpty: boolean },
): number | null {
  if (state.keyboardOpen) {
    // The hidden input owns text entry, so only carry a Backspace on an empty
    // input: it fires no `input` for the value diff (e.g. a fresh reopen) and is
    // otherwise dropped when the sim isn't focused. The rest stays with the
    // input path so it is never sent twice.
    return code === 'Backspace' && state.captureInputEmpty ? hidUsageForCode(code) : null;
  }
  if (!state.simFocused) return null;
  return hidUsageForCode(code);
}

/** Attributes for the hidden capture input: keep autocorrect, drop autocapitalize. */
export const KEYBOARD_CAPTURE_ATTRIBUTES = {
  autoCapitalize: 'none',
  autoCorrect: 'on',
  autoComplete: 'off',
  spellCheck: true,
} as const;
