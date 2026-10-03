import { afterEach, expect, spyOn, test } from "bun:test";
import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DeviceClientProvider } from "../DeviceClientProvider";
import type { DeviceActivity, DeviceClient } from "../types";
import { useDeviceClient } from "../useDeviceClient";
import { useDeviceScreenClient } from "../useDeviceScreenClient";
import { Peer, Video } from "./screen-test-media";
import { createGlobalStubs } from "./test-globals";

class ControlSocket {
  static instances: ControlSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;

  constructor() {
    ControlSocket.instances.push(this);
  }
  send() {}
  close() {}
}

class MetricsSource extends EventTarget {
  static instances: MetricsSource[] = [];

  constructor() {
    super();
    MetricsSource.instances.push(this);
  }
  close() {}
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
  MetricsSource.instances = [];
});

test("Android metrics and FPS leave screens and controls quiet while handlers use the current rotation", async () => {
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
  stubGlobal("EventSource", MetricsSource);
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  const rotations: { device: string | null; orientation: string }[] = [];
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const requestUrl = new URL(url);
    const path = requestUrl.pathname;
    if (path === "/android/api") {
      return Response.json({
        size: { width: 360, height: 720 },
        stream: { transport: "webrtc", codec: "h264", iceServers: [], iceTransportPolicy: "all" },
      });
    }
    if (path === "/android/webrtc/offer") {
      return Response.json({ type: "answer", sdp: "answer" });
    }
    if (path === "/android/api/orientation" && init?.method === "POST") {
      rotations.push({
        device: requestUrl.searchParams.get("device"),
        orientation: JSON.parse(init.body as string).orientation,
      });
      return Response.json({});
    }
    return Response.json({}, { status: 404 });
  });
  const video = new Video(true);
  let client!: ReturnType<typeof useDeviceScreenClient>;
  let screenRenders = 0;
  let controlRenders = 0;
  let featureRenders = 0;
  let emptyControlRenders = 0;
  let features!: Pick<DeviceClient, "capabilities" | "streamCapabilities">;
  let onRotate!: () => void;
  let activity: DeviceActivity | null = null;
  let fps = 0;
  function Metrics() {
    ({ activity } = useDeviceClient());
    return null;
  }
  function Fps() {
    ({ fps } = useDeviceClient());
    return null;
  }
  function Controls() {
    const client = useDeviceClient();
    onRotate = () => client.rotate();
    controlRenders++;
    return <button onClick={onRotate}>Rotate</button>;
  }
  function Features() {
    const { capabilities, streamCapabilities } = useDeviceClient();
    features = { capabilities, streamCapabilities };
    featureRenders++;
    return <span>{String(capabilities.activity)}</span>;
  }
  function EmptyControls() {
    const { setWebRtcCodec, setHardwareKeyboardConnected, toggleSoftwareKeyboard } =
      useDeviceClient();
    emptyControlRenders++;
    return (
      <button
        onClick={() => {
          setWebRtcCodec("h264");
          setHardwareKeyboardConnected(true);
          toggleSoftwareKeyboard();
        }}
      >
        Keyboard
      </button>
    );
  }
  function Screen() {
    client = useDeviceScreenClient();
    const { attachVideo } = client;
    screenRenders++;
    useLayoutEffect(() => {
      attachVideo(video as unknown as HTMLVideoElement);
      return () => attachVideo(null);
    }, [attachVideo]);
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientProvider
        platform="android"
        options={{
          baseUrl: "https://hub.test/android",
          device: "emulator-5554",
          streamMode: "webrtc",
        }}
      >
        <Screen />
        <Metrics />
        <Fps />
        <Controls />
        <Features />
        <EmptyControls />
      </DeviceClientProvider>,
    );
  });
  expect(Peer.instances).toHaveLength(1);
  expect(ControlSocket.instances).toHaveLength(1);
  expect(MetricsSource.instances).toHaveLength(1);
  const socket = ControlSocket.instances[0]!;
  const stream = { id: "android-video" };
  await act(async () => {
    socket.onopen?.();
    Peer.instances[0]!.ontrack?.({ streams: [stream], track: {} });
  });
  expect(video.srcObject).toBe(stream);
  await act(async () => video.frame());
  expect(client.videoKind).toBe("video");
  expect(client.status).toBe("streaming");
  expect(client.screen).toEqual({ width: 360, height: 720 });
  const firstScreen = client.screen;
  const initialRenders = screenRenders;
  const initialControlRenders = controlRenders;
  const initialFeatureRenders = featureRenders;
  const initialEmptyControlRenders = emptyControlRenders;
  expect(features.capabilities.activity).toBe(true);
  expect(features.streamCapabilities?.modeAvailability.webrtc).toBe(true);

  for (let i = 1; i <= 2; i++) {
    await act(async () => {
      MetricsSource.instances[0]!.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            t: i,
            bundleId: "test.app",
            cpuPct: i,
            memBytes: 0,
            netInBytesPerSec: 0,
            netOutBytesPerSec: 0,
          }),
        }),
      );
    });
    expect(activity!.samples.at(-1)?.cpuPct).toBe(i);
    expect(screenRenders).toBe(initialRenders);
    expect(controlRenders).toBe(initialControlRenders);
    expect(featureRenders).toBe(initialFeatureRenders);
    expect(emptyControlRenders).toBe(initialEmptyControlRenders);

    now += 1000;
    await act(async () => video.frame());
    expect(fps).toBeGreaterThan(0);
    expect(client.screen).toBe(firstScreen);
    expect(screenRenders).toBe(initialRenders);
    expect(controlRenders).toBe(initialControlRenders);
    expect(featureRenders).toBe(initialFeatureRenders);
    expect(emptyControlRenders).toBe(initialEmptyControlRenders);
  }

  video.videoWidth = 720;
  video.videoHeight = 360;
  await act(async () => video.frame());
  expect(client.screen).toEqual({ width: 720, height: 360 });
  expect(screenRenders).toBe(initialRenders + 1);
  expect(controlRenders).toBe(initialControlRenders);
  await act(async () => onRotate());
  expect(rotations).toEqual([{ device: "emulator-5554", orientation: "portrait" }]);

  await act(async () =>
    socket.onmessage?.({ data: JSON.stringify({ ok: false, error: "Input failed" }) }),
  );
  expect(client.error).toBe("Input failed");
  expect(screenRenders).toBe(initialRenders + 2);
});
