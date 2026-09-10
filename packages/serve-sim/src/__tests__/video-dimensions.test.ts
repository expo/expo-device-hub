import { describe, expect, test } from "bun:test";
import type { StreamConfig } from "../client/types";
import { streamDisplayGeometry } from "../client/simulator/orientation";
import { resolveScreenConfigUpdate } from "../client/simulator/screen-config-state";
import { observeVideoDimensions } from "../client/simulator/video-dimensions";

class FakeVideo extends EventTarget {
  videoWidth = 0;
  videoHeight = 0;

  setDimensions(width: number, height: number, event: "loadedmetadata" | "resize") {
    this.videoWidth = width;
    this.videoHeight = height;
    this.dispatchEvent(new Event(event));
  }
}

describe("video dimension observer", () => {
  test("tracks portrait to landscape to portrait WebRTC resolution changes", () => {
    const video = new FakeVideo();
    let config: StreamConfig | null = null;
    const reported: Array<{ width: number; height: number }> = [];
    const applyConfig = (
      next: StreamConfig,
      source: "external" | "reported",
    ) => {
      const update = resolveScreenConfigUpdate(config, next, source);
      if (update) config = update.config;
    };
    const observer = observeVideoDimensions(video, (dimensions) => {
      reported.push(dimensions);
      applyConfig(dimensions, "reported");
    });

    applyConfig({ width: 1179, height: 2556, orientation: "portrait" }, "external");
    video.setDimensions(1179, 2556, "loadedmetadata");
    expect(streamDisplayGeometry(config).rotationDegrees).toBe(0);

    // The requested orientation can arrive before the sender switches resolution.
    applyConfig({ width: 1179, height: 2556, orientation: "landscape_left" }, "external");
    expect(streamDisplayGeometry(config).rotationDegrees).toBe(90);

    video.setDimensions(2556, 1179, "resize");
    expect(streamDisplayGeometry(config).rotationDegrees).toBe(0);

    applyConfig({ width: 2556, height: 1179, orientation: "portrait" }, "external");
    video.setDimensions(1179, 2556, "resize");
    expect(streamDisplayGeometry(config).rotationDegrees).toBe(0);

    expect(reported).toEqual([
      { width: 1179, height: 2556 },
      { width: 2556, height: 1179 },
      { width: 1179, height: 2556 },
    ]);

    observer.check();
    observer.disconnect();
    video.setDimensions(2556, 1179, "resize");
    expect(reported).toHaveLength(3);
  });
});
