import { expect, test } from "bun:test";
import { KeyboardPasteGate } from "../client/utils/keyboard-paste-gate";

test("browser text paste cancels simulator fallback before V keyup", () => {
  const gate = new KeyboardPasteGate();
  gate.start();
  expect(gate.paste("café 🎉")).toBe("text");
  expect(gate.release(false)).toBe("ignore");
});

test("empty browser paste sends one simulator fallback", () => {
  const gate = new KeyboardPasteGate();
  gate.start();
  expect(gate.paste("")).toBe("fallback");
  expect(gate.release(false)).toBe("ignore");
});

test("absent paste event falls back on V keyup after the modifier keyup", () => {
  const gate = new KeyboardPasteGate();
  gate.start();
  expect(gate.onVKeyDown(true)).toBe(true);
  expect(gate.release(false)).toBe("fallback");
  expect(gate.isWaiting).toBe(false);
});

test("a fresh V after a lost shortcut keyup starts ordinary typing", () => {
  const gate = new KeyboardPasteGate();
  gate.start();
  expect(gate.onVKeyDown(false)).toBe(false);
  expect(gate.release(true)).toBe("ignore");
});

test("blur cancels an interrupted shortcut before the next plain V", () => {
  const gate = new KeyboardPasteGate();
  gate.start();
  gate.cancel();
  expect(gate.release(true)).toBe("ignore");
});

test("a forwarded V is released instead of becoming a paste", () => {
  const gate = new KeyboardPasteGate();
  gate.start();
  expect(gate.release(true)).toBe("release");
});
