import { textToKeyEventsLenient, type KeyEvent } from "../../text-to-keys";
import { hidUsageForCode } from "./hid";

const BACKSPACE = hidUsageForCode("Backspace")!;
const ENTER = hidUsageForCode("Enter")!;

function press(usage: number): KeyEvent[] {
  return [{ type: "down", usage }, { type: "up", usage }];
}

export function keyEventsForInputType(
  inputType: string,
  data: string | null,
): KeyEvent[] {
  switch (inputType) {
    case "insertText":
    case "insertFromPaste":
      return data != null && data !== ""
        ? textToKeyEventsLenient(data).events
        : [];
    case "insertLineBreak":
    case "insertParagraph":
      return press(ENTER);
    case "deleteContentBackward":
    case "deleteWordBackward":
      return press(BACKSPACE);
    default:
      return [];
  }
}

export function keyEventsForBeforeInput(inputType: string): KeyEvent[] {
  switch (inputType) {
    case "insertLineBreak":
    case "insertParagraph":
      // Enter fires `beforeinput` but changes no value, so the value diff misses
      // it. Backspace is left to the keydown path so it is never sent twice.
      return keyEventsForInputType(inputType, null);
    default:
      return [];
  }
}

export function keyEventsForTextChange(
  previous: string,
  next: string,
): KeyEvent[] {
  const prev = Array.from(previous);
  const cur = Array.from(next);
  let common = 0;
  const max = Math.min(prev.length, cur.length);
  while (common < max && prev[common] === cur[common]) common++;
  const removed = prev.slice(common).join("");
  const added = cur.slice(common).join("");
  const removedKeystrokes = prev.length - common - textToKeyEventsLenient(removed).skipped.length;
  const events: KeyEvent[] = [];
  for (let i = 0; i < removedKeystrokes; i++) events.push(...press(BACKSPACE));
  events.push(...textToKeyEventsLenient(added).events);
  return events;
}

export function keydownForward(
  code: string,
  state: { simFocused: boolean; keyboardOpen: boolean; captureInputEmpty: boolean },
): number | null {
  if (state.keyboardOpen) {
    // The hidden input owns text entry, so only carry a Backspace on an empty
    // input: it fires no `input` for the value diff (e.g. a fresh reopen) and is
    // otherwise dropped when the sim isn't focused. The rest stays with the
    // input path so it is never sent twice.
    return code === "Backspace" && state.captureInputEmpty
      ? hidUsageForCode(code)
      : null;
  }
  if (!state.simFocused) return null;
  return hidUsageForCode(code);
}

export const KEYBOARD_CAPTURE_ATTRIBUTES = {
  autoCapitalize: "none",
  autoCorrect: "on",
  autoComplete: "off",
  spellCheck: true,
} as const;
