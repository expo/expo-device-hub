import { describe, expect, test } from 'bun:test';

import { androidMessageForKeyboardInput, hidUsageForCode } from '../keyboard';
import { type KeyboardInput } from '../types';

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
