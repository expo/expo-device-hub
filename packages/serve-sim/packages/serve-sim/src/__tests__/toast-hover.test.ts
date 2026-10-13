import { describe, expect, test } from "bun:test";
import { installToastHoverGuard } from "../client/utils/toast-hover";

function pointer(type: string, pointerType: string, buttons = 0): Event {
  return Object.assign(new Event(type), { pointerType, buttons });
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

  test("pen contact blocks compatibility hover after release", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    target.dispatchEvent(pointer("pointerover", "pen", 1));
    expect(hoverIsBlocked(target, "mouseenter")).toBe(true);
    target.dispatchEvent(pointer("pointerdown", "pen", 1));
    target.dispatchEvent(pointer("pointermove", "pen", 1));
    target.dispatchEvent(pointer("pointerup", "pen"));
    for (const event of ["mouseover", "mouseenter", "mousemove"]) {
      expect(hoverIsBlocked(target, event)).toBe(true);
    }
    for (const event of ["click", "mouseleave", "dragstart", "dragend"]) {
      expect(hoverIsBlocked(target, event)).toBe(false);
    }
    cleanup();
  });

  test("pen hover still works before and after contact", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    target.dispatchEvent(pointer("pointerover", "pen"));
    expect(hoverIsBlocked(target, "mouseenter")).toBe(false);
    target.dispatchEvent(pointer("pointerdown", "pen", 1));
    expect(hoverIsBlocked(target, "mouseenter")).toBe(true);
    target.dispatchEvent(pointer("pointerup", "pen"));
    target.dispatchEvent(pointer("pointermove", "pen"));
    expect(hoverIsBlocked(target, "mousemove")).toBe(false);
    cleanup();
  });

  test("touch and pen transitions allow leave without a new hover destination", () => {
    for (const pointerType of ["touch", "pen"]) {
      const target = new EventTarget();
      const cleanup = installToastHoverGuard(target);
      target.dispatchEvent(pointer("pointerdown", pointerType, 1));
      target.dispatchEvent(pointer("pointerout", pointerType));
      const destination = new EventTarget();
      const event = new Event("mouseout");
      Object.defineProperty(event, "relatedTarget", { configurable: true, get: () => destination });
      Object.defineProperty(event, "toElement", { configurable: true, get: () => destination });
      let left = false;
      target.addEventListener("mouseout", (event) => { left = !event.cancelBubble; });
      target.dispatchEvent(event);
      expect(left).toBe(true);
      expect((event as MouseEvent).relatedTarget).toBeNull();
      expect((event as Event & { toElement: EventTarget | null }).toElement).toBeNull();
      cleanup();
    }
  });

  test("mouse transitions and transitions after cleanup keep their destination", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    const destination = new EventTarget();
    const event = () => Object.assign(new Event("mouseout"), { relatedTarget: destination });
    const mouse = event();
    target.dispatchEvent(mouse);
    expect(mouse.relatedTarget).toBe(destination);
    target.dispatchEvent(pointer("pointerdown", "touch"));
    target.dispatchEvent(pointer("pointerout", "mouse"));
    const resumedMouse = event();
    target.dispatchEvent(resumedMouse);
    expect(resumedMouse.relatedTarget).toBe(destination);
    target.dispatchEvent(pointer("pointerdown", "touch"));
    cleanup();
    const unmounted = event();
    target.dispatchEvent(unmounted);
    expect(unmounted.relatedTarget).toBe(destination);
  });

  test("unmount removes the guard", () => {
    const target = new EventTarget();
    const cleanup = installToastHoverGuard(target);
    target.dispatchEvent(pointer("pointerdown", "touch"));
    cleanup();
    expect(hoverIsBlocked(target, "mouseenter")).toBe(false);
  });
});
