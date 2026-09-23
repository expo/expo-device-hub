import { describe, expect, it } from "bun:test";

import { codecDrifted, describeDownscale } from "../client/components/stream-stats-labels";

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

  it("measures Full against the source rather than staying silent", () => {
    expect(describeDownscale(0, sender(552, 1200, "bandwidth"))).toBe("1200 of 2622 (bitrate)");
    expect(describeDownscale(0, sender(1206, 2622, "none"))).toBeNull();
  });

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

  it("never blames the level when no level bound was reported", () => {
    expect(describeDownscale(1920, sender(540, 960, "cpu", 2622, null)))
      .toBe("960 of 1920 (encoder)");
    expect(describeDownscale(1920, sender(540, 960, "bandwidth", 2622, 0)))
      .toBe("960 of 1920 (bitrate)");
    expect(describeDownscale(1920, sender(540, 960, "none", 2622, null)))
      .toBe("960 of 1920");
  });

  it("still names the level when rounding lands just under the ceiling", () => {
    expect(describeDownscale(1920, sender(651, 1390, "bandwidth", 2622, 1392)))
      .toBe("1390 of 1920 (codec level)");
  });

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

/// The bug this exists for: a fallback leaves the stream on VP9 while the picker still reads
/// H.264, so re-picking H.264 does nothing and the session is stuck until the user detours
/// through another codec.
describe("codecDrifted", () => {
  it("spots a stream that fell off the codec that was picked", () => {
    expect(codecDrifted("h264", "VP9")).toBe(true);
    expect(codecDrifted("h264", "VP8")).toBe(true);
    expect(codecDrifted("vp8", "H264")).toBe(true);
  });

  it("compares the two spellings of the same codec as equal", () => {
    expect(codecDrifted("h264", "H264")).toBe(false);
    expect(codecDrifted("vp9", "VP9")).toBe(false);
    expect(codecDrifted("vp8", "vp8")).toBe(false);
  });

  it("says nothing before a codec is known", () => {
    expect(codecDrifted("h264", null)).toBe(false);
    expect(codecDrifted("h264", undefined)).toBe(false);
    expect(codecDrifted("h264", "")).toBe(false);
  });
});
