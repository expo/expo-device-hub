import { describe, expect, test } from 'bun:test';

import { androidMessageForKeyboardInput, hidUsageForCode, iosMessageForKeyboardInput } from '../keyboard.js';
import { type KeyboardInput } from '../types.js';

const input = (key: string, code = key, phase: KeyboardInput['phase'] = 'down'): KeyboardInput => ({
  key,
  code,
  phase,
  repeat: false,
});

describe('serve-sim physical keyboard mapping', () => {
  test('maps printable, editing, navigation, and modifier codes to USB HID usages', () => {
    expect(hidUsageForCode('KeyA')).toBe(0x04);
    expect(hidUsageForCode('Digit0')).toBe(0x27);
    expect(hidUsageForCode('Enter')).toBe(0x28);
    expect(hidUsageForCode('Backspace')).toBe(0x2a);
    expect(hidUsageForCode('ArrowLeft')).toBe(0x50);
    expect(hidUsageForCode('ShiftLeft')).toBe(0xe1);
    expect(hidUsageForCode('MetaRight')).toBe(0xe7);
  });

  test('ignores browser keys that have no simulator HID equivalent', () => {
    expect(hidUsageForCode('AudioVolumeUp')).toBeNull();
    expect(hidUsageForCode('')).toBeNull();
  });
});

describe('serve-emu physical keyboard mapping', () => {
  test('sends layout-resolved printable text through scrcpy INJECT_TEXT', () => {
    expect(androidMessageForKeyboardInput(input('A', 'KeyA'))).toEqual({ type: 'text', text: 'A' });
    expect(androidMessageForKeyboardInput(input('é', 'KeyE'))).toEqual({ type: 'text', text: 'é' });
    expect(androidMessageForKeyboardInput(input(' ', 'Space'))).toEqual({
      type: 'text',
      text: ' ',
    });
  });

  test('maps Enter, editing, and navigation keys to Android keycodes', () => {
    expect(androidMessageForKeyboardInput(input('Enter'))).toEqual({ type: 'key', keycode: 66 });
    expect(androidMessageForKeyboardInput(input('Backspace'))).toEqual({
      type: 'key',
      keycode: 67,
    });
    expect(androidMessageForKeyboardInput(input('ArrowLeft'))).toEqual({
      type: 'key',
      keycode: 21,
    });
    expect(androidMessageForKeyboardInput(input('Delete'))).toEqual({ type: 'key', keycode: 112 });
  });

  test('uses Android Back for Escape and ignores keyup/non-input keys', () => {
    expect(androidMessageForKeyboardInput(input('Escape'))).toEqual({ type: 'back' });
    expect(androidMessageForKeyboardInput(input('a', 'KeyA', 'up'))).toBeNull();
    expect(androidMessageForKeyboardInput(input('Shift', 'ShiftLeft'))).toBeNull();
  });
});

test('iOS forwards shifted printable text while preserving shortcuts and keyup', () => {
  const shifted = {...input('A', 'KeyA'), shiftKey: true};
  expect(iosMessageForKeyboardInput(shifted)).toEqual({type: 'down', usage: 4, key: 'A', shifted: true});
  expect(iosMessageForKeyboardInput({...shifted, phase: 'up'})).toEqual({type: 'up', usage: 4});
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) expect(iosMessageForKeyboardInput({...shifted, [modifier]: true})).toEqual({type: 'down', usage: 4});
  expect(iosMessageForKeyboardInput({...input(' ', 'Space'), shiftKey: true})).toEqual({type: 'down', usage: 0x2c});
  expect(iosMessageForKeyboardInput({...input('!', 'Digit1'), shiftKey: true})).toEqual({type: 'down', usage: 0x1e, key: '!', shifted: true});
  expect(iosMessageForKeyboardInput(input('AudioVolumeUp'))).toBeNull();
});
