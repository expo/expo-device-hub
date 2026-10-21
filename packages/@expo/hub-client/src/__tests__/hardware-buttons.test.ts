import { expect, test } from "bun:test";

import { androidButtonMessage } from "../useAndroidDevice";
import { iosButtonMessage } from "../useIosDevice";

test("iOS presses keep their named buttons", () => {
  expect(iosButtonMessage("home")).toEqual({ button: "home" });
  expect(iosButtonMessage("appSwitcher")).toEqual({ button: "app_switcher" });
  expect(iosButtonMessage("power")).toEqual({ button: "lock" });
});

test("iOS sends side and frame buttons with their DeviceKit HID codes and phase", () => {
  expect(iosButtonMessage("volumeUp")).toEqual({
    button: "volume-up",
    page: 12,
    usage: 233,
    phase: "press",
  });
  expect(iosButtonMessage("volumeDown", "down")).toEqual({
    button: "volume-down",
    page: 12,
    usage: 234,
    phase: "down",
  });
  // A held power button uses its HID code, so a long press reaches the guest.
  expect(iosButtonMessage("power", "down")).toEqual({
    button: "power",
    page: 12,
    usage: 48,
    phase: "down",
  });
  expect(iosButtonMessage("power", "up")).toMatchObject({ page: 12, usage: 48, phase: "up" });
  expect(iosButtonMessage("action", "up")).toMatchObject({ button: "action", page: 11, usage: 45 });
  expect(iosButtonMessage("ringer")).toMatchObject({ button: "mute", page: 11, usage: 46 });
});

test("a button without a HID code presses on release and ignores the down phase", () => {
  expect(iosButtonMessage("home", "down")).toBeNull();
  expect(iosButtonMessage("home", "up")).toEqual({ button: "home" });
  expect(androidButtonMessage("home", "down")).toBeNull();
  expect(androidButtonMessage("home", "up")).toEqual({ type: "home" });
});

test("Android sends volume and held power as key events, and keeps a power press", () => {
  expect(androidButtonMessage("power")).toEqual({ type: "power" });
  expect(androidButtonMessage("power", "down")).toEqual({
    type: "key",
    keycode: 26,
    action: "down",
  });
  expect(androidButtonMessage("power", "up")).toEqual({ type: "key", keycode: 26, action: "up" });
  expect(androidButtonMessage("volumeUp")).toEqual({ type: "key", keycode: 24 });
  expect(androidButtonMessage("volumeDown", "down")).toEqual({
    type: "key",
    keycode: 25,
    action: "down",
  });
});

test("each platform ignores the buttons it lacks", () => {
  for (const phase of ["press", "down", "up"] as const) {
    expect(androidButtonMessage("action", phase)).toBeNull();
    expect(androidButtonMessage("ringer", phase)).toBeNull();
    expect(iosButtonMessage("back", phase)).toBeNull();
    expect(iosButtonMessage("recents", phase)).toBeNull();
  }
});
