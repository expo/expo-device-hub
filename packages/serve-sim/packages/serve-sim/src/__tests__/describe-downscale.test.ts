import { describe, expect, it } from "bun:test";

import { describeDownscale } from "../client/components/stream-stats-labels";

/// A 2622px source unless a test says otherwise, so the pick is what binds.
const sender = (
  width: number,
  height: number,
  qualityLimitationReason: string | null,
  sourceLongEdge: number | null = 2622,
  levelMaxLongEdge: number | null = null,
) =>
  ({ width, height, qualityLimitationReason, sourceLongEdge, levelMaxLongEdge }) as Parameters<
    typeof describeDownscale
  >[1];

describe("describeDownscale", () => {
  it("names the size actually encoded and the size that was picked", () => {
    expect(describeDownscale(1600, sender(552, 1200, "bandwidth"))).toBe("1200 of 1600 (bitrate)");
  });

  it("blames the encoder when WebRTC says cpu", () => {
    expect(describeDownscale(1600, sender(552, 1200, "cpu"))).toBe("1200 of 1600 (encoder)");
  });

  /// A stream can be bitrate-limited with no packet loss, so the cause is never "network".
  it("does not name a cause WebRTC did not give", () => {
    expect(describeDownscale(1600, sender(552, 1200, "none"))).toBe("1200 of 1600");
    expect(describeDownscale(1600, sender(552, 1200, null))).toBe("1200 of 1600");
  });

  it("passes through an unknown reason rather than inventing one", () => {
    expect(describeDownscale(1600, sender(552, 1200, "other"))).toBe("1200 of 1600 (other)");
  });

  it("says nothing when the encode matches or exceeds the pick", () => {
    expect(describeDownscale(1600, sender(736, 1600, "none"))).toBeNull();
    expect(describeDownscale(1280, sender(1206, 2622, "none"))).toBeNull();
  });

  /// "Full" means the source is the pick, so a clamp below it is still a downscale.
  it("measures Full against the source rather than staying silent", () => {
    expect(describeDownscale(0, sender(552, 1200, "bandwidth"))).toBe("1200 of 2622 (bitrate)");
    expect(describeDownscale(0, sender(1206, 2622, "none"))).toBeNull();
  });

  /// The pick is a ceiling, not a target: a smaller screen is not a downscale.
  it("says nothing when the source is smaller than the pick", () => {
    expect(describeDownscale(1600, sender(750, 1334, "none", 1334))).toBeNull();
    expect(describeDownscale(1600, sender(750, 1334, "bandwidth", 1334))).toBeNull();
  });

  /// libwebrtc reports no limitation for a ceiling we applied ourselves, so whatever it does
  /// report would otherwise take the blame for the level's clamp.
  it("names the codec level ahead of whatever WebRTC happens to report", () => {
    expect(describeDownscale(1920, sender(651, 1416, "bandwidth", 2622, 1416)))
      .toBe("1416 of 1920 (codec level)");
    expect(describeDownscale(1920, sender(651, 1416, "none", 2622, 1416)))
      .toBe("1416 of 1920 (codec level)");
  });

  /// A VP8 session, or an H.264 one whose level already fits, reports no level bound at all,
  /// so nothing else that shrinks the picture can be read as a codec limit.
  it("never blames the level when no level bound was reported", () => {
    expect(describeDownscale(1920, sender(540, 960, "cpu", 2622, null)))
      .toBe("960 of 1920 (encoder)");
    expect(describeDownscale(1920, sender(540, 960, "bandwidth", 2622, 0)))
      .toBe("960 of 1920 (bitrate)");
    expect(describeDownscale(1920, sender(540, 960, "none", 2622, null)))
      .toBe("960 of 1920");
  });

  /// The clamp is applied as a ratio, so the encoder can land a step under the ceiling.
  it("still names the level when rounding lands just under the ceiling", () => {
    expect(describeDownscale(1920, sender(651, 1390, "bandwidth", 2622, 1392)))
      .toBe("1390 of 1920 (codec level)");
  });

  /// The level explains the drop to its ceiling and no further. Below it, something else did
  /// that, and blaming the level would hide a real encoder or bitrate problem.
  it("stops blaming the level once the encode falls below the ceiling", () => {
    expect(describeDownscale(1920, sender(540, 960, "cpu", 2622, 1416)))
      .toBe("960 of 1920 (encoder)");
    expect(describeDownscale(1920, sender(540, 960, "bandwidth", 2622, 1416)))
      .toBe("960 of 1920 (bitrate)");
    expect(describeDownscale(1920, sender(540, 960, "none", 2622, 1416)))
      .toBe("960 of 1920");
  });

  it("says nothing before the first frame reports a size", () => {
    expect(describeDownscale(1600, sender(0, 0, "bandwidth"))).toBeNull();
    expect(describeDownscale(1600, sender(0, 0, null, null))).toBeNull();
  });

  it("uses the long edge whichever way the device is held", () => {
    expect(describeDownscale(1600, sender(1200, 552, "bandwidth"))).toBe("1200 of 1600 (bitrate)");
  });
});
