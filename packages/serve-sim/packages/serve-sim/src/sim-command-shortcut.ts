import type { KeyEvent } from "./text-to-keys";

// USB HID Usage Page 0x07 keyboard usages.
export const KEY_C = 0x06;
export const KEY_V = 0x19;
const LEFT_COMMAND = 0xe3;
const RIGHT_COMMAND = 0xe7;
// Held with Command, these make the sim read another shortcut: Ctrl+V forwards Control, and
// Shift+Command+V is not paste. The shortcut lifts them and puts them back.
// Left and right Control, then Shift, then Option.
const LIFTED_MODIFIERS = [0xe0, 0xe4, 0xe1, 0xe5, 0xe2, 0xe6];

export function isLiftedModifier(usage: number): boolean {
  return LIFTED_MODIFIERS.includes(usage);
}

/** Command+V for Paste or Command+C for Copy. */
export function simCommandShortcutHidEvents(pressed: ReadonlySet<number>, key: typeof KEY_C | typeof KEY_V): KeyEvent[] {
  const lifted = LIFTED_MODIFIERS.filter((usage) => pressed.has(usage));
  const events: KeyEvent[] = lifted.map((usage) => ({ type: "up", usage }));
  const commandAlreadyDown = pressed.has(LEFT_COMMAND) || pressed.has(RIGHT_COMMAND);
  if (!commandAlreadyDown) events.push({ type: "down", usage: LEFT_COMMAND });
  events.push({ type: "down", usage: key });
  events.push({ type: "up", usage: key });
  if (!commandAlreadyDown) events.push({ type: "up", usage: LEFT_COMMAND });
  for (const usage of lifted) events.push({ type: "down", usage });
  return events;
}
