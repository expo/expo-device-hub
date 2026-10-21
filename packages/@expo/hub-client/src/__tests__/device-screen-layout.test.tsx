import { describe, expect, test } from "bun:test";
import { DEVICE_SCREEN_SURFACE_LAYOUT_STYLE, deviceScreenMediaStyle } from "../DeviceScreen";

describe("DeviceScreen layout", () => {
  for (const rotation of [-90, 90]) {
    test(`keeps ${rotation}-degree media synchronized with its responsive surface`, () => {
      const mediaStyle = deviceScreenMediaStyle(rotation);

      expect(DEVICE_SCREEN_SURFACE_LAYOUT_STYLE.containerType).toBe("size");
      expect(mediaStyle.width).toBe("100cqh");
      expect(mediaStyle.height).toBe("100cqw");
      expect(mediaStyle.width).not.toMatch(/px$/);
      expect(mediaStyle.height).not.toMatch(/px$/);
    });
  }

  test("draws no background, so the consumer's surface shows until the first frame", () => {
    expect(DEVICE_SCREEN_SURFACE_LAYOUT_STYLE.position).toBe("absolute");
    expect(DEVICE_SCREEN_SURFACE_LAYOUT_STYLE.inset).toBe(0);
    expect(DEVICE_SCREEN_SURFACE_LAYOUT_STYLE.backgroundColor).toBeUndefined();
  });

  test("hides the media until the screen session presents a frame, but keeps it laid out", () => {
    // A previous session's frame can still be in the element.
    const waiting = deviceScreenMediaStyle(0, false);
    expect(waiting.opacity).toBe(0);
    expect(waiting.display).toBe("block");
    expect(waiting.visibility).toBeUndefined();
    // After the first frame, a reconnect keeps the last frame visible.
    expect(deviceScreenMediaStyle(0, true).opacity).toBeUndefined();
  });
});
