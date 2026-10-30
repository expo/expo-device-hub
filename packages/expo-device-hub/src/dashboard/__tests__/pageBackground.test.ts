import { expect, test } from "bun:test";
import { bg } from "@expo/hub-components";

import { pageBackground } from "../pageBackground";

test("leaves the page alone outside a phone layout", () => {
  expect(pageBackground({ mobile: false, sidebarOverlay: false })).toBeNull();
  expect(pageBackground({ mobile: false, sidebarOverlay: true })).toBeNull();
});

test("paints the page the stream panel's color on a phone", () => {
  expect(pageBackground({ mobile: true, sidebarOverlay: false })).toBe(bg.subtle);
});

test("paints the page the sidebar's color while the sidebar covers the screen", () => {
  expect(pageBackground({ mobile: true, sidebarOverlay: true })).toBe(bg.default);
});
