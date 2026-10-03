import { afterEach, expect, spyOn, test } from "bun:test";
import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DeviceClientProvider } from "../DeviceClientProvider";
import { AVCC_TAG_DESCRIPTION } from "../avcc";
import { streamGeometry } from "../orientation";
import type { DeviceOrientation } from "../types";
import { useDeviceClient } from "../useDeviceClient";
import { useDeviceScreenClient } from "../useDeviceScreenClient";
import { WS_TAG_SCREEN_CONFIG } from "../useIosDevice";
import { Peer, Video } from "./screen-test-media";
import { createGlobalStubs } from "./test-globals";

class ControlSocket {
  static instances: ControlSocket[] = [];
  readyState = 1;
  sent: ArrayBuffer[] = [];
  onmessage?: (event: { data: ArrayBuffer }) => void;

  constructor() {
    ControlSocket.instances.push(this);
  }
  send(data: ArrayBuffer) {
    this.sent.push(data);
  }
  close() {}
  screenConfig(width: number, height: number, orientation: DeviceOrientation = "portrait") {
    const json = new TextEncoder().encode(JSON.stringify({ width, height, orientation }));
    const data = new Uint8Array(json.length + 1);
    data[0] = WS_TAG_SCREEN_CONFIG;
    data.set(json, 1);
    this.onmessage?.({ data: data.buffer });
  }
}

class AvccDecoder {
  static instances: AvccDecoder[] = [];
  state: CodecState = "unconfigured";

  constructor(private readonly callbacks: VideoDecoderInit) {
    AvccDecoder.instances.push(this);
  }
  configure() {
    this.state = "configured";
  }
  close() {
    this.state = "closed";
  }
  frame(width: number, height: number) {
    this.callbacks.output({
      displayWidth: width,
      displayHeight: height,
      close() {},
    } as VideoFrame);
  }
}

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
let restoreClock: (() => void) | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreClock?.();
  restoreClock = undefined;
  restoreGlobals();
  Peer.instances = [];
  ControlSocket.instances = [];
  AvccDecoder.instances = [];
});

test("MJPEG retries preserve screen identity after switching helpers", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { href: "https://hub.test/", origin: "https://hub.test" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", ControlSocket);
  const retries: Array<() => void> = [];
  const originalSetTimeout = setTimeout;
  stubGlobal("setTimeout", (callback: () => void, delay: number) => {
    if (delay === 1500) {
      retries.push(callback);
      return 0;
    }
    return originalSetTimeout(callback, delay);
  });
  stubGlobal("fetch", async (url: string) => {
    if (new URL(url).pathname === "/ios/api") {
      const device = new URL(url).searchParams.get("device") ?? "DEVICE-A";
      return Response.json({
        url: `https://hub.test/ios/helper/${device}`,
        device,
        streamUrl: "https://hub.test/ios/helper/DEVICE-A/stream.mjpeg",
      });
    }
    return Response.json({}, { status: 404 });
  });
  class Image extends EventTarget {
    src = "";
    naturalWidth = 360;
    naturalHeight = 720;
    removeAttribute() {
      this.src = "";
    }
  }
  const image = new Image();
  let client!: ReturnType<typeof useDeviceScreenClient>;
  let renders = 0;
  function Screen() {
    client = useDeviceScreenClient();
    const { attachVideo } = client;
    renders++;
    useLayoutEffect(() => {
      attachVideo(image as unknown as HTMLImageElement);
      return () => attachVideo(null);
    }, [attachVideo]);
    return null;
  }
  const tree = (device: string) => (
    <DeviceClientProvider
      platform="ios"
      options={{ baseUrl: "https://hub.test/ios", device, streamMode: "mjpeg" }}
    >
      <Screen />
    </DeviceClientProvider>
  );
  await act(async () => {
    renderer = create(tree("DEVICE-A"));
  });
  await act(async () => {
    image.dispatchEvent(new Event("load"));
  });
  await act(async () => ControlSocket.instances[0]!.screenConfig(360, 720, "landscape_left"));
  expect(streamGeometry(client.screen).rotationDegrees).not.toBe(0);
  const source = new URL(image.src).pathname;
  await act(async () => renderer!.update(tree("DEVICE-B")));
  expect(ControlSocket.instances).toHaveLength(2);
  expect(new URL(image.src).pathname).toBe(source);
  expect(client.screen).toBeNull();
  await act(async () => {
    image.dispatchEvent(new Event("error"));
  });
  expect(retries).toHaveLength(1);
  await act(async () => {
    retries.shift()!();
    image.dispatchEvent(new Event("load"));
  });
  expect(client.screen).toEqual({ width: 360, height: 720 });
  expect(streamGeometry(client.screen).rotationDegrees).toBe(0);
  const screen = client.screen;
  const afterRetry = renders;
  await act(async () => {
    image.dispatchEvent(new Event("load"));
  });
  expect(client.screen).toBe(screen);
  expect(renders).toBe(afterRetry);
  await act(async () => ControlSocket.instances[1]!.screenConfig(360, 720, "landscape_right"));
  expect(client.screen?.orientation).toBe("landscape_right");
});

for (const useVideoFrameCallback of [true, false]) {
  test(`iOS ${useVideoFrameCallback ? "video frame" : "timeupdate"} callbacks preserve screen identity and clear stale orientation`, async () => {
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stubGlobal("window", {
      location: { href: "https://hub.test/", origin: "https://hub.test" },
      addEventListener() {},
      removeEventListener() {},
      setTimeout,
      clearTimeout,
    });
    stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
    stubGlobal("RTCPeerConnection", Peer);
    stubGlobal("RTCRtpReceiver", { getCapabilities: () => null });
    stubGlobal("WebSocket", ControlSocket);
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    restoreClock = () => clock.mockRestore();
    stubGlobal("fetch", async (url: string) => {
      if (new URL(url).pathname === "/ios/api") {
        const device = new URL(url).searchParams.get("device") ?? "DEVICE-A";
        return Response.json({ url: `https://hub.test/ios/helper/${device}`, device });
      }
      if (url.endsWith("/webrtc/offer")) return Response.json({ type: "answer", sdp: "answer" });
      return Response.json({}, { status: 404 });
    });
    const video = new Video(useVideoFrameCallback);
    let client!: ReturnType<typeof useDeviceScreenClient>;
    let renders = 0;
    let featureRenders = 0;
    let emptyControlRenders = 0;
    let fps = 0;
    function Fps() {
      ({ fps } = useDeviceClient());
      return null;
    }
    function Features() {
      const { capabilities, streamCapabilities } = useDeviceClient();
      featureRenders++;
      return (
        <span>
          {String(capabilities.activity)}:{String(streamCapabilities?.modeAvailability.webrtc)}
        </span>
      );
    }
    function EmptyControls() {
      const {
        setCameraImage,
        clearCameraImage,
        setStreamSource,
        setGrpcImageMode,
        setGrpcEncoder,
        setGrpcInputSource,
      } = useDeviceClient();
      emptyControlRenders++;
      return (
        <button
          onClick={() => {
            setCameraImage("front", new Blob());
            clearCameraImage("front");
            setStreamSource("scrcpy");
            setGrpcImageMode("png");
            setGrpcEncoder("software");
            setGrpcInputSource("scrcpy");
          }}
        >
          Camera
        </button>
      );
    }
    function Screen() {
      client = useDeviceScreenClient();
      const { attachVideo } = client;
      renders++;
      useLayoutEffect(() => {
        attachVideo(video as unknown as HTMLVideoElement);
        return () => attachVideo(null);
      }, [attachVideo]);
      return null;
    }
    await act(async () => {
      renderer = create(
        <DeviceClientProvider
          platform="ios"
          options={{ baseUrl: "https://hub.test/ios", device: "DEVICE-A", streamMode: "webrtc" }}
        >
          <Screen />
          <Fps />
          <Features />
          <EmptyControls />
        </DeviceClientProvider>,
      );
    });
    expect(Peer.instances).toHaveLength(1);
    const stream = { id: "video" };
    await act(async () => Peer.instances[0]!.ontrack?.({ streams: [stream], track: {} }));
    expect(video.srcObject).toBe(stream);
    await act(async () => video.frame());
    expect(client.status).toBe("streaming");
    expect(client.screen).toEqual({ width: 360, height: 720 });
    const firstScreen = client.screen;
    const initialRenders = renders;
    const initialFeatureRenders = featureRenders;
    const initialEmptyControlRenders = emptyControlRenders;
    for (let i = 0; i < 120; i++) {
      now += 1000 / 60;
      await act(async () => video.frame());
    }
    expect(client.screen).toBe(firstScreen);
    expect(renders).toBe(initialRenders);
    expect(fps).toBeGreaterThan(0);
    expect(featureRenders).toBe(initialFeatureRenders);
    expect(emptyControlRenders).toBe(initialEmptyControlRenders);

    video.videoWidth = 720;
    video.videoHeight = 360;
    await act(async () => video.frame());
    expect(client.screen).toEqual({ width: 720, height: 360 });
    expect(renders).toBe(initialRenders + 1);

    await act(async () => ControlSocket.instances[0]!.screenConfig(1170, 2532));
    expect(client.screen).toEqual({ width: 1170, height: 2532, orientation: "portrait" });
    const configuredScreen = client.screen;
    const configuredRenders = renders;
    await act(async () => video.frame());
    expect(client.screen).toBe(configuredScreen);
    expect(renders).toBe(configuredRenders);

    // The first frame from a new helper must discard the old helper's orientation.
    await act(async () => ControlSocket.instances[0]!.screenConfig(360, 720, "landscape_left"));
    video.videoWidth = 360;
    video.videoHeight = 720;
    await act(async () => {
      renderer!.update(
        <DeviceClientProvider
          platform="ios"
          options={{ baseUrl: "https://hub.test/ios", device: "DEVICE-B", streamMode: "webrtc" }}
        >
          <Screen />
          <Fps />
        </DeviceClientProvider>,
      );
    });
    expect(Peer.instances).toHaveLength(2);
    expect(ControlSocket.instances).toHaveLength(2);
    await act(async () =>
      Peer.instances[1]!.ontrack?.({ streams: [{ id: "new-video" }], track: {} }),
    );
    await act(async () => video.frame());
    expect(client.screen).toEqual({ width: 360, height: 720 });
    expect(streamGeometry(client.screen).rotationDegrees).toBe(0);
    client.sendTouch({ phase: "begin", x: 0.2, y: 0.3 });
    const sent = new Uint8Array(ControlSocket.instances[1]!.sent.at(-1)!);
    expect(JSON.parse(new TextDecoder().decode(sent.subarray(1)))).toEqual({
      type: "begin",
      x: 0.2,
      y: 0.3,
    });
    const switchedScreen = client.screen;
    const switchedRenders = renders;
    await act(async () => video.frame());
    expect(client.screen).toBe(switchedScreen);
    expect(renders).toBe(switchedRenders);

    await act(async () => ControlSocket.instances[1]!.screenConfig(360, 720, "landscape_right"));
    const newConfiguredScreen = client.screen;
    expect(newConfiguredScreen).toEqual({
      width: 360,
      height: 720,
      orientation: "landscape_right",
    });
    await act(async () => video.frame());
    expect(client.screen).toBe(newConfiguredScreen);
  });
}

test("iOS AVCC resize callbacks preserve screen identity and clear stale orientation", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { href: "https://hub.test/", origin: "https://hub.test" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("VideoDecoder", AvccDecoder);
  stubGlobal("WebSocket", ControlSocket);
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === "/ios/api") {
      const device = new URL(url).searchParams.get("device") ?? "DEVICE-A";
      return Response.json({ url: `https://hub.test/ios/helper/${device}`, device });
    }
    if (url.endsWith("/stream.avcc")) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new Uint8Array([0, 0, 0, 6, AVCC_TAG_DESCRIPTION, 1, 0x64, 0, 0x28, 0xff]),
            );
            init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
          },
        }),
      );
    }
    return Response.json({}, { status: 404 });
  });
  const makeCanvas = () => ({ width: 300, height: 150, getContext: () => ({ drawImage() {} }) });
  const canvas = makeCanvas();
  let client!: ReturnType<typeof useDeviceScreenClient>;
  let renders = 0;
  function Screen() {
    client = useDeviceScreenClient();
    const { attachVideo } = client;
    renders++;
    useLayoutEffect(() => {
      attachVideo(canvas as unknown as HTMLCanvasElement);
      return () => attachVideo(null);
    }, [attachVideo]);
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientProvider
        platform="ios"
        options={{ baseUrl: "https://hub.test/ios", device: "DEVICE-A", streamMode: "h264" }}
      >
        <Screen />
      </DeviceClientProvider>,
    );
  });
  expect(AvccDecoder.instances).toHaveLength(1);
  const decoder = AvccDecoder.instances[0]!;
  expect(decoder.state).toBe("configured");
  expect(client.videoKind).toBe("canvas");
  await act(async () => decoder.frame(360, 720));
  expect(client.status).toBe("streaming");
  expect(client.screen).toEqual({ width: 360, height: 720 });
  const firstScreen = client.screen;
  const initialRenders = renders;

  // A fresh canvas repeats onResize even when the stream dimensions haven't changed.
  for (let i = 0; i < 3; i++) {
    const replacement = makeCanvas();
    await act(async () => {
      client.attachVideo(replacement as unknown as HTMLCanvasElement);
      decoder.frame(360, 720);
    });
    expect(replacement.width).toBe(360);
    expect(replacement.height).toBe(720);
    expect(client.screen).toBe(firstScreen);
    expect(renders).toBe(initialRenders);
  }

  await act(async () => decoder.frame(720, 360));
  expect(client.screen).toEqual({ width: 720, height: 360 });
  expect(renders).toBe(initialRenders + 1);

  await act(async () => ControlSocket.instances[0]!.screenConfig(1170, 2532));
  expect(client.screen).toEqual({ width: 1170, height: 2532, orientation: "portrait" });
  const configuredScreen = client.screen;
  const configuredRenders = renders;
  await act(async () => decoder.frame(360, 720));
  expect(client.screen).toBe(configuredScreen);
  expect(renders).toBe(configuredRenders);

  await act(async () => ControlSocket.instances[0]!.screenConfig(360, 720, "landscape_left"));
  await act(async () => {
    renderer!.update(
      <DeviceClientProvider
        platform="ios"
        options={{ baseUrl: "https://hub.test/ios", device: "DEVICE-B", streamMode: "h264" }}
      >
        <Screen />
      </DeviceClientProvider>,
    );
  });
  expect(AvccDecoder.instances).toHaveLength(2);
  expect(ControlSocket.instances).toHaveLength(2);
  const newDecoder = AvccDecoder.instances[1]!;
  // A fresh canvas makes the new helper's same-size frame call onResize.
  await act(async () => {
    client.attachVideo(makeCanvas() as unknown as HTMLCanvasElement);
    newDecoder.frame(360, 720);
  });
  expect(client.screen).toEqual({ width: 360, height: 720 });
  expect(streamGeometry(client.screen).rotationDegrees).toBe(0);
  client.sendTouch({ phase: "begin", x: 0.2, y: 0.3 });
  const sent = new Uint8Array(ControlSocket.instances[1]!.sent.at(-1)!);
  expect(JSON.parse(new TextDecoder().decode(sent.subarray(1)))).toEqual({
    type: "begin",
    x: 0.2,
    y: 0.3,
  });
  const switchedScreen = client.screen;
  const switchedRenders = renders;
  await act(async () => {
    client.attachVideo(makeCanvas() as unknown as HTMLCanvasElement);
    newDecoder.frame(360, 720);
  });
  expect(client.screen).toBe(switchedScreen);
  expect(renders).toBe(switchedRenders);

  await act(async () => ControlSocket.instances[1]!.screenConfig(360, 720, "landscape_right"));
  const newConfiguredScreen = client.screen;
  expect(newConfiguredScreen).toEqual({ width: 360, height: 720, orientation: "landscape_right" });
  await act(async () => {
    client.attachVideo(makeCanvas() as unknown as HTMLCanvasElement);
    newDecoder.frame(360, 720);
  });
  expect(client.screen).toBe(newConfiguredScreen);
});
