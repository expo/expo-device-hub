import { describe, expect, test } from "bun:test";
import { installToastHoverGuard } from "../client/utils/toast-hover";

function pointer(type: string, pointerType: string): Event {
  return Object.assign(new Event(type), { pointerType });
}

function hoverIsBlocked(target: EventTarget, type: string): boolean {
  let blocked = false;
  const observe = (event: Event) => { blocked = event.cancelBubble; };
  target.addEventListener(type, observe);
  target.dispatchEvent(new Event(type));
  target.removeEventListener(type, observe);
  return blocked;
}

describe("toast hover", () => {
  test("touch compatibility mouse events cannot pause dismissal", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    target.dispatchEvent(pointer("pointerover", "touch"));
    target.dispatchEvent(pointer("pointerdown", "touch"));
    target.dispatchEvent(pointer("pointerup", "touch"));
    for (const event of ["mouseover", "mouseenter", "mousemove"]) {
      expect(hoverIsBlocked(target, event)).toBe(true);
    }
    cleanup();
  });

  test("mouse hover still works after touch on a hybrid device", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    expect(hoverIsBlocked(target, "mouseenter")).toBe(false);
    target.dispatchEvent(pointer("pointerdown", "touch"));
    expect(hoverIsBlocked(target, "mouseenter")).toBe(true);
    target.dispatchEvent(pointer("pointerover", "mouse"));
    for (const event of ["mouseover", "mouseenter", "mousemove", "mouseleave"]) {
      expect(hoverIsBlocked(target, event)).toBe(false);
    }
    cleanup();
  });

  test("touch actions and mouse leave still reach the toast", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    target.dispatchEvent(pointer("pointerdown", "touch"));
    for (const event of ["pointerup", "click", "mouseleave", "dragstart", "dragend"]) {
      expect(hoverIsBlocked(target, event)).toBe(false);
    }
    cleanup();
  });

  test("moving a mouse already inside the toast restores hover after touch", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    target.dispatchEvent(pointer("pointerdown", "touch"));
    target.dispatchEvent(pointer("pointermove", "mouse"));
    expect(hoverIsBlocked(target, "mousemove")).toBe(false);
    cleanup();
  });

  test("unmount removes the guard", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    target.dispatchEvent(pointer("pointerdown", "touch"));
    cleanup();
    expect(hoverIsBlocked(target, "mouseenter")).toBe(false);
  });
});
