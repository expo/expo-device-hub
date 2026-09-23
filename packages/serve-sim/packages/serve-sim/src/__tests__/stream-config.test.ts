import { describe, expect, test } from "bun:test";
import {
  mjpegStreamUrlFrom,
  streamConfigFrom,
  webrtcCloseUrlFrom,
  webrtcOfferUrlFrom,
  webrtcSessionStatsUrl,
  webrtcStatsUrlFrom,
} from "../client/utils/sim-endpoint";
import { inProcessServeSimState } from "../state";

// The middleware injects a minimal `{basePath, execToken}` __SIM_PREVIEW__
// when no helper is attached (the empty state needs the exec token before a
// device exists). The client must not treat that as a stream config: doing so
// mounts SimulatorView with url=undefined, which fetches /undefined/stream.avcc
// and — when the api/events correction never arrives — trips the 6s "Stream is
// not producing frames" watchdog on a page that should show the device picker.

const fullConfig = {
  url: "http://127.0.0.1:3100",
  streamUrl: "http://127.0.0.1:3100/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:3100/ws",
  pid: 123,
  port: 3100,
  device: "ABCD-1234",
  basePath: "",
  execToken: "tok",
};

describe("streamConfigFrom", () => {
  test("accepts a full helper state", () => {
    expect(streamConfigFrom(fullConfig)).toBe(fullConfig);
  });

  test("rejects the minimal empty-state injection", () => {
    expect(
      streamConfigFrom({ basePath: "", execToken: "tok" } as never),
    ).toBeNull();
  });

  test("rejects null and undefined", () => {
    expect(streamConfigFrom(null)).toBeNull();
    expect(streamConfigFrom(undefined)).toBeNull();
  });

  test("rejects a config missing the stream url", () => {
    expect(
      streamConfigFrom({ ...fullConfig, url: undefined } as never),
    ).toBeNull();
  });
});

describe("mjpegStreamUrlFrom", () => {
  test("keeps local MJPEG helper URLs on the MJPEG endpoint", () => {
    expect(mjpegStreamUrlFrom(fullConfig)).toBe(
      "http://127.0.0.1:3100/stream.mjpeg",
    );
  });

  test("uses the helper base URL for tunneled AVCC configs", () => {
    expect(
      mjpegStreamUrlFrom({
        ...fullConfig,
        url: "https://sim-abcd.expo-simulator.ngrok.dev/",
        streamUrl: "https://sim-abcd.expo-simulator.ngrok.dev/stream.avcc",
        wsUrl: "wss://sim-abcd.expo-simulator.ngrok.dev/ws",
        streamSettings: { transport: "http", codec: "h264" },
      }),
    ).toBe("https://sim-abcd.expo-simulator.ngrok.dev/stream.mjpeg");
  });

  test("preserves in-process helper paths for embedded preview fallback", () => {
    const config = {
      ...fullConfig,
      ...inProcessServeSimState("DEVICE-A", 3200, "/preview", "127.0.0.1", {
        transport: "webrtc",
        codec: "h264",
      }),
    } as NonNullable<Window["__SIM_PREVIEW__"]>;

    expect(mjpegStreamUrlFrom(config)).toBe(
      "http://127.0.0.1:3200/preview/helper/DEVICE-A/stream.mjpeg",
    );
  });
});

describe("webrtcOfferUrlFrom", () => {
  test("uses the helper base URL for direct helper configs", () => {
    expect(webrtcOfferUrlFrom(fullConfig)).toBe(
      "http://127.0.0.1:3100/webrtc/offer",
    );
  });

  test("preserves in-process helper paths for embedded preview signaling", () => {
    const config = {
      ...fullConfig,
      ...inProcessServeSimState("DEVICE-A", 3200, "/preview", "127.0.0.1", {
        transport: "webrtc",
        codec: "h264",
      }),
    } as NonNullable<Window["__SIM_PREVIEW__"]>;

    expect(webrtcOfferUrlFrom(config)).toBe(
      "http://127.0.0.1:3200/preview/helper/DEVICE-A/webrtc/offer",
    );
  });

  test("maps same-origin proxy stream URLs to same-origin signaling", () => {
    expect(
      webrtcOfferUrlFrom({
        ...fullConfig,
        url: "https://example.test/.sim/helper/DEVICE-A",
        streamUrl: "https://example.test/.sim/helper/DEVICE-A/stream.avcc",
        wsUrl: "wss://example.test/.sim/helper/DEVICE-A/ws",
        streamSettings: { transport: "webrtc", codec: "h264" },
      }),
    ).toBe("https://example.test/.sim/helper/DEVICE-A/webrtc/offer");
  });
});

describe("webrtcCloseUrlFrom", () => {
  test("preserves the in-process helper path", () => {
    const config = {
      ...fullConfig,
      ...inProcessServeSimState("DEVICE-A", 3200, "/preview", "127.0.0.1", {
        transport: "webrtc",
        codec: "h264",
      }),
    } as NonNullable<Window["__SIM_PREVIEW__"]>;

    expect(webrtcCloseUrlFrom(config)).toBe(
      "http://127.0.0.1:3200/preview/helper/DEVICE-A/webrtc/close",
    );
  });
});

describe("webrtcSessionStatsUrl", () => {
  test("scopes the panel poll to this viewer's session", () => {
    expect(
      webrtcSessionStatsUrl(webrtcStatsUrlFrom(fullConfig), "07a5f32b-273e-4a30-8f62-8e741a815af1"),
    ).toBe("http://127.0.0.1:3100/webrtc/stats?sessionId=07a5f32b-273e-4a30-8f62-8e741a815af1");
  });
});
