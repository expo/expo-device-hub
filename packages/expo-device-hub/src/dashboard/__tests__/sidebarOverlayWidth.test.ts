import { expect, test } from "bun:test";

import { sidebarOverlayWidth } from "../sidebarOverlayWidth";

test("fills the visible viewport on a phone", () => {
  expect(sidebarOverlayWidth({ mobile: true, sidebarWidth: 320, viewportWidth: 390 })).toBe(390);
  expect(sidebarOverlayWidth({ mobile: true, sidebarWidth: 320, viewportWidth: 280 })).toBe(280);
});

test("keeps the chosen width elsewhere", () => {
  expect(sidebarOverlayWidth({ mobile: false, sidebarWidth: 320, viewportWidth: 700 })).toBe(320);
  expect(sidebarOverlayWidth({ mobile: false, sidebarWidth: 480, viewportWidth: 700 })).toBe(480);
});
