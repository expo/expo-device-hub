import { describe, expect, it } from "bun:test";

import { encoderLabel } from "../client/components/stream-stats-labels";

describe("encoderLabel", () => {
  it("names the guest's paravirtualized hardware encoder", () => {
    expect(encoderLabel({
      id: "paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc",
      hardware: true,
      codec: "H264",
    })).toBe("paravirt avc (hardware)");
  });

  it("names the codec when the session is not on H.264", () => {
    expect(encoderLabel({ id: null, hardware: false, codec: "VP8" })).toBe("vp8 (CPU)");
    expect(encoderLabel({ id: null, hardware: false, codec: "VP9" })).toBe("vp9 (CPU)");
  });

  it("marks a real software H.264 encoder as CPU", () => {
    expect(encoderLabel({
      id: "com.apple.videotoolbox.videoencoder.h264",
      hardware: false,
      codec: "H264",
    })).toBe("h264 (CPU)");
  });

  it("falls back to the kind alone when there is neither id nor codec", () => {
    expect(encoderLabel({ id: null, hardware: true, codec: null })).toBe("hardware");
    expect(encoderLabel({ id: null, hardware: null, codec: null })).toBe("?");
    expect(encoderLabel({ id: "", hardware: false, codec: null })).toBe("CPU");
  });
});
