import { describe, expect, test } from "bun:test";
import {
  keydownForward,
  keyEventsForBeforeInput,
  keyEventsForInputType,
  keyEventsForTextChange,
} from "../client/utils/mobile-keyboard";
import { textToKeyEventsLenient } from "../text-to-keys";

describe("textToKeyEventsLenient", () => {
  test("skips characters the US map can't reach instead of dropping the string", () => {
    const { events, skipped } = textToKeyEventsLenient("hi🎉!");

    expect(skipped).toEqual(["🎉"]);
    // h, i and ! still made it, with ! shifted.
    expect(events.length).toBeGreaterThan(0);
    expect(textToKeyEventsLenient("hi!").events).toEqual(events);
  });
});

describe("keyEventsForInputType", () => {
  test("types inserted text", () => {
    const events = keyEventsForInputType("insertText", "a");

    expect(events).toEqual([
      { type: "down", usage: 0x04 },
      { type: "up", usage: 0x04 },
    ]);
  });

  test("maps the editing intents a soft keyboard reports", () => {
    const enter = keyEventsForInputType("insertLineBreak", null);
    const back = keyEventsForInputType("deleteContentBackward", null);

    expect(enter).toEqual([
      { type: "down", usage: 0x28 },
      { type: "up", usage: 0x28 },
    ]);
    expect(back).toEqual([
      { type: "down", usage: 0x2a },
      { type: "up", usage: 0x2a },
    ]);
  });

  test("ignores intents that carry no keystroke", () => {
    expect(keyEventsForInputType("historyUndo", null)).toEqual([]);
    expect(keyEventsForInputType("insertText", null)).toEqual([]);
  });
});

describe("keyEventsForTextChange", () => {
  const BACKSPACE = {
    down: { type: "down", usage: 0x2a },
    up: { type: "up", usage: 0x2a },
  } as const;

  test("forwards only the newly typed characters across updates", () => {
    let sent = "";
    const emitted = [];
    for (const next of ["h", "he", "hel"]) {
      emitted.push(...keyEventsForTextChange(sent, next));
      sent = next;
    }

    // Typing "h" -> "he" -> "hel" types "hel" once, not "hhhehel".
    expect(emitted).toEqual(textToKeyEventsLenient("hel").events);
  });

  test("backspaces the replaced tail when a suggestion swaps the word", () => {
    // "helo" gets replaced by the "hello" suggestion.
    const events = keyEventsForTextChange("helo", "hello");

    // Common prefix "hel"; delete the trailing "o", then type "lo".
    expect(events).toEqual([BACKSPACE.down, BACKSPACE.up, ...textToKeyEventsLenient("lo").events]);
  });

  test("replaces a whole mistyped word", () => {
    const events = keyEventsForTextChange("teh", "the");

    // Common prefix ""... actually "t"; delete "eh", type "he".
    expect(events).toEqual([
      BACKSPACE.down,
      BACKSPACE.up,
      BACKSPACE.down,
      BACKSPACE.up,
      ...textToKeyEventsLenient("he").events,
    ]);
  });

  test("skips an inserted emoji without keystrokes", () => {
    expect(keyEventsForTextChange("", "😀")).toEqual([]);
  });

  test("does not backspace for an emoji that was never sent", () => {
    // "a😀" -> "a": the emoji leaves the value but was never a keystroke.
    expect(keyEventsForTextChange("a😀", "a")).toEqual([]);
  });
});

describe("keyEventsForBeforeInput", () => {
  test("forwards Enter, which fires beforeinput but no input event", () => {
    expect(keyEventsForBeforeInput("insertLineBreak")).toEqual([
      { type: "down", usage: 0x28 },
      { type: "up", usage: 0x28 },
    ]);
    expect(keyEventsForBeforeInput("insertParagraph")).toEqual([
      { type: "down", usage: 0x28 },
      { type: "up", usage: 0x28 },
    ]);
  });

  test("leaves deletes and text to the keydown and input paths", () => {
    expect(keyEventsForBeforeInput("deleteContentBackward")).toEqual([]);
    expect(keyEventsForBeforeInput("deleteWordBackward")).toEqual([]);
    expect(keyEventsForBeforeInput("insertText")).toEqual([]);
  });
});

describe("keydownForward", () => {
  const BACKSPACE = 0x2a;
  const KEY_A = 0x04;

  test("forwards an empty-input Backspace while the phone keyboard is open, even when the sim is not focused", () => {
    // The reopen bug: after close/reopen the hidden input is empty, so no `input`
    // fires; the Backspace only rides the keydown path, which dropped it whenever
    // the last tap left the sim unfocused (what happened on EAS).
    expect(
      keydownForward("Backspace", {
        simFocused: false,
        keyboardOpen: true,
        captureInputEmpty: true,
      }),
    ).toBe(BACKSPACE);
  });

  test("does not forward a non-empty Backspace while the keyboard is open (the input path owns it)", () => {
    expect(
      keydownForward("Backspace", {
        simFocused: true,
        keyboardOpen: true,
        captureInputEmpty: false,
      }),
    ).toBeNull();
  });

  test("ignores text keys while the keyboard is open so they are not double-sent", () => {
    expect(
      keydownForward("KeyA", {
        simFocused: true,
        keyboardOpen: true,
        captureInputEmpty: true,
      }),
    ).toBeNull();
    expect(
      keydownForward("Enter", {
        simFocused: true,
        keyboardOpen: true,
        captureInputEmpty: true,
      }),
    ).toBeNull();
  });

  test("forwards keys for the desktop keyboard when the sim is focused and the phone keyboard is closed", () => {
    expect(
      keydownForward("KeyA", {
        simFocused: true,
        keyboardOpen: false,
        captureInputEmpty: true,
      }),
    ).toBe(KEY_A);
  });

  test("drops keys when the sim is not focused and the phone keyboard is closed", () => {
    expect(
      keydownForward("KeyA", {
        simFocused: false,
        keyboardOpen: false,
        captureInputEmpty: true,
      }),
    ).toBeNull();
  });
});
