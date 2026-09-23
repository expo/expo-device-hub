import { describe, expect, test } from "bun:test";
import { readSenderStats } from "../webrtc-sender-stats";

describe("encoder identity in sender stats", () => {
  test("reports the selected encoder so a software downgrade is visible", () => {
    const stats = readSenderStats({
      sessions: [],
      encoder: {
        id: "paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc",
        hardware: true,
      },
    });
    expect(stats.encoder?.id).toBe(
      "paravirtualized:com.apple.videotoolbox.videoencoder.ave.avc",
    );
    expect(stats.encoder?.hardware).toBe(true);
  });

  test("marks a software encoder as such", () => {
    const stats = readSenderStats({
      sessions: [],
      encoder: { id: "com.apple.videotoolbox.videoencoder.h264", hardware: false },
    });
    expect(stats.encoder?.hardware).toBe(false);
  });

  test("tolerates a build that does not report an encoder", () => {
    expect(readSenderStats({ sessions: [] }).encoder).toBeNull();
  });
});
