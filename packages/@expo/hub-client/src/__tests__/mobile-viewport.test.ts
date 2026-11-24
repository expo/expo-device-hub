import { expect, test } from "bun:test";
import { readMobileViewport } from "../useMobileViewport";

test("phone keyboard fitting follows visible height and viewport panning", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const visual = { width: 375, height: 667, offsetTop: 0, offsetLeft: 0, scale: 1 };
  const browser = {
    innerWidth: 375,
    innerHeight: 667,
    visualViewport: visual,
    matchMedia: () => ({ matches: true }),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  try {
    expect(readMobileViewport().mobile).toBe(true);
    visual.scale = 2;
    visual.height = 667 / 2;
    expect(readMobileViewport().keyboardRaised).toBe(false);
    visual.height = 200;
    expect(readMobileViewport().keyboardRaised).toBe(true);
    visual.scale = 1;
    visual.height = 330;
    visual.offsetTop = 42;
    expect(readMobileViewport()).toMatchObject({
      mobile: true,
      height: 330,
      top: 42,
      keyboardRaised: true,
    });
    browser.innerWidth = 844;
    browser.innerHeight = 390;
    expect(readMobileViewport().mobile).toBe(true);
    browser.innerWidth = 810;
    browser.innerHeight = 1080;
    expect(readMobileViewport().mobile).toBe(false);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
