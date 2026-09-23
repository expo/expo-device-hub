import { describe, expect, test } from "bun:test";
import { maxDimensionOptions } from "../client/utils/stream-max-dimension-options";
import type { WebRtcStreamCodec } from "../stream-settings";

const webrtc = (maxDimension: number, webRtcCodec: WebRtcStreamCodec, configured = 0) =>
  maxDimensionOptions({ transport: "webrtc", webRtcCodec, maxDimension }, configured)
    .map((option) => option.value);

describe("max size options", () => {
  test("offers every size, including Full, when nothing constrains the session", () => {
    expect(webrtc(0, "vp8")).toEqual(["0", "1920", "1600", "1280", "960", "720"]);
  });

  test("never offers Full under H.264", () => {
    // Full means native, which is where H.264 stalls without recovering.
    expect(webrtc(960, "h264")).not.toContain("0");
  });

  test("caps H.264 at the codec ceiling when the session configured no size", () => {
    expect(webrtc(1280, "h264")).toEqual(["1280", "960", "720"]);
  });

  test("caps every codec at the size the session was configured with", () => {
    expect(webrtc(960, "h264", 960)).toEqual(["960", "720"]);
    expect(webrtc(960, "vp8", 960)).toEqual(["960", "720"]);
  });

  test("lowering the size does not hide the sizes above it", () => {
    expect(webrtc(720, "h264", 960)).toEqual(["960", "720"]);
    expect(webrtc(720, "h264")).toEqual(["1280", "960", "720"]);
  });

  test("does not apply the H.264 ceiling to a non-WebRTC transport", () => {
    // webRtcCodec keeps its default under HTTP, where it means nothing.
    const options = maxDimensionOptions(
      { transport: "http", webRtcCodec: "h264", maxDimension: 0 },
      0,
    );
    expect(options.map((option) => option.value)).toContain("1920");
  });

  test("keeps the current value selectable so the picker never misreports the state", () => {
    expect(webrtc(0, "h264")).toContain("0");
    expect(webrtc(1600, "h264")).toContain("1600");
    expect(webrtc(800, "h264", 960)).toContain("800");
  });
});
