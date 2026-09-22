import { describe, expect, test } from 'bun:test';

import {
  keydownForward,
  keyEventsForBeforeInput,
  keyEventsForInputType,
  keyEventsForTextChange,
} from '../mobile-keyboard.js';
import { textToKeyEventsLenient } from '../text-to-keys.js';

describe('textToKeyEventsLenient', () => {
  test("skips characters the US map can't reach instead of dropping the string", () => {
    const { events, skipped } = textToKeyEventsLenient('hi🎉!');

    expect(skipped).toEqual(['🎉']);
    // h, i and ! still made it, with ! shifted.
    expect(events.length).toBeGreaterThan(0);
    expect(textToKeyEventsLenient('hi!').events).toEqual(events);
  });

  test('wraps shifted characters in a left-shift press', () => {
    expect(textToKeyEventsLenient('A').events).toEqual([
      { type: 'down', usage: 0xe1 },
      { type: 'down', usage: 0x04 },
      { type: 'up', usage: 0x04 },
      { type: 'up', usage: 0xe1 },
    ]);
  });
});

describe('keyEventsForInputType', () => {
  test('types inserted text', () => {
    expect(keyEventsForInputType('insertText', 'a')).toEqual([
      { type: 'down', usage: 0x04 },
      { type: 'up', usage: 0x04 },
    ]);
  });

  test('maps the editing intents a soft keyboard reports', () => {
    expect(keyEventsForInputType('insertLineBreak', null)).toEqual([
      { type: 'down', usage: 0x28 },
      { type: 'up', usage: 0x28 },
    ]);
    expect(keyEventsForInputType('deleteContentBackward', null)).toEqual([
      { type: 'down', usage: 0x2a },
      { type: 'up', usage: 0x2a },
    ]);
  });

  test('ignores intents that carry no keystroke', () => {
    expect(keyEventsForInputType('historyUndo', null)).toEqual([]);
    expect(keyEventsForInputType('insertText', null)).toEqual([]);
  });
});

describe('keyEventsForTextChange', () => {
  const BACKSPACE = {
    down: { type: 'down', usage: 0x2a },
    up: { type: 'up', usage: 0x2a },
  } as const;

  test('forwards only the newly typed characters across updates', () => {
    let sent = '';
    const emitted = [];
    for (const next of ['h', 'he', 'hel']) {
      emitted.push(...keyEventsForTextChange(sent, next));
      sent = next;
    }
    // Typing "h" -> "he" -> "hel" types "hel" once, not "hhhehel".
    expect(emitted).toEqual(textToKeyEventsLenient('hel').events);
  });

  test('backspaces the replaced tail when a suggestion swaps the word', () => {
    // "helo" gets replaced by the "hello" suggestion: delete the trailing "o", then type "lo".
    expect(keyEventsForTextChange('helo', 'hello')).toEqual([
      BACKSPACE.down,
      BACKSPACE.up,
      ...textToKeyEventsLenient('lo').events,
    ]);
  });

  test('skips an inserted emoji without keystrokes', () => {
    expect(keyEventsForTextChange('', '😀')).toEqual([]);
  });

  test('does not backspace for an emoji that was never sent', () => {
    // "a😀" -> "a": the emoji leaves the value but was never a keystroke.
    expect(keyEventsForTextChange('a😀', 'a')).toEqual([]);
  });
});

describe('keyEventsForBeforeInput', () => {
  test('forwards Enter, which fires beforeinput but no input event', () => {
    expect(keyEventsForBeforeInput('insertLineBreak')).toEqual([
      { type: 'down', usage: 0x28 },
      { type: 'up', usage: 0x28 },
    ]);
    expect(keyEventsForBeforeInput('insertParagraph')).toEqual([
      { type: 'down', usage: 0x28 },
      { type: 'up', usage: 0x28 },
    ]);
  });

  test('leaves deletes and text to the keydown and input paths', () => {
    expect(keyEventsForBeforeInput('deleteContentBackward')).toEqual([]);
    expect(keyEventsForBeforeInput('insertText')).toEqual([]);
  });
});

describe('keydownForward', () => {
  test('forwards an empty-input Backspace while the phone keyboard is open, even unfocused', () => {
    // After close/reopen the hidden input is empty, so no `input` fires; the
    // Backspace only rides the keydown path.
    expect(
      keydownForward('Backspace', { simFocused: false, keyboardOpen: true, captureInputEmpty: true }),
    ).toBe(0x2a);
  });

  test('does not forward a non-empty Backspace while the keyboard is open (the input path owns it)', () => {
    expect(
      keydownForward('Backspace', { simFocused: true, keyboardOpen: true, captureInputEmpty: false }),
    ).toBeNull();
  });

  test('ignores text keys while the keyboard is open so they are not double-sent', () => {
    expect(
      keydownForward('KeyA', { simFocused: true, keyboardOpen: true, captureInputEmpty: true }),
    ).toBeNull();
  });

  test('forwards keys for the desktop keyboard when focused and the phone keyboard is closed', () => {
    expect(
      keydownForward('KeyA', { simFocused: true, keyboardOpen: false, captureInputEmpty: true }),
    ).toBe(0x04);
    expect(
      keydownForward('KeyA', { simFocused: false, keyboardOpen: false, captureInputEmpty: true }),
    ).toBeNull();
  });
});
